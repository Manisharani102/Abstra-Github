import { Global, Module } from '@nestjs/common';
import { DeliveriesService } from './deliveries.service';

@Global()
@Module({
  providers: [DeliveriesService],
  exports: [DeliveriesService],
})
export class DeliveriesModule {}
