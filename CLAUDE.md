# CLAUDE.md

Context for AI coding assistants working in this repository.

## What this is

An event-driven GitHub automation bot. A GitHub App sends webhooks (issues, pull_request, push) to a NestJS
server, which records them, evaluates user-defined rules, writes back to GitHub (labels and comments), notifies
Slack, and optionally runs AI triage (Groq). A React dashboard shows a live log and manages rules.

- `server/`: NestJS 11, TypeScript, raw SQL via `pg`, `zod` validation. Supabase Postgres.
- `client/`: React 19, Vite, Tailwind v4, React Router 7. Built output is served by the server (same origin).
- Deployed as one Render free web service from the repo root (`render.yaml`). The worker and reconciler need a
  long-running process, so serverless hosts (e.g. Vercel functions) can't run the backend.

## Commands

```bash
npm run install:all          # root: install both packages
npm run dev:server           # :3000
npm run dev:client           # :5173 (proxies /api, /webhooks to :3000)
cd server && npm test        # jest unit tests
cd server && npm run test:e2e   # full server vs PGlite + mock GitHub; must stay green
cd server && npm run lint    # eslint + prettier (printWidth 120)
npm run build                # root: client then server
```

## Invariants: do not break these

1. **The webhook controller only ingests.** Verify the signature on `req.rawBody`, insert into `deliveries`, return 202.
   Never call GitHub, Slack or the LLM from the request path.
2. **Delivery GUID is the dedupe key.** `deliveries.id = X-GitHub-Delivery`, `ON CONFLICT DO NOTHING`.
3. **Every side effect goes through `ActionRunner.runOnce`** with a stable key (delivery:rule:user:type), so retries
   never repeat a successful action. Non-idempotent effects must be able to detect a previous success (see the
   comment marker in `event-processor.service.ts`).
4. **Errors carry `retryable`.** 5xx, 429, rate-limit 403 and network errors are retryable; other 4xx are not.
   Retryable failures throw `RetryableProcessingError` so the worker backs off; permanent ones end as `failed`.
5. **Never log or return secrets.** Use `AppLogger` (it redacts). Slack URLs are encrypted with `CryptoService` and
   are write-only via the API. User OAuth tokens are never persisted.
6. **Authorization comes from GitHub, not the client.** Visibility = `user_installations`, populated from
   `/user/installations` at login or from the installation webhook's `sender`. Check with `AccessService`.
7. **Schema changes go in a new numbered file** in `server/src/db/migrations/`. Never edit an applied migration.
   New tables need `ENABLE ROW LEVEL SECURITY` (Supabase Data API exposure).

## Conventions

- Raw parameterised SQL (`$1`), no ORM. Postgres `bigint` comes back as `string`; cast to text in SQL for ids sent to the client.
- Validate request bodies with zod via `parseBody(schema, body)`.
- Structured logs: `log.info('noun.verb', { fields })`. The event name is the first argument, never a field.
- GitHub payloads are untyped (`Record<string, any>`); normalise them in `processing/event-context.ts`.
- Server code uses no Octokit (ESM-only packages clash with Nest's CommonJS build); use `githubRequest`/`GitHubAppService`.
- Frontend: Tailwind utility classes, shared primitives in `client/src/components/ui.tsx`, `api()` helper in `client/src/api.ts`.
- Keep comments for the *why*; the code says the *what*.

## Behaviour that looks wrong but is intended

- **Ignored deliveries are kept.** Every webhook is stored; ones with no handler (`issues.labeled`,
  `pull_request.synchronize`, …) or sent by a bot end as `ignored` with a note. One PR typically yields
  `pull_request.opened` (done) plus one `pull_request.labeled` per label the bot added (ignored). Don't filter
  these at ingest: that would break invariant 1 and make "never received" indistinguishable from "skipped".
- **AI is best-effort.** A failed `ai` action doesn't fail the delivery; labels, comment and Slack still run.
- Rules only run for the actions listed in `isActionable` (`processing/event-context.ts`).

## Setup gotchas seen in practice

- `GITHUB_APP_PRIVATE_KEY` must be one line (base64 of the PEM). A pasted multi-line PEM in `.env` keeps only
  the first line, and fails later as `secretOrPrivateKey must be an asymmetric key`.
- The GitHub App only sends issue/PR/push webhooks for events ticked under "Subscribe to events".
- Groq retires models (`llama-3.1-8b-instant` went away → 404). Default is `openai/gpt-oss-20b`, a reasoning
  model, so keep `max_tokens` generous. Error messages include the provider's reason.
- Slack Incoming Webhooks pointed at a DM fail with `messages_tab_disabled`; use a channel.
- When inspecting the user's `.env`, report shape (length, prefix, parses or not), never values.
