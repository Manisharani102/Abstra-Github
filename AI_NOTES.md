# AI_NOTES

> ✏️ **Draft. Rewrite this in your own words before submitting.** The facts below are true of how the first
> version was built. Add what happened during your own setup, deployment and debugging, and change anything
> that doesn't match your experience.

## Tools and how the work was split

- **Claude Code** (model: Claude Opus 5.5) in VS Code, with [CLAUDE.md](CLAUDE.md) as the project context file.
- I chose the stack (React, Tailwind, TypeScript, NestJS, Supabase) and the hosting, created the accounts and the
  GitHub App, Slack app, Supabase project and Groq key, and did the deployment and the live testing.
- The AI scaffolded most of the code (server modules, SQL schema, React pages) and an end-to-end test harness. I
  reviewed it against the brief's quality bar and pushed back where it was wrong (below).

## Key decisions

1. **A durable inbox table plus a DB-backed worker, not processing inside the webhook request.** GitHub times out
   after 10 s, and Render's free tier sleeps. Persisting first and acknowledging fast means a Slack or GitHub
   outage turns into a retry, not a lost event. Using Postgres (`FOR UPDATE SKIP LOCKED`) as the queue avoids
   adding another service (Redis or a queue) to set up, secure and keep alive.
2. **Idempotency per action, not just per delivery.** Deduping on the delivery GUID handles GitHub redeliveries,
   but a *retry* of a half-finished delivery would still re-comment. Each side effect has its own key in the
   `actions` table, and comments carry a hidden marker so a crash between "GitHub accepted it" and "we recorded
   it" can be detected.
3. **A GitHub App rather than an OAuth App.** It gives installation-scoped tokens (the bot acts as itself, not as
   the user), one app-level webhook for all repos (multi-repo for free), and the deliveries API that the
   reconciler uses to recover events missed while the service was asleep.

## Hardest bug / wrong turn

**Structured logs that silently lied.** The AI wrote a small JSON logger, `log.info(eventName, fields)`, which
built each line as `{ ts, level, context, event: eventName, ...fields }`. Elsewhere it logged webhook activity
with a field named `event` holding the GitHub event type. The spread overwrote the log's event name, so every
line meant to say `webhook.accepted`, `delivery.failed` or `delivery.processed` just said `"event":"issues"`.
Nothing crashed and the unit tests passed. The bug only showed when I read the tail of the server log printed
by the end-to-end harness after a failing run, and noticed that a retry and a success were indistinguishable.
For a system that's meant to run unattended, that is exactly the failure that hurts later.

**Fix:** the core keys are now written *after* the fields, so they can't be overridden, and the name key became
`msg`. The rule "the event name is the first argument, never a field" went into CLAUDE.md.

Runner-up: the first schema left every table readable through Supabase's auto-generated Data API (the anon key
isn't a secret). Caught while writing the deployment docs; fixed with migration `002_enable_rls.sql`.

Smaller ones: the AI first threw `Object.assign(error, { retryable: false })` onto a class whose `retryable` was a
getter, which would throw a `TypeError` inside the error path. It also reached for `@nestjs/serve-static@latest`,
which needs Nest 12; I replaced it with `express.static`.

## What live testing taught me

Every one of these passed the automated tests and only showed up against real services:

- **Truncated private key.** I pasted the multi-line `.pem` into `.env`, which kept only the first line. Webhooks
  arrived and Slack worked, but labels and comments failed with `secretOrPrivateKey must be an asymmetric key`.
  The dashboard showed exactly which actions failed and that the delivery was retrying. After fixing the key
  (one base64 line), the retry added the label and comment **without re-sending the Slack message** that had
  already succeeded: the per-action idempotency working for real.
- **Retired AI model.** Groq had decommissioned the default model, so the AI step returned a bare 404. Because AI
  is best-effort, the label, comment and Slack alert still went out. I switched to `openai/gpt-oss-20b`, raised
  `max_tokens` (it's a reasoning model), and made the error include Groq's own message instead of just the status.
- **Silent configuration.** No issue events arrived at all, because the GitHub App wasn't subscribed to them;
  installation events still came through, which made it look half-working. A rule also had the rule name typed
  into its title condition, so every PR said "No rules matched". Both were found by querying `deliveries`.
- **"Duplicate" events that weren't.** One PR produced three rows: `opened` (done) and two `labeled` (ignored), one
  per label the bot added. Different GUIDs, so not duplicates; I kept recording them because "never silently
  lose events" means every delivery should be accounted for, and they show the bot doesn't react to itself.

## With more time

- `LISTEN/NOTIFY` instead of in-process pub/sub, so the worker and the SSE stream can scale to several instances.
- Regex and negative conditions in rules, plus a "test this rule against a past event" button.
- A second notification channel (Telegram), and Slack via a bot token so messages can be updated rather than
  re-sent.
- Alerting when a delivery goes `dead`, and a metrics endpoint.
- A "hide ignored" filter on the Activity page, and a startup check that the GitHub App key and AI model work, so
  configuration mistakes show at boot instead of on the first event.
