import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { loadEnv } from '../config/env';

/** AES-256-GCM for secrets stored in the database. Format: v1.<iv>.<tag>.<ciphertext> (base64url). */
@Injectable()
export class CryptoService {
  private readonly key = Buffer.from(loadEnv().ENCRYPTION_KEY, 'base64');

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv, tag, ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, ct] = payload.split('.');
    if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognized ciphertext format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
}
