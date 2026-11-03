import { Injectable, UnauthorizedException } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { DbService } from '../db/db.service';
import { githubRequest } from '../github/github-api';
import { InstallationsService } from '../github/installations.service';
import { AppLogger, errorMessage } from '../common/logger';
import type { SessionUser } from './session';

const log = new AppLogger('auth');

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

interface UserInstallation {
  id: number;
  account: { login: string; type: string };
  suspended_at: string | null;
}

@Injectable()
export class AuthService {
  private readonly env = loadEnv();

  constructor(
    private readonly db: DbService,
    private readonly installations: InstallationsService,
  ) {}

  /**
   * Exchanges the OAuth code, identifies the user, and records which app installations they can
   * access according to GitHub. The user token is used only here and never stored.
   */
  async completeLogin(code: string): Promise<SessionUser> {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.env.GITHUB_CLIENT_ID,
        client_secret: this.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${this.env.APP_URL}/api/auth/callback`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenJson.access_token)
      throw new UnauthorizedException(`OAuth exchange failed: ${tokenJson.error ?? tokenRes.status}`);
    const userToken = tokenJson.access_token;

    const gh = await githubRequest<GitHubUser>('/user', { token: userToken });
    const user = await this.db.one<{ id: string; login: string }>(
      `INSERT INTO users (github_id, login, name, avatar_url) VALUES ($1, $2, $3, $4)
       ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login, name = EXCLUDED.name,
         avatar_url = EXCLUDED.avatar_url, updated_at = now()
       RETURNING id, login`,
      [gh.id, gh.login, gh.name, gh.avatar_url],
    );

    await this.syncUserInstallations(user!.id, userToken);
    return { id: user!.id, login: user!.login };
  }

  private async syncUserInstallations(userId: string, userToken: string) {
    const res = await githubRequest<{ installations: UserInstallation[] }>('/user/installations?per_page=100', {
      token: userToken,
    });
    for (const inst of res.installations) await this.installations.upsertInstallation(inst);
    await this.installations.setUserInstallations(
      userId,
      res.installations.map((i) => i.id),
    );
    // Repo sync failures shouldn't block login; the Repositories page can retry.
    for (const inst of res.installations) {
      try {
        await this.installations.syncRepos(inst.id);
      } catch (err) {
        log.warn('repo_sync.failed', { installationId: inst.id, error: errorMessage(err) });
      }
    }
  }

  async profile(userId: string) {
    const row = await this.db.one<{
      login: string;
      name: string | null;
      avatar_url: string | null;
      slack_configured: boolean;
    }>(`SELECT login, name, avatar_url, slack_webhook_enc IS NOT NULL AS slack_configured FROM users WHERE id = $1`, [
      userId,
    ]);
    if (!row) throw new UnauthorizedException();
    return {
      login: row.login,
      name: row.name,
      avatarUrl: row.avatar_url,
      slackConfigured: row.slack_configured,
      installUrl: `https://github.com/apps/${this.env.GITHUB_APP_SLUG}/installations/new`,
      aiEnabled: Boolean(this.env.GROQ_API_KEY),
    };
  }
}
