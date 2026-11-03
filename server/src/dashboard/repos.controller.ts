import { BadRequestException, Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/session';
import { DbService } from '../db/db.service';
import { InstallationsService } from '../github/installations.service';
import { AppLogger, errorMessage } from '../common/logger';
import { parseBody } from '../common/validation';
import { AccessService } from './access.service';

const log = new AppLogger('repos');

@Controller('api/repos')
@UseGuards(AuthGuard)
export class ReposController {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly installations: InstallationsService,
  ) {}

  @Get()
  async list(@CurrentUser() user: SessionUser) {
    return this.db.query(
      `SELECT r.id::text AS id, r.full_name AS "fullName", r.private, i.account_login AS account, i.suspended,
              (c.user_id IS NOT NULL) AS connected
       FROM repositories r
       JOIN installations i ON i.id = r.installation_id AND i.deleted_at IS NULL
       JOIN user_installations ui ON ui.installation_id = i.id AND ui.user_id = $1
       LEFT JOIN connections c ON c.repo_id = r.id AND c.user_id = $1
       WHERE r.removed_at IS NULL
       ORDER BY r.full_name`,
      [user.id],
    );
  }

  /** Re-reads repository lists from GitHub for the user's installations. */
  @Post('sync')
  async sync(@CurrentUser() user: SessionUser) {
    const installs = await this.db.query<{ installation_id: string }>(
      `SELECT ui.installation_id FROM user_installations ui JOIN installations i ON i.id = ui.installation_id
       WHERE ui.user_id = $1 AND i.deleted_at IS NULL`,
      [user.id],
    );
    const errors: string[] = [];
    for (const { installation_id } of installs) {
      try {
        await this.installations.syncRepos(Number(installation_id));
      } catch (err) {
        log.warn('sync.failed', { installationId: installation_id, error: errorMessage(err) });
        errors.push(errorMessage(err));
      }
    }
    return { ok: errors.length === 0, errors };
  }

  @Put(':id/connection')
  async setConnection(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const { connected } = parseBody(z.object({ connected: z.boolean() }), body);
    if (!/^\d+$/.test(id)) throw new BadRequestException('Invalid repository id');
    await this.access.assertRepo(user.id, id);
    if (connected) {
      await this.db.query(`INSERT INTO connections (user_id, repo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        user.id,
        id,
      ]);
    } else {
      await this.db.query(`DELETE FROM connections WHERE user_id = $1 AND repo_id = $2`, [user.id, id]);
    }
    return { ok: true, connected };
  }
}
