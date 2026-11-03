import { loadEnv } from '../config/env';
export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** 5xx, network errors and rate limits are worth retrying later; other 4xx are not. */
    readonly retryable = true,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  token: string;
  /** In-call retries for transient failures. The worker adds slower retries on top of this. */
  retries?: number;
}

const apiBase = () => loadEnv().GITHUB_API_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function githubRequest<T>(path: string, opts: RequestOptions): Promise<T> {
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(path.startsWith('http') ? path : `${apiBase()}${path}`, {
        method: opts.method ?? 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${opts.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'abstra-github-bot',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // Network error / timeout: retry, then surface as a retryable failure.
      if (attempt < retries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw new GitHubApiError(599, `GitHub request failed: ${(err as Error).message}`);
    }

    if (res.ok) {
      return (res.status === 204 ? undefined : await res.json()) as T;
    }

    const text = await res.text();
    // 403 is only transient when it's a rate limit; a permissions 403 should fail fast.
    const rateLimited = res.status === 429 || (res.status === 403 && /rate limit/i.test(text));
    const transient = res.status >= 500 || rateLimited;
    const error = new GitHubApiError(
      res.status,
      `GitHub ${opts.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 300)}`,
      transient,
    );
    if (!transient || attempt >= retries) throw error;

    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 500 * 2 ** attempt);
  }
}
