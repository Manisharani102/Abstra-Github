import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

export interface DeliveryChanged {
  deliveryId: string;
  installationId: number | null;
}

/** In-process pub/sub that feeds the dashboard's live (SSE) stream. Single instance is enough here. */
@Injectable()
export class EventBus {
  readonly deliveryChanged$ = new Subject<DeliveryChanged>();

  deliveryChanged(change: DeliveryChanged) {
    this.deliveryChanged$.next(change);
  }
}
