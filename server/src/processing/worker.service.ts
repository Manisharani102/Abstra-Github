import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { AppLogger, errorMessage } from '../common/logger';
import { DeliveriesService, DeliveryRow } from '../deliveries/deliveries.service';
import { EventProcessor } from './event-processor.service';

const log = new AppLogger('worker');
const POLL_MS = 5_000;

/**
 * Drains the deliveries table. Kicked immediately when a webhook arrives, and also polls so that
 * scheduled retries and work left over from a restart get picked up.
 */
@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private draining = false;
  private rerun = false;
  private stopped = false;

  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly processor: EventProcessor,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => this.kick(), POLL_MS);
    this.kick();
  }

  onApplicationShutdown() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  kick() {
    if (this.stopped) return;
    if (this.draining) {
      this.rerun = true;
      return;
    }
    void this.drain();
  }

  private async drain() {
    this.draining = true;
    try {
      for (;;) {
        if (this.stopped) break;
        const d = await this.deliveries.claimNext();
        if (!d) break;
        await this.handle(d);
      }
    } catch (err) {
      log.error('drain.failed', { error: errorMessage(err) });
    } finally {
      this.draining = false;
      if (this.rerun) {
        this.rerun = false;
        this.kick();
      }
    }
  }

  private async handle(d: DeliveryRow) {
    const started = Date.now();
    try {
      const result = await this.processor.process(d);
      await this.deliveries.complete(d, result.status, result.note);
      log.info('delivery.processed', {
        deliveryId: d.id,
        event: d.event,
        status: result.status,
        attempt: d.attempts,
        ms: Date.now() - started,
      });
    } catch (err) {
      const status = await this.deliveries.fail(d, errorMessage(err));
      log.warn('delivery.failed', {
        deliveryId: d.id,
        event: d.event,
        status,
        attempt: d.attempts,
        error: errorMessage(err),
      });
    }
  }
}
