import { Injectable } from '@nestjs/common';

export class SlackError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export const SLACK_WEBHOOK_PATTERN = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]+$/;

/** Slack mrkdwn needs &, < and > escaped so user-controlled text can't inject links or mentions. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

@Injectable()
export class SlackService {
  async send(webhookUrl: string, text: string, blocks?: unknown[]): Promise<void> {
    if (!SLACK_WEBHOOK_PATTERN.test(webhookUrl))
      throw new SlackError('Slack webhook URL is not a hooks.slack.com URL', false);
    let res: Response;
    try {
      res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, blocks }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new SlackError(`Slack request failed: ${(err as Error).message}`, true);
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      // 4xx from Slack (invalid_token, no_service, channel_not_found...) won't fix itself.
      throw new SlackError(`Slack returned ${res.status}: ${body}`, res.status === 429 || res.status >= 500);
    }
  }
}
