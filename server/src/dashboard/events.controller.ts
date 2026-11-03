import { Controller, Get, HttpCode, MessageEvent, Param, Post, Query, Sse, UseGuards } from '@nestjs/common';
import { Observable, filter, interval, map, merge, mergeMap } from 'rxjs';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/session';
import { DbService } from '../db/db.service';
import { EventBus } from '../common/event-bus';
import { DeliveriesService } from '../deliveries/deliveries.service';
import { ReconcilerService } from '../processing/reconciler.service';
import { WorkerService } from '../processing/worker.service';
import { AccessService } from './access.service';

const FILTERS: Record<string, string[] | null> = {
  all: null,
  failed: ['failed', 'dead', 'retrying'],
  active: ['pending', 'processing', 'retrying'],
};

@Controller('api/events')
@UseGuards(AuthGuard)
export class EventsController {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
    private readonly access: AccessService,
    private readonly deliveries: DeliveriesService,
    private readonly worker: WorkerService,
    private readonly reconciler: ReconcilerService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Query('filter') f = 'all',
    @Query('before') before?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const statuses = FILTERS[f] ?? null;
    const limit = Math.min(Math.max(Number(limitRaw) || 50, 1), 100);
    const beforeTs = before && !Number.isNaN(Date.parse(before)) ? before : null;
    return this.db.query(
      `SELECT d.id, d.event, d.action, d.repo_full_name AS "repo", d.summary, d.status, d.attempts,
              d.last_error AS "lastError", d.ai, d.received_at AS "receivedAt", d.processed_at AS "processedAt",
              d.next_attempt_at AS "nextAttemptAt",
              COALESCE((
                SELECT json_agg(json_build_object(
                  'id', a.id, 'type', a.type, 'status', a.status, 'attempts', a.attempts, 'error', a.error,
                  'detail', a.detail, 'rule', r.name, 'updatedAt', a.updated_at) ORDER BY a.created_at)
                FROM actions a LEFT JOIN rules r ON r.id = a.rule_id
                WHERE a.delivery_id = d.id AND (a.user_id IS NULL OR a.user_id = $1)
              ), '[]') AS actions
       FROM deliveries d
       JOIN user_installations ui ON ui.installation_id = d.installation_id AND ui.user_id = $1
       WHERE ($2::text[] IS NULL OR d.status = ANY($2::text[]))
         AND ($3::timestamptz IS NULL OR d.received_at < $3::timestamptz)
       ORDER BY d.received_at DESC
       LIMIT $4`,
      [user.id, statuses, beforeTs, limit],
    );
  }

  @Get('stats')
  async stats(@CurrentUser() user: SessionUser) {
    const rows = await this.db.query<{ status: string; count: string }>(
      `SELECT d.status, count(*) FROM deliveries d
       JOIN user_installations ui ON ui.installation_id = d.installation_id AND ui.user_id = $1
       WHERE d.received_at > now() - interval '7 days'
       GROUP BY d.status`,
      [user.id],
    );
    const actions = await this.db.query<{ status: string; count: string }>(
      `SELECT a.status, count(*) FROM actions a
       JOIN deliveries d ON d.id = a.delivery_id
       JOIN user_installations ui ON ui.installation_id = d.installation_id AND ui.user_id = $1
       WHERE a.created_at > now() - interval '7 days' AND (a.user_id IS NULL OR a.user_id = $1)
       GROUP BY a.status`,
      [user.id],
    );
    const toMap = (rs: { status: string; count: string }[]) =>
      Object.fromEntries(rs.map((r) => [r.status, Number(r.count)]));
    return { deliveries: toMap(rows), actions: toMap(actions) };
  }

  /** Live updates: tells the dashboard which delivery changed; it refetches what it needs. */
  @Sse('stream')
  stream(@CurrentUser() user: SessionUser): Observable<MessageEvent> {
    const changes = this.bus.deliveryChanged$.pipe(
      mergeMap(async (c) =>
        c.installationId !== null && (await this.access.canSeeInstallation(user.id, c.installationId)) ? c : null,
      ),
      filter((c) => c !== null),
      map((c): MessageEvent => ({ type: 'delivery', data: { id: c.deliveryId } })),
    );
    // Keeps proxies from closing an idle connection.
    const heartbeat = interval(25_000).pipe(map((): MessageEvent => ({ type: 'ping', data: {} })));
    return merge(changes, heartbeat);
  }

  @Post(':id/retry')
  @HttpCode(202)
  async retry(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    await this.access.assertDelivery(user.id, id);
    await this.deliveries.requeue(id);
    this.worker.kick();
    return { ok: true };
  }

  /** Asks GitHub to redeliver anything that failed to reach us (normally runs on a timer). */
  @Post('reconcile')
  @HttpCode(202)
  async reconcile() {
    return this.reconciler.run();
  }
}
