/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- GitHub webhook payloads are untyped JSON */
import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { EventBus } from '../common/event-bus';

export type DeliveryStatus = 'pending' | 'processing' | 'retrying' | 'done' | 'ignored' | 'failed' | 'dead';

export interface DeliveryRow {
  id: string;
  event: string;
  action: string | null;
  installation_id: string | null; // bigint comes back as string from pg
  repo_id: string | null;
  repo_full_name: string | null;
  summary: string | null;
  payload: Record<string, any>;
  status: DeliveryStatus;
  attempts: number;
  ai: Record<string, unknown> | null;
}

export const MAX_ATTEMPTS = 8;

/** Exponential backoff: 30s, 1m, 2m, 4m ... capped at 1h. */
export function backoffSeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempts - 1), 3600);
}

function summarize(event: string, p: Record<string, any>): string {
  switch (event) {
    case 'issues':
      return `Issue #${p.issue?.number} ${p.action}: ${p.issue?.title ?? ''}`;
    case 'pull_request':
      return `PR #${p.pull_request?.number} ${p.action}: ${p.pull_request?.title ?? ''}`;
    case 'push': {
      const n = Array.isArray(p.commits) ? p.commits.length : 0;
      return `Push of ${n} commit${n === 1 ? '' : 's'} to ${String(p.ref ?? '').replace('refs/heads/', '')}`;
    }
    case 'installation':
    case 'installation_repositories':
      return `App ${event.replace('_', ' ')} ${p.action}`;
    case 'ping':
      return 'Webhook ping';
    default:
      return `${event}${p.action ? ` ${p.action}` : ''}`;
  }
}

@Injectable()
export class DeliveriesService {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  /** Stores a verified delivery. Returns false if this delivery GUID was already stored. */
  async ingest(id: string, event: string, payload: Record<string, any>): Promise<boolean> {
    const installationId = payload.installation?.id ?? null;
    const row = await this.db.one(
      `INSERT INTO deliveries (id, event, action, installation_id, repo_id, repo_full_name, summary, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        id,
        event,
        typeof payload.action === 'string' ? payload.action : null,
        installationId,
        payload.repository?.id ?? null,
        payload.repository?.full_name ?? null,
        summarize(event, payload).slice(0, 300),
        payload,
      ],
    );
    if (row) this.bus.deliveryChanged({ deliveryId: id, installationId });
    return row !== null;
  }

  /**
   * Atomically claims the next due delivery. SKIP LOCKED makes this safe with several workers;
   * an expired `locked_until` reclaims work from a worker that crashed mid-processing.
   */
  async claimNext(): Promise<DeliveryRow | null> {
    return this.db.one<DeliveryRow>(
      `UPDATE deliveries SET status = 'processing', attempts = attempts + 1, locked_until = now() + interval '2 minutes'
       WHERE id = (
         SELECT id FROM deliveries
         WHERE (status IN ('pending', 'retrying') AND next_attempt_at <= now())
            OR (status = 'processing' AND locked_until < now())
         ORDER BY next_attempt_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, event, action, installation_id, repo_id, repo_full_name, summary, payload, status, attempts, ai`,
    );
  }

  async complete(d: DeliveryRow, status: 'done' | 'ignored' | 'failed', note?: string) {
    await this.db.query(
      `UPDATE deliveries SET status = $2, last_error = $3, locked_until = NULL, processed_at = now() WHERE id = $1`,
      [d.id, status, note ?? null],
    );
    this.emit(d);
  }

  async fail(d: DeliveryRow, error: string): Promise<DeliveryStatus> {
    const dead = d.attempts >= MAX_ATTEMPTS;
    const status: DeliveryStatus = dead ? 'dead' : 'retrying';
    await this.db.query(
      `UPDATE deliveries SET status = $2, last_error = $3, locked_until = NULL,
         next_attempt_at = now() + make_interval(secs => $4), processed_at = CASE WHEN $2 = 'dead' THEN now() ELSE NULL END
       WHERE id = $1`,
      [d.id, status, error, backoffSeconds(d.attempts)],
    );
    this.emit(d);
    return status;
  }

  async saveAi(id: string, ai: Record<string, unknown>) {
    await this.db.query(`UPDATE deliveries SET ai = $2 WHERE id = $1`, [id, ai]);
  }

  /** Manual retry from the dashboard. Successful actions are still skipped thanks to idempotency keys. */
  async requeue(id: string) {
    await this.db.query(
      `UPDATE deliveries SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL, locked_until = NULL
       WHERE id = $1 AND status IN ('failed', 'dead', 'done', 'ignored', 'retrying')`,
      [id],
    );
  }

  async exists(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.db.query<{ id: string }>(`SELECT id FROM deliveries WHERE id = ANY($1::text[])`, [ids]);
    return new Set(rows.map((r) => r.id));
  }

  private emit(d: DeliveryRow) {
    this.bus.deliveryChanged({
      deliveryId: d.id,
      installationId: d.installation_id ? Number(d.installation_id) : null,
    });
  }
}
