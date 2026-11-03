import { Global, Module } from '@nestjs/common';
import { ActionRunner } from './action-runner.service';
import { AiService } from './ai.service';
import { EventProcessor } from './event-processor.service';
import { ReconcilerService } from './reconciler.service';
import { SlackService } from './slack.service';
import { WorkerService } from './worker.service';

@Global()
@Module({
  providers: [ActionRunner, AiService, EventProcessor, ReconcilerService, SlackService, WorkerService],
  exports: [WorkerService, SlackService, ReconcilerService],
})
export class ProcessingModule {}
