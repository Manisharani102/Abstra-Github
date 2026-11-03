import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DbModule } from './db/db.module';
import { DeliveriesModule } from './deliveries/deliveries.module';
import { GitHubModule } from './github/github.module';
import { ProcessingModule } from './processing/processing.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    CommonModule,
    DbModule,
    GitHubModule,
    DeliveriesModule,
    ProcessingModule,
    AuthModule,
    WebhooksModule,
    DashboardModule,
  ],
})
export class AppModule {}
