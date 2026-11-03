import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service';

/** Authorization checks: a user only ever sees installations GitHub told us they can access. */
@Injectable()
export class AccessService {
  constructor(private readonly db: DbService) {}

  async canSeeInstallation(userId: string, installationId: number): Promise<boolean> {
    const row = await this.db.one(`SELECT 1 FROM user_installations WHERE user_id = $1 AND installation_id = $2`, [
      userId,
      installationId,
    ]);
    return row !== null;
  }

  async assertRepo(userId: string, repoId: string | number): Promise<void> {
    const row = await this.db.one(
      `SELECT 1 FROM repositories r
       JOIN user_installations ui ON ui.installation_id = r.installation_id AND ui.user_id = $1
       WHERE r.id = $2 AND r.removed_at IS NULL`,
      [userId, repoId],
    );
    if (!row) throw new NotFoundException('Repository not found');
  }

  async assertDelivery(userId: string, deliveryId: string): Promise<void> {
    const row = await this.db.one(
      `SELECT 1 FROM deliveries d
       JOIN user_installations ui ON ui.installation_id = d.installation_id AND ui.user_id = $1
       WHERE d.id = $2`,
      [userId, deliveryId],
    );
    if (!row) throw new NotFoundException('Event not found');
  }
}
