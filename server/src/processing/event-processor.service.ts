/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- GitHub webhook payloads are untyped JSON */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DbService } from '../db/db.service';
import { CryptoService } from '../common/crypto.service';
import { AppLogger } from '../common/logger';
import { DeliveriesService, DeliveryRow } from '../deliveries/deliveries.service';
import { GitHubAppService } from '../github/github-app.service';
import { InstallationsService } from '../github/installations.service';
import { matchesConditions, renderTemplate } from '../rules/rule-matcher';
import {
  EventContext,
  RuleActions,
  RuleConditions,
  ruleActionsSchema,
  ruleConditionsSchema,
} from '../rules/rule.types';
import { ActionOutcome, ActionRunner, actionKey } from './action-runner.service';
import { AiService, AiTriage } from './ai.service';
import { isActionable, toEventContext } from './event-context';
import { SlackService, slackEscape } from './slack.service';

const log = new AppLogger('processor');

export interface ProcessResult {
  status: 'done' | 'ignored' | 'failed';
  note?: string;
}

/** Thrown when at least one action failed in a way that is worth retrying later. */
export class RetryableProcessingError extends Error {}

interface MatchedRule {
  id: string;
  user_id: string;
  name: string;
  conditions: RuleConditions;
  actions: RuleActions;
  slack_webhook_enc: string | null;
}

@Injectable()
export class EventProcessor {
  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly deliveries: DeliveriesService,
    private readonly github: GitHubAppService,
    private readonly installations: InstallationsService,
    private readonly runner: ActionRunner,
    private readonly ai: AiService,
    private readonly slack: SlackService,
  ) {}

  async process(d: DeliveryRow): Promise<ProcessResult> {
    const p = d.payload;
    switch (d.event) {
      case 'ping':
        return { status: 'ignored', note: 'Webhook ping' };
      case 'installation':
        return this.onInstallation(p);
      case 'installation_repositories':
        return this.onInstallationRepositories(p);
    }

    if (!isActionable(d.event, d.action))
      return { status: 'ignored', note: `No handler for ${d.event}.${d.action ?? ''}` };
    // Never react to bots (including ourselves): avoids feedback loops.
    if (p.sender?.type === 'Bot') return { status: 'ignored', note: 'Sent by a bot' };

    const ctx = toEventContext(d.event, p);
    if (!ctx) return { status: 'ignored', note: 'Nothing to act on' };
    return this.onActivity(d, ctx);
  }

  private async onActivity(d: DeliveryRow, ctx: EventContext): Promise<ProcessResult> {
    const connected = await this.db.one(`SELECT 1 FROM connections WHERE repo_id = $1 LIMIT 1`, [ctx.repoId]);
    if (!connected) return { status: 'ignored', note: 'Repository is not connected' };

    const rules = (
      await this.db.query<MatchedRule>(
        `SELECT r.id, r.user_id, r.name, r.conditions, r.actions, u.slack_webhook_enc
         FROM rules r
         JOIN connections c ON c.user_id = r.user_id AND c.repo_id = $1
         JOIN user_installations ui ON ui.user_id = r.user_id AND ui.installation_id = $3
         JOIN users u ON u.id = r.user_id
         WHERE r.enabled AND r.event = $2 AND (r.repo_id IS NULL OR r.repo_id = $1)
         ORDER BY r.created_at`,
        [ctx.repoId, ctx.event, ctx.installationId],
      )
    )
      // Re-parse stored JSON so rules saved by older versions get today's defaults.
      .map((r) => ({
        ...r,
        conditions: ruleConditionsSchema.parse(r.conditions),
        actions: ruleActionsSchema.parse(r.actions),
      }))
      .filter((r) => matchesConditions(r.conditions, ctx));

    if (rules.length === 0) return { status: 'done', note: 'No rules matched' };

    const wantsAi = rules.some((r) => r.actions.ai || r.actions.applyAiLabel);
    const ai = wantsAi ? await this.triage(d, ctx) : null;

    const outcomes: ActionOutcome[] = [];
    for (const rule of rules) {
      outcomes.push(...(await this.applyRule(d, ctx, rule, ai)));
    }

    const failed = outcomes.filter((o) => o.status === 'failed');
    if (failed.some((o) => o.retryable)) {
      throw new RetryableProcessingError(failed.map((o) => o.error).join('; '));
    }
    if (failed.length) return { status: 'failed', note: failed.map((o) => o.error).join('; ') };
    return { status: 'done', note: `${rules.length} rule(s) matched` };
  }

  /**
   * AI is best-effort: computed at most once per delivery and cached. If the provider is down we
   * still label / comment / notify, just without the AI summary.
   */
  private async triage(d: DeliveryRow, ctx: EventContext): Promise<AiTriage | null> {
    if (d.ai) return d.ai as unknown as AiTriage;
    if (!this.ai.enabled) return null;
    let result: AiTriage | null = null;
    await this.runner.runOnce({ deliveryId: d.id, userId: null, ruleId: null, type: 'ai' }, async () => {
      result = await this.ai.triage(ctx);
      await this.deliveries.saveAi(d.id, result);
      return { detail: { ...result } };
    });
    return result;
  }

  private async applyRule(
    d: DeliveryRow,
    ctx: EventContext,
    rule: MatchedRule,
    ai: AiTriage | null,
  ): Promise<ActionOutcome[]> {
    const meta = { deliveryId: d.id, userId: rule.user_id, ruleId: rule.id };
    const [owner, repo] = ctx.repoFullName.split('/');
    const outcomes: ActionOutcome[] = [];

    const labels = [...rule.actions.addLabels, ...(rule.actions.applyAiLabel && ai ? [ai.label] : [])];
    if (labels.length && ctx.number !== undefined) {
      outcomes.push(
        await this.runner.runOnce({ ...meta, type: 'label' }, async () => {
          // Adding labels is naturally idempotent on GitHub's side; missing labels are created.
          await this.github.asInstallation(ctx.installationId, `/repos/${owner}/${repo}/issues/${ctx.number}/labels`, {
            method: 'POST',
            body: { labels: [...new Set(labels)] },
          });
          return { detail: { labels } };
        }),
      );
    }

    if (rule.actions.comment) {
      const marker = `abstra-bot:${createHash('sha256')
        .update(actionKey({ ...meta, type: 'comment' }))
        .digest('hex')
        .slice(0, 20)}`;
      let body = renderTemplate(rule.actions.comment, ctx);
      if (rule.actions.ai && ai)
        body += `\n\n> **AI triage** (${ai.priority} priority, suggested \`${ai.label}\`): ${ai.summary}`;
      // Hidden marker lets a retry detect a comment that was posted before a crash.
      body += `\n\n<!-- ${marker} -->`;
      outcomes.push(
        await this.runner.runOnce({ ...meta, type: 'comment' }, async (attempt) => {
          const path =
            ctx.number !== undefined
              ? `/repos/${owner}/${repo}/issues/${ctx.number}/comments`
              : `/repos/${owner}/${repo}/commits/${ctx.headSha}/comments`;
          if (attempt > 1) {
            const existing = await this.github.asInstallation<{ id: number; body: string }[]>(
              ctx.installationId,
              `${path}?per_page=100`,
            );
            const found = existing.find((c) => c.body?.includes(marker));
            if (found) return { detail: { commentId: found.id, recovered: true } };
          }
          const created = await this.github.asInstallation<{ id: number; html_url: string }>(ctx.installationId, path, {
            method: 'POST',
            body: { body },
          });
          return { detail: { commentId: created.id, url: created.html_url } };
        }),
      );
    }

    if (rule.actions.slack) {
      outcomes.push(
        await this.runner.runOnce({ ...meta, type: 'slack' }, async () => {
          if (!rule.slack_webhook_enc) return { skipped: 'Slack is not configured in Settings' };
          const url = this.crypto.decrypt(rule.slack_webhook_enc);
          const { text, blocks } = this.slackMessage(ctx, rule.name, ai, labels);
          await this.slack.send(url, text, blocks);
          return { detail: { rule: rule.name } };
        }),
      );
    }

    log.info('rule.applied', { deliveryId: d.id, ruleId: rule.id, outcomes: outcomes.map((o) => o.status) });
    return outcomes;
  }

  private slackMessage(ctx: EventContext, ruleName: string, ai: AiTriage | null, labels: string[]) {
    const kind = ctx.event === 'issues' ? 'Issue' : ctx.event === 'pull_request' ? 'Pull request' : 'Push';
    const ref = ctx.number !== undefined ? ` #${ctx.number}` : ctx.branch ? ` to \`${slackEscape(ctx.branch)}\`` : '';
    const title = slackEscape(ctx.title.split('\n')[0].slice(0, 150));
    const text = `${kind}${ref} in ${ctx.repoFullName}: ${ctx.title.split('\n')[0].slice(0, 150)}`;
    const lines = [
      `*${kind}${ref}* in *${slackEscape(ctx.repoFullName)}* by ${slackEscape(ctx.author)}`,
      `<${ctx.url}|${title || 'View on GitHub'}>`,
      `Rule: _${slackEscape(ruleName)}_${labels.length ? ` · Labels: ${labels.map((l) => `\`${slackEscape(l)}\``).join(' ')}` : ''}`,
    ];
    if (ai)
      lines.push(`:robot_face: *${ai.priority}* priority · suggested \`${ai.label}\` — ${slackEscape(ai.summary)}`);
    return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }] };
  }

  private async onInstallation(p: Record<string, any>): Promise<ProcessResult> {
    const id = Number(p.installation?.id);
    switch (p.action) {
      case 'created':
      case 'new_permissions_accepted':
      case 'unsuspend': {
        await this.installations.upsertInstallation(p.installation);
        // Whoever installed the app gets access, if they have signed in before.
        const user = await this.db.one<{ id: string }>(`SELECT id FROM users WHERE github_id = $1`, [p.sender?.id]);
        if (user) await this.installations.linkUser(user.id, id);
        if (Array.isArray(p.repositories)) await this.installations.upsertRepos(id, p.repositories);
        return { status: 'done', note: `Installation ${p.action}` };
      }
      case 'deleted':
        await this.installations.markDeleted(id);
        return { status: 'done', note: 'Installation deleted' };
      case 'suspend':
        await this.installations.setSuspended(id, true);
        return { status: 'done', note: 'Installation suspended' };
      default:
        return { status: 'ignored' };
    }
  }

  private async onInstallationRepositories(p: Record<string, any>): Promise<ProcessResult> {
    const id = Number(p.installation?.id);
    await this.installations.upsertInstallation(p.installation);
    await this.installations.upsertRepos(id, p.repositories_added ?? []);
    await this.installations.markReposRemoved((p.repositories_removed ?? []).map((r: { id: number }) => r.id));
    return { status: 'done', note: 'Repository access updated' };
  }
}
