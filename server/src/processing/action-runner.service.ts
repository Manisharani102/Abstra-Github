import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { errorMessage } from '../common/logger';

export type ActionType = 'label' | 'comment' | 'slack' | 'ai';

export interface ActionMeta {
  deliveryId: string;
  userId: string | null;
  ruleId: string | null;
  type: ActionType;
}

export interface ActionResult {
  /** Set when the action intentionally did nothing (e.g. Slack not configured). */
  skipped?: string;
  detail?: Record<string, unknown>;
}

export interface ActionOutcome {
  status: 'succeeded' | 'skipped' | 'failed';
  retryable: boolean;
  error?: string;
}

/** The idempotency key: one side effect per delivery, rule and action type. */
export function actionKey(m: ActionMeta): string {
  return [m.deliveryId, m.ruleId ?? '-', m.userId ?? '-', m.type].join(':');
}

/**
 * Runs a side effect at most once successfully. If the same delivery is processed again (worker
 * retry, crash recovery, manual retry), anything that already succeeded is skipped and only
 * failed or unfinished actions run. The `attempt` passed to `fn` lets non-idempotent effects
 * (comments) check whether an earlier attempt already got through before recording success.
 */
@Injectable()
export class ActionRunner {
  constructor(private readonly db: DbService) {}

  async runOnce(meta: ActionMeta, fn: (attempt: number) => Promise<ActionResult>): Promise<ActionOutcome> {
    const key = actionKey(meta);
    const existing = await this.db.one<{ status: string }>(`SELECT status FROM actions WHERE idempotency_key = $1`, [
      key,
    ]);
    if (existing && (existing.status === 'succeeded' || existing.status === 'skipped')) {
      return { status: existing.status, retryable: false };
    }

    const row = await this.db.one<{ attempts: number }>(
      `INSERT INTO actions (idempotency_key, delivery_id, user_id, rule_id, type, status, attempts)
       VALUES ($1, $2, $3, $4, $5, 'running', 1)
       ON CONFLICT (idempotency_key) DO UPDATE SET status = 'running', attempts = actions.attempts + 1, updated_at = now()
       RETURNING attempts`,
      [key, meta.deliveryId, meta.userId, meta.ruleId, meta.type],
    );

    try {
      const result = await fn(row!.attempts);
      const status = result.skipped ? 'skipped' : 'succeeded';
      await this.db.query(
        `UPDATE actions SET status = $2, detail = $3, error = NULL, updated_at = now() WHERE idempotency_key = $1`,
        [key, status, { ...result.detail, ...(result.skipped ? { reason: result.skipped } : {}) }],
      );
      return { status, retryable: false };
    } catch (err) {
      const retryable = (err as { retryable?: boolean }).retryable ?? true;
      const message = errorMessage(err);
      await this.db.query(
        `UPDATE actions SET status = 'failed', error = $2, detail = $3, updated_at = now() WHERE idempotency_key = $1`,
        [key, message, { retryable }],
      );
      return { status: 'failed', retryable, error: message };
    }
  }
}
