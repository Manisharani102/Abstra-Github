-- Users who signed in with GitHub. We never store their OAuth token.
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id   bigint UNIQUE NOT NULL,
  login       text NOT NULL,
  name        text,
  avatar_url  text,
  -- AES-256-GCM ciphertext of the user's Slack Incoming Webhook URL.
  slack_webhook_enc text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- GitHub App installations (one per account the app is installed on).
CREATE TABLE installations (
  id             bigint PRIMARY KEY,           -- GitHub installation id
  account_login  text NOT NULL,
  account_type   text NOT NULL,
  suspended      boolean NOT NULL DEFAULT false,
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Which users may see / manage which installations (verified via GitHub, never via client input).
CREATE TABLE user_installations (
  user_id          uuid   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id  bigint NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, installation_id)
);

CREATE TABLE repositories (
  id               bigint PRIMARY KEY,         -- GitHub repository id
  installation_id  bigint NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  full_name        text NOT NULL,
  private          boolean NOT NULL DEFAULT false,
  removed_at       timestamptz,                -- repo removed from the installation
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX repositories_installation_idx ON repositories (installation_id);

-- Repositories a user has explicitly connected; the bot only acts on these.
CREATE TABLE connections (
  user_id     uuid   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id     bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, repo_id)
);

CREATE TABLE rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id     bigint REFERENCES repositories(id) ON DELETE CASCADE, -- NULL = all connected repos
  name        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  event       text NOT NULL CHECK (event IN ('issues', 'pull_request', 'push')),
  conditions  jsonb NOT NULL DEFAULT '{}'::jsonb,
  actions     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rules_user_idx ON rules (user_id);

-- Durable inbox of every webhook delivery. The primary key on GitHub's delivery GUID is
-- what makes replays and duplicate deliveries harmless.
CREATE TABLE deliveries (
  id               text PRIMARY KEY,           -- X-GitHub-Delivery
  event            text NOT NULL,              -- X-GitHub-Event
  action           text,
  installation_id  bigint,
  repo_id          bigint,
  repo_full_name   text,
  summary          text,                       -- human readable one-liner for the dashboard
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                   -- failed = finished but an action failed permanently (e.g. 403); dead = retries exhausted
                   CHECK (status IN ('pending', 'processing', 'retrying', 'done', 'ignored', 'failed', 'dead')),
  attempts         int NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  last_error       text,
  ai               jsonb,                      -- cached AI triage result (computed at most once)
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz
);
CREATE INDEX deliveries_queue_idx ON deliveries (next_attempt_at) WHERE status IN ('pending', 'retrying', 'processing');
CREATE INDEX deliveries_installation_idx ON deliveries (installation_id, received_at DESC);

-- Every side effect the bot performs, keyed so that it runs at most once per delivery+rule+type.
CREATE TABLE actions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  text UNIQUE NOT NULL,
  delivery_id      text NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  rule_id          uuid REFERENCES rules(id) ON DELETE SET NULL,
  type             text NOT NULL,              -- label | comment | slack | ai
  status           text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  attempts         int NOT NULL DEFAULT 0,
  detail           jsonb,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX actions_delivery_idx ON actions (delivery_id);
