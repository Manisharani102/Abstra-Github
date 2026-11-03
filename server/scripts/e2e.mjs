// End-to-end test of the built server against an in-memory Postgres (PGlite over TCP) and a mock
// GitHub API. Exercises the unhappy paths: forged and replayed webhooks, GitHub 500s, retries,
// idempotent side effects, auth/CSRF, secret handling. Run with: npm run test:e2e
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const WEBHOOK_SECRET = 'test-webhook-secret-1234567890';
const SESSION_SECRET = 'x'.repeat(40);
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Postgres ----------
const pglite = await PGlite.create();
const pgServer = new PGLiteSocketServer({ db: pglite, port: 5433, host: '127.0.0.1' });
await pgServer.start();

// ---------- Mock GitHub ----------
const calls = [];
let labelFailuresLeft = 3; // first 3 label calls (one in-call retry burst) fail with 500
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'POST' && /\/app\/installations\/\d+\/access_tokens/.test(req.url))
      return json(201, { token: 'ghs_' + 'a'.repeat(36), expires_at: new Date(Date.now() + 3600e3).toISOString() });
    if (req.method === 'POST' && req.url.endsWith('/labels')) {
      if (labelFailuresLeft-- > 0) return json(500, { message: 'boom' });
      return json(200, []);
    }
    if (req.method === 'GET' && req.url.includes('/comments')) return json(200, []);
    if (req.method === 'POST' && req.url.endsWith('/comments')) return json(201, { id: 99, html_url: 'https://x/c/99' });
    if (req.url.startsWith('/installation/repositories')) return json(200, { repositories: [] });
    if (req.url.startsWith('/app/hook/deliveries')) return json(200, []);
    json(404, { message: 'not mocked' });
  });
});
await new Promise((r) => mock.listen(4010, r));

// ---------- Server ----------
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(PORT),
  APP_URL: BASE,
  DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5433/postgres',
  SESSION_SECRET,
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  GITHUB_APP_ID: '123',
  GITHUB_APP_SLUG: 'test-app',
  GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'csecret',
  GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
  GITHUB_API_URL: 'http://127.0.0.1:4010',
  GROQ_API_KEY: '',
};
const server = spawn(process.execPath, ['dist/main.js'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
const logs = [];
server.stdout.on('data', (d) => logs.push(d.toString()));
server.stderr.on('data', (d) => logs.push(d.toString()));

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

try {
  check('server boots, runs migrations, health ok', await waitHealthy());

  const db = { query: (sql, params) => pglite.query(sql, params), end: async () => {} };

  // ---------- Seed ----------
  const { rows: [user] } = await db.query(`INSERT INTO users (github_id, login) VALUES (1, 'octo') RETURNING id`);
  await db.query(`INSERT INTO installations (id, account_login, account_type) VALUES (42, 'octo', 'User')`);
  await db.query(`INSERT INTO user_installations VALUES ($1, 42)`, [user.id]);
  await db.query(`INSERT INTO repositories (id, installation_id, full_name) VALUES (7, 42, 'octo/demo')`);
  await db.query(`INSERT INTO connections (user_id, repo_id) VALUES ($1, 7)`, [user.id]);
  const cookie = `session=${jwt.sign({ login: 'octo' }, SESSION_SECRET, { subject: user.id, expiresIn: 3600 })}`;

  // Create a rule through the API (validates input path).
  let r = await fetch(`${BASE}/api/rules`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({
      name: 'bugs',
      event: 'issues',
      conditions: { keywords: ['bug'] },
      actions: { addLabels: ['bug'], comment: 'Thanks @{{author}}', slack: true },
    }),
  });
  check('create rule via API', r.status === 201, `status ${r.status}`);

  r = await fetch(`${BASE}/api/rules`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ name: 'x', event: 'issues', actions: {} }),
  });
  check('cross-origin POST blocked', r.status === 403, `status ${r.status}`);

  r = await fetch(`${BASE}/api/rules`, { headers: {} });
  check('API requires login', r.status === 401, `status ${r.status}`);

  r = await fetch(`${BASE}/api/rules`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ name: '', event: 'nope', actions: {} }),
  });
  check('invalid rule rejected', r.status === 400, `status ${r.status}`);

  // ---------- Webhooks ----------
  const payload = (title) => ({
    action: 'opened',
    installation: { id: 42 },
    repository: { id: 7, full_name: 'octo/demo' },
    sender: { login: 'alice', type: 'User' },
    issue: { number: 1, title, body: 'details', user: { login: 'alice' }, labels: [], html_url: 'https://github.com/octo/demo/issues/1' },
  });
  const send = (id, body, { secret = WEBHOOK_SECRET, event = 'issues' } = {}) => {
    const raw = JSON.stringify(body);
    return fetch(`${BASE}/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': id,
        'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
      },
      body: raw,
    });
  };

  r = await send(randomUUID(), payload('A bug'), { secret: 'wrong-secret-wrong-secret' });
  check('forged signature rejected', r.status === 401, `status ${r.status}`);

  const id = randomUUID();
  r = await send(id, payload('Login bug: crash'));
  check('valid webhook accepted (202)', r.status === 202, `status ${r.status}`);

  await sleep(2500); // PGlite's socket multiplexer can't take concurrent connections; let the worker go idle
  r = await send(id, payload('Login bug: crash'));
  const dup = await r.json();
  check('replayed delivery is a no-op', r.status === 202 && dup.duplicate === true, JSON.stringify(dup));

  await sleep(1500);
  let { rows: [d] } = await db.query(`SELECT status, attempts, last_error FROM deliveries WHERE id = $1`, [id]);
  check('label 500s -> delivery scheduled for retry', d.status === 'retrying', `${d.status}, attempt ${d.attempts}`);
  const commentsAfterFirst = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/comments')).length;
  check('comment posted once on first attempt', commentsAfterFirst === 1, `posted ${commentsAfterFirst}`);

  // Fast-forward the backoff.
  await db.query(`UPDATE deliveries SET next_attempt_at = now() WHERE id = $1`, [id]);
  await sleep(7000);
  ({ rows: [d] } = await db.query(`SELECT status, attempts FROM deliveries WHERE id = $1`, [id]));
  check('retry succeeds', d.status === 'done', `${d.status}, attempt ${d.attempts}`);
  const commentsTotal = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/comments')).length;
  check('comment NOT reposted on retry (idempotent)', commentsTotal === 1, `posted ${commentsTotal}`);
  const { rows: acts } = await db.query(`SELECT type, status, attempts FROM actions WHERE delivery_id = $1 ORDER BY type`, [id]);
  console.log('      actions:', JSON.stringify(acts));
  check(
    'action log: label succeeded after 2 attempts, slack skipped (not configured)',
    acts.some((a) => a.type === 'label' && a.status === 'succeeded' && a.attempts === 2) &&
      acts.some((a) => a.type === 'slack' && a.status === 'skipped'),
  );
  const labelCall = calls.find((c) => c.url.endsWith('/labels'));
  check('write-back used an installation token, not the app JWT', labelCall?.auth === 'Bearer ghs_' + 'a'.repeat(36));

  // Manual retry of a finished delivery must not redo anything.
  r = await fetch(`${BASE}/api/events/${id}/retry`, { method: 'POST', headers: { cookie, origin: BASE } });
  await sleep(3000);
  const labelCallsBefore = calls.filter((c) => c.url.endsWith('/labels')).length;
  ({ rows: [d] } = await db.query(`SELECT status FROM deliveries WHERE id = $1`, [id]));
  const commentsAfterManual = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/comments')).length;
  check('manual retry re-runs nothing that already succeeded', r.status === 202 && d.status === 'done' && commentsAfterManual === 1, `labels calls ${labelCallsBefore}`);

  // Non-matching issue: recorded, no actions.
  const id2 = randomUUID();
  await send(id2, payload('Feature request'));
  await sleep(3000);
  ({ rows: [d] } = await db.query(`SELECT status, last_error FROM deliveries WHERE id = $1`, [id2]));
  check('non-matching event recorded with no actions', d.status === 'done' && /No rules matched/.test(d.last_error ?? ''), d.last_error);

  // Second event type: pull_request on unconnected repo -> ignored.
  const id3 = randomUUID();
  await send(
    id3,
    { action: 'opened', installation: { id: 42 }, repository: { id: 8, full_name: 'octo/other' }, sender: { type: 'User' }, pull_request: { number: 2, title: 'x', user: { login: 'a' }, base: { ref: 'main' } } },
    { event: 'pull_request' },
  );
  await sleep(3000);
  ({ rows: [d] } = await db.query(`SELECT status, last_error FROM deliveries WHERE id = $1`, [id3]));
  check('pull_request on unconnected repo is ignored', d.status === 'ignored', d.last_error);

  // Dashboard API
  r = await fetch(`${BASE}/api/events?filter=all`, { headers: { cookie } });
  const events = await r.json();
  check('events API lists deliveries with actions', r.ok && events.length >= 3 && events.some((e) => e.actions.length >= 3), `${events.length} events`);
  r = await fetch(`${BASE}/api/events/stats`, { headers: { cookie } });
  console.log('      stats:', JSON.stringify(await r.json()));

  // Slack URL is encrypted at rest and never returned.
  r = await fetch(`${BASE}/api/settings/slack`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXXSECRET' }),
  });
  const { rows: [u] } = await db.query(`SELECT slack_webhook_enc FROM users WHERE id = $1`, [user.id]);
  check('slack URL stored encrypted', r.ok && u.slack_webhook_enc.startsWith('v1.') && !u.slack_webhook_enc.includes('XXXXSECRET'));
  r = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
  const me = await r.text();
  check('slack URL never returned to the browser', !me.includes('hooks.slack.com'), me);

  for (const p of ['/', '/rules']) { const h = await fetch(BASE + p); const t = await h.text(); check('SPA served at ' + p, h.ok && t.includes('id="root"'), h.headers.get('content-security-policy')?.slice(0, 60)); }
  r = await fetch(BASE + '/api/nope'); check('unknown API path is a JSON 404, not the SPA', r.status === 404);
  const allLogs = logs.join('');
  check('no secrets in logs', !allLogs.includes(WEBHOOK_SECRET) && !allLogs.includes('ghs_aaaa') && !allLogs.includes('XXXXSECRET') && !allLogs.includes('PRIVATE KEY'));

  await db.end();
} catch (err) {
  console.error(err);
  check('harness ran without exceptions', false);
} finally {
  server.kill();
  mock.close();
  await pgServer.stop();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) console.log('--- server log tail ---\n' + logs.join('').split('\n').slice(-40).join('\n'));
  process.exit(failed ? 1 : 0);
}
