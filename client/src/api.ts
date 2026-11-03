export type DeliveryStatus = 'pending' | 'processing' | 'retrying' | 'done' | 'ignored' | 'failed' | 'dead';
export type RuleEvent = 'issues' | 'pull_request' | 'push';

export interface Me {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  slackConfigured: boolean;
  installUrl: string;
  aiEnabled: boolean;
}

export interface AiTriage {
  summary: string;
  label: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  model: string;
}

export interface ActionLog {
  id: string;
  type: 'label' | 'comment' | 'slack' | 'ai';
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  attempts: number;
  error: string | null;
  detail: Record<string, unknown> | null;
  rule: string | null;
  updatedAt: string;
}

export interface EventItem {
  id: string;
  event: string;
  action: string | null;
  repo: string | null;
  summary: string | null;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  ai: AiTriage | null;
  receivedAt: string;
  processedAt: string | null;
  nextAttemptAt: string;
  actions: ActionLog[];
}

export interface Stats {
  deliveries: Partial<Record<DeliveryStatus, number>>;
  actions: Partial<Record<ActionLog['status'], number>>;
}

export interface Repo {
  id: string;
  fullName: string;
  private: boolean;
  account: string;
  suspended: boolean;
  connected: boolean;
}

export interface RuleConditions {
  keywords: string[];
  bodyKeywords: string[];
  authors: string[];
  labels: string[];
  branches: string[];
}

export interface RuleActions {
  addLabels: string[];
  comment: string | null;
  slack: boolean;
  ai: boolean;
  applyAiLabel: boolean;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  event: RuleEvent;
  repoId: string | null;
  repoFullName: string | null;
  conditions: RuleConditions;
  actions: RuleActions;
}

export type RuleInput = Omit<Rule, 'id' | 'repoFullName'>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { message?: unknown; issues?: { path: string; message: string }[] } | null;
    const detail = data?.issues?.map((i) => `${i.path}: ${i.message}`).join(', ');
    const message = detail || (typeof data?.message === 'string' ? data.message : `Request failed (${res.status})`);
    throw new ApiError(res.status, message);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
