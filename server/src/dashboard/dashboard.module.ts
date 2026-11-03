import { Controller, Get, Module } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { AccessService } from './access.service';
import { EventsController } from './events.controller';
import { ReposController } from './repos.controller';
import { RulesController } from './rules.controller';
import { SettingsController } from './settings.controller';

@Controller('api/health')
class HealthController {
  constructor(private readonly db: DbService) {}

  @Get()
  async health() {
    await this.db.query('SELECT 1');
    return { ok: true };
  }
}

@Module({
  controllers: [EventsController, ReposController, RulesController, SettingsController, HealthController],
  providers: [AccessService],
})
export class DashboardModule {}
