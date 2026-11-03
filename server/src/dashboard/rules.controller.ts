import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/session';
import { DbService } from '../db/db.service';
import { parseBody } from '../common/validation';
import { ruleInputSchema } from '../rules/rule.types';
import { AccessService } from './access.service';

const SELECT_RULE = `SELECT r.id, r.name, r.enabled, r.event, r.repo_id::text AS "repoId", repo.full_name AS "repoFullName",
  r.conditions, r.actions, r.created_at AS "createdAt", r.updated_at AS "updatedAt"
  FROM rules r LEFT JOIN repositories repo ON repo.id = r.repo_id`;

@Controller('api/rules')
@UseGuards(AuthGuard)
export class RulesController {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  @Get()
  list(@CurrentUser() user: SessionUser) {
    return this.db.query(`${SELECT_RULE} WHERE r.user_id = $1 ORDER BY r.created_at`, [user.id]);
  }

  @Post()
  async create(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const input = parseBody(ruleInputSchema, body);
    if (input.repoId !== null) await this.access.assertRepo(user.id, input.repoId);
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO rules (user_id, repo_id, name, enabled, event, conditions, actions)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [user.id, input.repoId, input.name, input.enabled, input.event, input.conditions, input.actions],
    );
    return this.get(user.id, row!.id);
  }

  @Put(':id')
  async update(@CurrentUser() user: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parseBody(ruleInputSchema, body);
    if (input.repoId !== null) await this.access.assertRepo(user.id, input.repoId);
    const row = await this.db.one(
      `UPDATE rules SET repo_id = $3, name = $4, enabled = $5, event = $6, conditions = $7, actions = $8, updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, user.id, input.repoId, input.name, input.enabled, input.event, input.conditions, input.actions],
    );
    if (!row) throw new NotFoundException();
    return this.get(user.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.db.one(`DELETE FROM rules WHERE id = $1 AND user_id = $2 RETURNING id`, [id, user.id]);
    if (!row) throw new NotFoundException();
  }

  private async get(userId: string, id: string) {
    const row = await this.db.one(`${SELECT_RULE} WHERE r.id = $1 AND r.user_id = $2`, [id, userId]);
    if (!row) throw new NotFoundException();
    return row;
  }
}
