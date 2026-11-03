import { BadRequestException, Body, Controller, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/session';
import { CryptoService } from '../common/crypto.service';
import { errorMessage } from '../common/logger';
import { parseBody } from '../common/validation';
import { DbService } from '../db/db.service';
import { SLACK_WEBHOOK_PATTERN, SlackService } from '../processing/slack.service';

const slackSchema = z.object({
  webhookUrl: z
    .string()
    .trim()
    .regex(SLACK_WEBHOOK_PATTERN, 'Must be a https://hooks.slack.com/services/... URL')
    .nullable(),
});

/** The Slack URL is write-only from the browser's point of view: it is never sent back. */
@Controller('api/settings')
@UseGuards(AuthGuard)
export class SettingsController {
  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly slack: SlackService,
  ) {}

  @Put('slack')
  async setSlack(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const { webhookUrl } = parseBody(slackSchema, body);
    await this.db.query(`UPDATE users SET slack_webhook_enc = $2, updated_at = now() WHERE id = $1`, [
      user.id,
      webhookUrl ? this.crypto.encrypt(webhookUrl) : null,
    ]);
    return { slackConfigured: webhookUrl !== null };
  }

  @Post('slack/test')
  async testSlack(@CurrentUser() user: SessionUser) {
    const row = await this.db.one<{ slack_webhook_enc: string | null }>(
      `SELECT slack_webhook_enc FROM users WHERE id = $1`,
      [user.id],
    );
    if (!row?.slack_webhook_enc) throw new BadRequestException('Slack is not configured');
    try {
      await this.slack.send(
        this.crypto.decrypt(row.slack_webhook_enc),
        `:wave: Test message from the GitHub automation bot for ${user.login}`,
      );
    } catch (err) {
      throw new BadRequestException(errorMessage(err));
    }
    return { ok: true };
  }
}
