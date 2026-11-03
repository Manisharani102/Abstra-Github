import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { GitHubAppService } from './github-app.service';

/** Keeps the local mirror of installations / repositories in sync with GitHub. */
@Injectable()
export class InstallationsService {
  constructor(
    private readonly db: DbService,
    private readonly app: GitHubAppService,
  ) {}

  async upsertInstallation(inst: {
    id: number;
    account: { login: string; type: string };
    suspended_at?: string | null;
  }) {
    await this.db.query(
      `INSERT INTO installations (id, account_login, account_type, suspended, deleted_at)
       VALUES ($1, $2, $3, $4, NULL)
       ON CONFLICT (id) DO UPDATE SET account_login = EXCLUDED.account_login, account_type = EXCLUDED.account_type,
         suspended = EXCLUDED.suspended, deleted_at = NULL`,
      [inst.id, inst.account.login, inst.account.type, Boolean(inst.suspended_at)],
    );
  }

  async linkUser(userId: string, installationId: number) {
    await this.db.query(
      `INSERT INTO user_installations (user_id, installation_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, installationId],
    );
  }

  /** Replaces the user's installation links with exactly the set GitHub says they can access. */
  async setUserInstallations(userId: string, installationIds: number[]) {
    await this.db.query(
      `DELETE FROM user_installations WHERE user_id = $1 AND NOT (installation_id = ANY($2::bigint[]))`,
      [userId, installationIds],
    );
    for (const id of installationIds) await this.linkUser(userId, id);
  }

  async upsertRepos(installationId: number, repos: { id: number; full_name: string; private: boolean }[]) {
    for (const r of repos) {
      await this.db.query(
        `INSERT INTO repositories (id, installation_id, full_name, private, removed_at)
         VALUES ($1, $2, $3, $4, NULL)
         ON CONFLICT (id) DO UPDATE SET installation_id = EXCLUDED.installation_id, full_name = EXCLUDED.full_name,
           private = EXCLUDED.private, removed_at = NULL`,
        [r.id, installationId, r.full_name, r.private],
      );
    }
  }

  async markReposRemoved(repoIds: number[]) {
    if (repoIds.length === 0) return;
    await this.db.query(`UPDATE repositories SET removed_at = now() WHERE id = ANY($1::bigint[])`, [repoIds]);
  }

  /** Full refresh of one installation's repository list using an installation token. */
  async syncRepos(installationId: number) {
    const repos = await this.app.listInstallationRepos(installationId);
    await this.upsertRepos(installationId, repos);
    await this.db.query(
      `UPDATE repositories SET removed_at = now() WHERE installation_id = $1 AND removed_at IS NULL AND NOT (id = ANY($2::bigint[]))`,
      [installationId, repos.map((r) => r.id)],
    );
  }

  async markDeleted(installationId: number) {
    await this.db.query(`UPDATE installations SET deleted_at = now() WHERE id = $1`, [installationId]);
  }

  async setSuspended(installationId: number, suspended: boolean) {
    await this.db.query(`UPDATE installations SET suspended = $2 WHERE id = $1`, [installationId, suspended]);
  }
}
