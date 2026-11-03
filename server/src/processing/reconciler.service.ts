import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { AppLogger, errorMessage } from '../common/logger';
import { DeliveriesService } from '../deliveries/deliveries.service';
import { GitHubAppService, WebhookDeliverySummary } from '../github/github-app.service';

const log = new AppLogger('reconciler');
const INTERVAL_MS = 10 * 60_000;
const MAX_AGE_MS = 2.5 * 24 * 3600_000; // GitHub only allows redelivery within 3 days
const MAX_REDELIVERIES_PER_GUID = 3;
const MAX_PER_RUN = 25;

/**
 * Recovers events we never stored, e.g. while the free-tier host was asleep or down.
 * GitHub records every delivery attempt; any GUID that never got a 2xx and that we don't
 * have in the database is asked to be redelivered. Duplicates are harmless (GUID dedupe).
 */
@Injectable()
export class ReconcilerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private startup?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly github: GitHubAppService,
    private readonly deliveries: DeliveriesService,
  ) {}

  onApplicationBootstrap() {
    // Shortly after boot is exactly when missed deliveries are most likely.
    this.startup = setTimeout(() => void this.run(), 15_000);
    this.timer = setInterval(() => void this.run(), INTERVAL_MS);
  }

  onApplicationShutdown() {
    clearTimeout(this.startup);
    clearInterval(this.timer);
  }

  async run(): Promise<{ redelivered: number }> {
    if (this.running) return { redelivered: 0 };
    this.running = true;
    try {
      const recent = await this.github.listRecentDeliveries();
      const byGuid = new Map<string, WebhookDeliverySummary[]>();
      for (const d of recent) byGuid.set(d.guid, [...(byGuid.get(d.guid) ?? []), d]);

      const candidates = [...byGuid.entries()].filter(([, attempts]) => {
        const ok = attempts.some((a) => a.status_code >= 200 && a.status_code < 300);
        const oldest = Math.min(...attempts.map((a) => new Date(a.delivered_at).getTime()));
        return !ok && Date.now() - oldest < MAX_AGE_MS && attempts.length <= MAX_REDELIVERIES_PER_GUID;
      });
      const known = await this.deliveries.exists(candidates.map(([guid]) => guid));

      let redelivered = 0;
      for (const [guid, attempts] of candidates) {
        if (known.has(guid) || redelivered >= MAX_PER_RUN) continue;
        const latest = attempts.reduce((a, b) => (new Date(a.delivered_at) > new Date(b.delivered_at) ? a : b));
        try {
          await this.github.redeliver(latest.id);
          redelivered++;
          log.info('redelivery.requested', { guid, event: latest.event, lastStatus: latest.status_code });
        } catch (err) {
          log.warn('redelivery.failed', { guid, error: errorMessage(err) });
        }
      }
      log.info('reconcile.done', { scanned: recent.length, redelivered });
      return { redelivered };
    } catch (err) {
      log.error('reconcile.failed', { error: errorMessage(err) });
      return { redelivered: 0 };
    } finally {
      this.running = false;
    }
  }
}
