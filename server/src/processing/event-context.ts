/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- GitHub webhook payloads are untyped JSON */
import type { EventContext } from '../rules/rule.types';

/** Event/action pairs the bot reacts to. Everything else is recorded but ignored. */
export function isActionable(event: string, action: string | null): boolean {
  if (event === 'push') return true;
  if (event === 'issues') return action === 'opened' || action === 'reopened';
  if (event === 'pull_request') return action === 'opened' || action === 'reopened' || action === 'ready_for_review';
  return false;
}

export function toEventContext(event: string, p: Record<string, any>): EventContext | null {
  const base = {
    installationId: Number(p.installation?.id),
    repoId: Number(p.repository?.id),
    repoFullName: String(p.repository?.full_name ?? ''),
  };
  if (!base.installationId || !base.repoId) return null;

  if (event === 'issues' && p.issue) {
    return {
      ...base,
      event: 'issues',
      number: p.issue.number,
      title: p.issue.title ?? '',
      body: p.issue.body ?? '',
      author: p.issue.user?.login ?? '',
      labels: (p.issue.labels ?? []).map((l: { name: string }) => l.name),
      url: p.issue.html_url,
    };
  }
  if (event === 'pull_request' && p.pull_request) {
    const pr = p.pull_request;
    return {
      ...base,
      event: 'pull_request',
      number: pr.number,
      title: pr.title ?? '',
      body: pr.body ?? '',
      author: pr.user?.login ?? '',
      labels: (pr.labels ?? []).map((l: { name: string }) => l.name),
      branch: pr.base?.ref,
      url: pr.html_url,
    };
  }
  if (event === 'push') {
    // Branch deletions have no head commit and nothing to act on.
    if (p.deleted || !p.head_commit) return null;
    const commits: { message: string }[] = p.commits ?? [];
    return {
      ...base,
      event: 'push',
      title: commits.map((c) => c.message).join('\n') || p.head_commit.message || '',
      body: '',
      author: p.pusher?.name ?? p.sender?.login ?? '',
      labels: [],
      branch: String(p.ref ?? '').replace(/^refs\/heads\//, ''),
      url: p.compare ?? p.head_commit.url,
      headSha: p.head_commit.id,
    };
  }
  return null;
}
