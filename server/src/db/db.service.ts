import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { loadEnv } from '../config/env';
import { AppLogger } from '../common/logger';

const log = new AppLogger('db');

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  readonly pool: Pool;

  constructor() {
    const env = loadEnv();
    const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(env.DATABASE_URL);
    this.pool = new Pool({
      connectionString: env.DATABASE_URL,
      // Supabase requires TLS; its pooler cert chain isn't in Node's default store.
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
      max: 5,
    });
    this.pool.on('error', (err) => log.error('pool.error', { err }));
  }

  async onModuleInit() {
    await this.migrate();
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query<T>(sql, params);
    return res.rows;
  }

  async one<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Applies any `migrations/*.sql` file not yet recorded, in filename order, each in a transaction. */
  private async migrate() {
    // Migrations live next to the compiled code (copied by nest-cli assets).
    const dir = join(__dirname, 'migrations');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    await this.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const applied = new Set(
      (await this.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name),
    );
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(dir, file), 'utf8');
      await this.tx(async (c) => {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      });
      log.info('migration.applied', { file });
    }
  }
}
