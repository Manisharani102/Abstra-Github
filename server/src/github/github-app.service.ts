import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { loadEnv } from '../config/env';
import { githubRequest } from './github-api';

interface InstallationToken {
  token: string;
  expiresAt: number;
}

export interface WebhookDeliverySummary {
  id: number;
  guid: string;
  delivered_at: string;
  redelivery: boolean;
  status_code: number;
  event: string;
  action: string | null;
  installation_id: number | null;
}

/**
 * Authenticates as the GitHub App: a short-lived RS256 JWT signed with the app's private key,
 * exchanged for per-installation access tokens (cached until shortly before they expire).
 */
@Injectable()
export class GitHubAppService {
  private readonly env = loadEnv();
  private readonly tokens = new Map<number, InstallationToken>();

  appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    // iat is backdated 60s to tolerate clock drift; GitHub caps exp at 10 minutes.
    return jwt.sign({ iat: now - 60, exp: now + 9 * 60, iss: this.env.GITHUB_APP_ID }, this.env.githubPrivateKeyPem, {
      algorithm: 'RS256',
    });
  }

  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;

    const res = await githubRequest<{ token: string; expires_at: string }>(
      `/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        token: this.appJwt(),
      },
    );
    this.tokens.set(installationId, { token: res.token, expiresAt: new Date(res.expires_at).getTime() });
    return res.token;
  }

  async asInstallation<T>(
    installationId: number,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const token = await this.installationToken(installationId);
    return githubRequest<T>(path, { ...init, token });
  }

  async getInstallation(installationId: number) {
    return githubRequest<{ id: number; account: { login: string; type: string }; suspended_at: string | null }>(
      `/app/installations/${installationId}`,
      { token: this.appJwt() },
    );
  }

  async listInstallationRepos(installationId: number) {
    const repos: { id: number; full_name: string; private: boolean }[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await this.asInstallation<{ repositories: typeof repos }>(
        installationId,
        `/installation/repositories?per_page=100&page=${page}`,
      );
      repos.push(...res.repositories);
      if (res.repositories.length < 100) break;
    }
    return repos;
  }

  /** Recent deliveries of the app's webhook (GitHub keeps ~3 days). Used to recover missed events. */
  async listRecentDeliveries(maxPages = 5): Promise<WebhookDeliverySummary[]> {
    const out: WebhookDeliverySummary[] = [];
    let url: string | null = '/app/hook/deliveries?per_page=100';
    for (let i = 0; i < maxPages && url; i++) {
      const res = await fetch(url.startsWith('http') ? url : `${this.env.GITHUB_API_URL}${url}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.appJwt()}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'abstra-github-bot',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`List deliveries failed: ${res.status}`);
      out.push(...((await res.json()) as WebhookDeliverySummary[]));
      const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '');
      url = next ? next[1] : null;
    }
    return out;
  }

  async redeliver(hookDeliveryId: number): Promise<void> {
    await githubRequest(`/app/hook/deliveries/${hookDeliveryId}/attempts`, { method: 'POST', token: this.appJwt() });
  }
}
