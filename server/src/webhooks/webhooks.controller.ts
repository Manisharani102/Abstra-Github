import {
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { loadEnv } from '../config/env';
import { AppLogger, errorMessage } from '../common/logger';
import { DeliveriesService } from '../deliveries/deliveries.service';
import { WorkerService } from '../processing/worker.service';
import { verifyGitHubSignature } from './signature';

const log = new AppLogger('webhooks');
const DELIVERY_ID = /^[0-9a-f-]{8,64}$/i;

@Controller('webhooks')
export class WebhooksController {
  private readonly secret = loadEnv().GITHUB_WEBHOOK_SECRET;

  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly worker: WorkerService,
  ) {}

  /**
   * Ingest only: verify, persist, acknowledge. All work happens in the worker so the response is
   * fast (GitHub times out after 10s) and nothing is lost if a downstream call fails.
   */
  @Post('github')
  @HttpCode(202)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-delivery') deliveryId: string | undefined,
    @Headers('x-github-event') event: string | undefined,
  ) {
    if (!verifyGitHubSignature(req.rawBody, signature, this.secret)) {
      log.warn('webhook.bad_signature', { deliveryId, event, ip: req.ip });
      throw new UnauthorizedException('Invalid signature');
    }
    if (!deliveryId || !DELIVERY_ID.test(deliveryId) || !event) {
      throw new BadRequestException('Missing delivery headers');
    }

    let inserted: boolean;
    try {
      inserted = await this.deliveries.ingest(deliveryId, event, req.body as Record<string, unknown>);
    } catch (err) {
      // Non-2xx makes GitHub record a failed delivery, which the reconciler will redeliver.
      log.error('webhook.persist_failed', { deliveryId, event, error: errorMessage(err) });
      throw new ServiceUnavailableException();
    }

    if (!inserted) {
      // Same GUID as something we already have: a redelivery or a replayed request. No-op.
      log.info('webhook.duplicate', { deliveryId, event });
      return { ok: true, duplicate: true };
    }
    log.info('webhook.accepted', { deliveryId, event });
    this.worker.kick();
    return { ok: true };
  }
}
