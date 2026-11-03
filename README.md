# Repo Autopilot: event-driven GitHub automation bot

Sign in with GitHub, install the app on your repositories, and write rules like:

> **Issues whose title contains "bug"** → add the `bug` label, post a comment, run AI triage and alert Slack.

The bot receives GitHub webhooks (issues, pull requests, pushes), evaluates your rules, writes back to GitHub
(labels and comments), sends Slack notifications, and shows everything, including failures and retries, on a live
dashboard.

**Live app:** `https://<your-app>.onrender.com` ← _replace after deploying_
**Demo repository:** https://github.com/Manisharani102/abstrabit (issues and PRs there show the bot's
labels, comments and AI triage)

| Stack    | Choice                                                             |
| -------- | ------------------------------------------------------------------ |
| Frontend | React 19, TypeScript, Tailwind CSS v4, Vite, React Router          |
| Backend  | NestJS 11 (TypeScript), `pg`, `zod`                                |
| Database | Supabase Postgres (accessed directly over the session pooler)      |
| GitHub   | **GitHub App**: JWT signed with the app key → installation tokens  |
| AI       | Groq free tier (`openai/gpt-oss-20b`), optional                    |
| Hosting  | Render free web service (one service serves the API and the SPA)   |

---

## Features

**Core requirements**

- GitHub sign-in (the GitHub App's user OAuth flow) with an httpOnly signed session cookie
- Connect repositories: install the GitHub App on repos you own, then toggle which ones the bot acts on
- Webhook endpoint for `issues`, `pull_request` and `push` (plus `installation*` lifecycle events), all recorded
- Write-back to GitHub: add labels and post comments on issues/PRs, or comment on the head commit of a push
- Slack notifications via an Incoming Webhook (per user, encrypted at rest)
- Dashboard behind login: live event log (Server-Sent Events) with every action, status, attempt count and error

**Stretch goals**

1. **Configurable rules in the UI.** Match on title/commit keywords, body keywords, author, existing labels and branch, scoped to one repo or all of them.
2. **AI triage.** A one-sentence summary, a suggested label from a fixed allow-list, and a priority. Shown on the dashboard, in Slack and (optionally) in the comment; the suggested label can be applied automatically.
3. **GitHub App authentication.** An RS256 JWT is exchanged for per-installation tokens, which are cached until shortly before they expire.
4. **Multi-repository support.** Any number of installations and repos per user, with rules per repo or global.
5. **Observability.** Structured JSON logs with secret redaction; a "Failures & retries" view showing per-action attempts, errors, next retry time and a manual retry button; 7-day stats.

---

## How it handles the unhappy paths

```
GitHub ──POST /webhooks/github──▶ verify HMAC on raw body ──▶ INSERT deliveries (PK = X-GitHub-Delivery)
                                     │ 401 if bad                  │ ON CONFLICT DO NOTHING → duplicate, 202
                                     ▼                             ▼
                                  (rejected)                 202 Accepted (fast, < 100 ms)
                                                                   │
                         ┌─────────────── worker (poll + kick) ◀───┘
                         │  claim: UPDATE … FOR UPDATE SKIP LOCKED, lease 2 min
                         ▼
               match rules → AI triage (cached once) → for each action:
                  ActionRunner.runOnce(key = delivery:rule:user:type)
                    succeeded before? → skip   ·   failed? → run again
                         │
          all ok → done · retryable failure → retrying (backoff 30s…1h, 8 attempts → dead)
          permanent failure (e.g. 403) → failed (visible, manual retry)
```

| Quality bar                       | What the code does                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Forged requests**               | `X-Hub-Signature-256` HMAC-SHA256 over the **raw** body with `timingSafeEqual` ([signature.ts](server/src/webhooks/signature.ts)). OAuth uses a random `state` bound to an httpOnly cookie. Sessions are HS256 JWTs in `httpOnly`, `Secure`, `SameSite=Lax` cookies, and state-changing API calls from a foreign `Origin` are rejected. Dashboard access is authorized from GitHub's `/user/installations`, never from client input.                                                                                                 |
| **Replayed requests**             | GitHub does not sign a timestamp, so replay protection is the delivery GUID: the `deliveries` primary key means a replayed (validly signed) request is a no-op. A replay with a new GUID would need a new signature, which needs the secret.                                                                                                                                                                                                                             |
| **Duplicate deliveries**          | The same GUID dedupe applies. Inside processing, every side effect has an idempotency key in `actions` (unique), so retries and crash recovery skip anything that already succeeded. Comments carry a hidden hashed marker, so if the process dies after GitHub accepted a comment but before we recorded it, the retry finds the comment instead of posting it twice. Labels are idempotent on GitHub's side.                                                       |
| **Downstream briefly down**       | Ingestion never calls GitHub, Slack or the LLM. The worker retries transient failures (5xx, 429, rate-limit 403, network errors) with exponential backoff, while permanent errors (e.g. 404, invalid Slack URL) fail fast and are shown in the UI. AI is best-effort: if Groq is down, the labels, comment and Slack alert still go out.                                                                                                                                 |
| **Our service briefly down**      | If the DB insert fails we return 503, so GitHub records a failed delivery. A **reconciler** runs 15 s after boot and every 10 min: it lists the app's recent deliveries via the GitHub API and asks GitHub to redeliver any GUID that never got a 2xx and that we don't have. This matters on Render's free tier, which sleeps after 15 min idle: the wake-up takes longer than GitHub's 10 s timeout. Leases (`locked_until`) recover work from a worker that crashed mid-delivery. |
| **Secrets**                       | Nothing secret in the repo or client bundle (the browser only talks to our API). The Slack webhook URL is AES-256-GCM encrypted at rest and write-only from the UI. User OAuth tokens are used once at login and never stored. The logger redacts by key name and by value shape (GitHub tokens, Slack URLs, Groq keys, PEM blocks). Supabase tables have RLS enabled, so the public Data API can't read them.                                               |

All of the above is exercised by `npm run test:e2e` (see [Testing](#testing)).

### Which events run rules, and why some are "ignored"

Every webhook is stored, then the worker decides what to do with it:

| Webhook                                                    | What happens                                             |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| `issues` opened / reopened                                 | Issue rules run                                          |
| `pull_request` opened / reopened / ready_for_review        | Pull request rules run (a draft PR runs when it's marked ready) |
| `push` (not branch deletions)                              | Push rules run, matched on every commit message in the push |
| `installation`, `installation_repositories`                | Installations, repos and access are synced               |
| Anything else (`issues.labeled`, `pull_request.synchronize`, …) | Recorded as **ignored**, with the reason             |
| Any event sent by a bot account (including this app)      | Recorded as **ignored**, so the bot never reacts to itself |

So one PR usually produces several rows: `pull_request.opened` (**done**, rules ran) plus one
`pull_request.labeled` per label the bot added (**ignored**). They are separate GitHub deliveries with different
GUIDs, not duplicates. Keeping them means every webhook GitHub sent is accounted for, and it shows the loop
protection working.

---

## Repository layout

```
client/                React + Tailwind dashboard (Vite)
  src/pages/           Activity (live log), Rules, Repositories, Settings, Login
server/                NestJS app: API, webhook receiver, worker, reconciler
  src/webhooks/        signature check + ingest-only controller
  src/deliveries/      durable inbox: ingest, claim (SKIP LOCKED), backoff, requeue
  src/processing/      worker, event processor, ActionRunner (idempotency), AI, Slack, reconciler
  src/rules/           rule schema (zod) + pure matcher (unit tested)
  src/github/          GitHub App auth (JWT → installation token), API client with retries
  src/auth/            OAuth login, session cookie, guard
  src/dashboard/       REST + SSE endpoints for the UI, access checks
  src/db/migrations/   plain SQL, applied automatically on boot
  scripts/e2e.mjs      end-to-end test against PGlite + mock GitHub
render.yaml            Render blueprint
CLAUDE.md              AI context file used while building this
AI_NOTES.md            how AI was used
```

---

## Running locally

Prerequisites: Node 20.12+ (22 recommended), a free Supabase project, a GitHub account, and optionally a Slack
workspace and a Groq key.

```bash
npm run install:all                # installs server/ and client/
cp server/.env.example server/.env # then fill it in (see below); on Windows: copy server\.env.example server\.env
npm run dev:server                 # terminal 1: NestJS on :3000 (runs DB migrations on start)
npm run dev:client                 # terminal 2: Vite on :5173, proxies /api and /webhooks to :3000
```

Open **http://localhost:5173** (not :3000). Locally, set `APP_URL=http://localhost:5173` and register the GitHub
App callback as `http://localhost:5173/api/auth/callback` (GitHub allows localhost callbacks, because the browser
follows the redirect). GitHub can't reach `localhost` for **webhooks**, so forward them with
[smee.io](https://smee.io) (free; click "Start a new channel"):

```bash
# terminal 3
npx smee-client --url https://smee.io/<your-channel> --target http://localhost:3000/webhooks/github
```

and use the smee URL as the app's webhook URL while developing. Alternatively, use a second GitHub App for dev.
`.env` is read only at startup: restart `dev:server` after editing it.

Generating the secrets without openssl (works on Windows too):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"   # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"      # GITHUB_WEBHOOK_SECRET
node -e "console.log(require('fs').readFileSync(process.argv[1]).toString('base64'))" path/to/app.private-key.pem  # GITHUB_APP_PRIVATE_KEY
```

### Environment variables (`server/.env`)

| Variable                 | Required | Description                                                                                         |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------- |
| `APP_URL`                | yes      | Public base URL, no trailing slash. Used for OAuth redirect and the CSRF origin check                |
| `DATABASE_URL`           | yes      | Supabase **Session pooler** connection string (IPv4; Render has no IPv6 egress). Remove the `[ ]` around the password |
| `SESSION_SECRET`         | yes      | ≥ 32 random chars; signs session cookies                                                            |
| `ENCRYPTION_KEY`         | yes      | 32 random bytes, base64 (`openssl rand -base64 32`); encrypts Slack URLs                            |
| `GITHUB_APP_ID`          | yes      | GitHub App → General → App ID                                                                       |
| `GITHUB_APP_SLUG`        | yes      | The app's URL name (`github.com/apps/<slug>`)                                                       |
| `GITHUB_APP_PRIVATE_KEY` | yes      | The generated `.pem` as **one base64 line** (command above, or `base64 -w0 key.pem`), or the PEM with `\n` escapes. Pasting the multi-line PEM into `.env` keeps only its first line |
| `GITHUB_CLIENT_ID`       | yes      | GitHub App → Client ID                                                                              |
| `GITHUB_CLIENT_SECRET`   | yes      | GitHub App → generate a client secret                                                               |
| `GITHUB_WEBHOOK_SECRET`  | yes      | Same random string as in the app's webhook settings (`openssl rand -hex 32`)                        |
| `GROQ_API_KEY`           | no       | Enables AI triage. Free key at console.groq.com, no card                                            |
| `GROQ_MODEL`             | no       | Defaults to `openai/gpt-oss-20b`. Groq retires models; pick a current one from its models page     |
| `GITHUB_API_URL`         | no       | Only for GitHub Enterprise or tests (defaults to `https://api.github.com`)                          |
| `PORT`, `NODE_ENV`       | no       | Defaults `3000` / `development`                                                                     |

The server validates all of these at startup and refuses to boot with a clear message (variable names only, never
values).

---

## External setup (all free, no card)

### 1. Supabase (database)

1. Create a project at supabase.com.
2. **Connect** → **Session pooler** → copy the URI into `DATABASE_URL` (fill in the DB password).
3. That's it: tables are created by the migrations in `server/src/db/migrations` on first boot.

### 2. GitHub App

GitHub → Settings → Developer settings → **GitHub Apps** → **New GitHub App**:

| Setting                         | Value                                                                      |
| ------------------------------- | -------------------------------------------------------------------------- |
| Homepage URL                    | `APP_URL`                                                                  |
| Callback URL                    | `APP_URL/api/auth/callback`                                                |
| Setup URL (optional)            | `APP_URL/api/auth/login?next=/repos`, with **Redirect on update** checked  |
| Webhook URL                     | `APP_URL/webhooks/github`                                                  |
| Webhook secret                  | your `GITHUB_WEBHOOK_SECRET`                                               |
| Repository permissions          | **Issues: Read & write**, **Pull requests: Read & write**, **Contents: Read & write** (only needed for commit comments on push), Metadata: Read |
| Subscribe to events             | **Issues**, **Pull request**, **Push**                                     |
| Where can it be installed       | **Any account** (so reviewers can install it on their own test repo)       |

Then: copy the App ID, the slug (the last part of the app's settings URL) and the Client ID, generate a client
secret, and **Generate a private key** (base64 it into `GITHUB_APP_PRIVATE_KEY`).

Installation events are delivered automatically, but **issue, PR and push webhooks are only sent if their boxes
under "Subscribe to events" are ticked**. Those boxes appear only after the matching permission is set. After
changing permissions, accept them under **Settings → Applications → Installed GitHub Apps**.

### 3. Slack

api.slack.com/apps → **Create New App** → From scratch → **Incoming Webhooks** → On → **Add New Webhook to
Workspace** → pick a **channel** → copy the URL. Each user pastes their own URL in the dashboard's **Settings**
page. No Slack CLI is needed. Pick a channel, not a direct message: a DM target fails with
`messages_tab_disabled` unless the Slack app's Messages Tab is enabled.

### 4. Groq (optional AI)

console.groq.com → API Keys → create → `GROQ_API_KEY`. Groq retires models over time; if AI actions fail with a
"decommissioned" error, set `GROQ_MODEL` to a current model from console.groq.com/docs/models.

---

## Deployment (Render)

The whole app is **one Render free web service**: NestJS serves `/api/*`, `/webhooks/github` and the built React
app, so it's all one origin, with no CORS and simple cookies.

1. Push this repository (the whole folder, with `client/` and `server/`) to GitHub. `.gitignore` keeps `.env`,
   `*.pem`, `node_modules` and `dist` out. Use a different repo from the one the bot acts on.
2. Render → **New** → **Blueprint** → pick the repo (uses [render.yaml](render.yaml)), or create a Web Service manually:

   | Setting           | Value                                      |
   | ----------------- | ------------------------------------------ |
   | Root directory    | _(empty: the repo root)_                   |
   | Build command     | `npm run install:all && npm run build`     |
   | Start command     | `npm start`                                |
   | Instance type     | Free                                       |
   | Health check path | `/api/health`                              |

3. Environment variables: copy them from `server/.env`, except
   - `NODE_ENV=production`
   - `APP_URL=https://<service>.onrender.com` (the URL Render shows; set it after the first deploy if needed)
   - `ENCRYPTION_KEY` must be the **same** value as locally if you reuse the database, or saved Slack URLs can't
     be decrypted
   - `GITHUB_APP_PRIVATE_KEY` is the single base64 line
4. Update the GitHub App: Homepage `APP_URL`, Callback `APP_URL/api/auth/callback` (add it, and keep the localhost
   one for development), Setup URL, and Webhook URL `APP_URL/webhooks/github` (replacing the smee URL).
5. Deploy. Migrations run on boot. Check the logs for `server.started` and that `APP_URL/api/health` returns
   `{"ok":true}`.

Render redeploys on every push to the connected branch.

Free-tier note: the service sleeps after 15 minutes idle and takes about a minute to wake. A webhook that arrives
while it's asleep may time out on GitHub's side. The reconciler redelivers it shortly after the service wakes
(or click **Recover missed events** on the Activity page). This can only be tested on the deployed app: through
smee, GitHub always gets a 200 from smee.io, so it records nothing to redeliver.

If a local server and the deployed one share the same database, both workers process deliveries. That is safe
(claims use `SKIP LOCKED`, actions are idempotent), but stop the local one while testing to keep the logs readable.

---

## Testing

```bash
cd server
npm test           # unit tests: signature verification, rule matching
npm run test:e2e   # builds the server and runs it against in-memory Postgres (PGlite) + a mock GitHub API
npm run lint
```

The e2e script checks 24 behaviors, including forged signature → 401, replayed delivery → no-op, GitHub 500 →
retry with backoff, comment not re-posted on retry, manual retry re-runs nothing, unconnected repo ignored,
cross-origin POST blocked, Slack URL encrypted and never returned, and no secrets in logs.

### How to test the live app

1. Open the live URL → **Sign in with GitHub**.
2. **Repositories** → **Install the GitHub App** → choose a test repository (or use the demo repo above) → you're
   sent back → toggle the repo **on**.
3. **Settings** → paste a Slack Incoming Webhook URL → **Send test message**.
4. **Rules** → pick the template **"Bug reports → label + Slack"** (enable AI summary if you like) → Save.
5. In the repo, open an issue titled e.g. `Login page bug`. Within seconds the Activity page shows it live: the
   `bug` label is added on GitHub and a Slack alert arrives. Open a PR or push to see the other event types.
6. Re-deliver the same webhook from the GitHub App's **Advanced → Recent deliveries** page: GitHub shows
   `202 {"ok":true,"duplicate":true}` and the dashboard shows no new actions (deduplicated).

To check the database directly (Supabase → SQL Editor):

```sql
select event, action, repo_full_name, status, attempts, last_error from deliveries order by received_at desc limit 10;
select type, status, attempts, error from actions order by created_at desc limit 10;
```

### Rule fields

Empty condition fields match everything. Within a field, values are comma-separated and **any** of them may match;
across fields, **all** filled-in fields must match. Matching is case-insensitive.

| Field                        | Issues | Pull requests                    | Push                         |
| ---------------------------- | ------ | -------------------------------- | ---------------------------- |
| Title / commit message contains | title  | title                          | any commit message in the push |
| Body contains                | body   | description                      | n/a                          |
| Author is                    | opener | opener                           | pusher                       |
| Already has label            | labels at open time | labels at open time | n/a                          |
| Branch is                    | n/a    | target (base) branch, e.g. `main` | pushed branch               |

Actions: add labels (created if missing), post a comment (placeholders `{{author}} {{title}} {{repo}} {{number}}
{{branch}}`; on push it's a commit comment), Slack alert, AI summary, apply the AI-suggested label.

---

## Troubleshooting

| Symptom                                                      | Cause and fix                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Server exits with `Invalid environment configuration: X`     | Variable `X` is missing or malformed in `server/.env`                                              |
| `password authentication failed for user "postgres"`         | Wrong DB password, or the `[ ]` placeholder brackets are still around it                           |
| GitHub: "This GitHub App must be configured with a callback URL" | Add `APP_URL/api/auth/callback` as the app's Callback URL                                      |
| Login returns to `/login?error=state`                        | You opened `:3000` locally; use `:5173`, which matches `APP_URL`                                   |
| No issue/PR/push events arrive (only `installation*`)        | Tick them under **Subscribe to events** and accept the new permissions                             |
| Event shows "No rules matched"                               | A condition field has a value the event doesn't contain (e.g. a title keyword); clear it to match all |
| Label/comment fail: `secretOrPrivateKey must be an asymmetric key` | `GITHUB_APP_PRIVATE_KEY` was truncated; use the single base64 line                         |
| Slack: `messages_tab_disabled`                               | The webhook targets a DM; create one for a channel                                                 |
| AI action fails with 404 / "decommissioned"                  | The Groq model was retired; set `GROQ_MODEL` to a current one                                      |
| Push events never appear                                     | Subscribe to **Push** (needs Contents permission) and create a rule with event **Push**            |

---

## Known limitations / next steps

- Rule conditions are AND-of-ORs; there's no regex or NOT yet.
- The single in-process worker is enough for this scale. For more throughput, run more instances (the claim query
  is already `SKIP LOCKED`-safe), but the SSE fan-out would then need Postgres `LISTEN/NOTIFY`.
- Slack is at-least-once: if the process dies between Slack accepting a message and us recording it, a retry
  can send it again (Incoming Webhooks have no idempotency key). Comments and labels don't have this gap.
- No per-user rate limiting on the dashboard API.
- The Activity page shows ignored deliveries alongside the rest; a "hide ignored" filter would make it quieter.
