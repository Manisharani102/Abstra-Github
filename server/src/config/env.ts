import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  // Public base URL of the deployed app, e.g. https://abstra-bot.onrender.com
  APP_URL: z.url(),
  DATABASE_URL: z.string().min(1),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 chars'),
  // 32 random bytes, base64-encoded. Used to encrypt secrets at rest (Slack webhook URLs).
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes, base64-encoded'),

  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_SLUG: z.string().min(1),
  // PEM contents. Either literal (newlines may be escaped as \n) or base64 of the PEM file.
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(16, 'GITHUB_WEBHOOK_SECRET must be at least 16 chars'),
  // Override only for GitHub Enterprise or a local mock in tests.
  GITHUB_API_URL: z
    .url()
    .default('https://api.github.com')
    .transform((u) => u.replace(/\/$/, '')),

  // Optional AI triage (free tier, no card). Leave empty to disable the AI step.
  GROQ_API_KEY: z.string().optional().default(''),
  GROQ_MODEL: z.string().default('openai/gpt-oss-20b'),
});

export type Env = z.infer<typeof schema> & { githubPrivateKeyPem: string; isProd: boolean };

function decodePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('-----BEGIN')) return trimmed.replace(/\\n/g, '\n');
  return Buffer.from(trimmed, 'base64').toString('utf8');
}

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Only print variable names and messages, never values.
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const env = parsed.data;
  cached = {
    ...env,
    APP_URL: env.APP_URL.replace(/\/$/, ''),
    githubPrivateKeyPem: decodePrivateKey(env.GITHUB_APP_PRIVATE_KEY),
    isProd: env.NODE_ENV === 'production',
  };
  return cached;
}
