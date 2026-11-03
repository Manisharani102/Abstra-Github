import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api, type Repo, type Rule, type RuleEvent, type RuleInput } from '../api';
import { useAuth } from '../auth';
import { Alert, Badge, Button, Card, PageHeader, Toggle } from '../components/ui';

const EVENT_LABEL: Record<RuleEvent, string> = {
  issues: 'Issue opened',
  pull_request: 'Pull request opened',
  push: 'Code pushed',
};

const EMPTY: RuleInput = {
  name: '',
  enabled: true,
  event: 'issues',
  repoId: null,
  conditions: { keywords: [], bodyKeywords: [], authors: [], labels: [], branches: [] },
  actions: { addLabels: [], comment: null, slack: true, ai: false, applyAiLabel: false },
};

const TEMPLATES: { label: string; rule: RuleInput }[] = [
  {
    label: 'Bug reports → label + Slack',
    rule: {
      ...EMPTY,
      name: 'Label bug reports',
      conditions: { ...EMPTY.conditions, keywords: ['bug', 'crash', 'error'] },
      actions: { ...EMPTY.actions, addLabels: ['bug'], slack: true },
    },
  },
  {
    label: 'Welcome every new PR (AI summary)',
    rule: {
      ...EMPTY,
      name: 'Thank PR authors',
      event: 'pull_request',
      actions: {
        ...EMPTY.actions,
        comment: 'Thanks @{{author}} for opening this PR! A maintainer will review it soon.',
        ai: true,
        slack: true,
      },
    },
  },
  {
    label: 'Pushes to main → Slack',
    rule: {
      ...EMPTY,
      name: 'Notify on main',
      event: 'push',
      conditions: { ...EMPTY.conditions, branches: ['main'] },
      actions: { ...EMPTY.actions, slack: true },
    },
  },
];

const toList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export function RulesPage() {
  const { me } = useAuth();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; input: RuleInput } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, rp] = await Promise.all([api<Rule[]>('/api/rules'), api<Repo[]>('/api/repos')]);
      setRules(r);
      setRepos(rp);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(rule: Rule, enabled: boolean) {
    const { id, repoFullName: _, ...input } = rule;
    await api(`/api/rules/${id}`, { method: 'PUT', body: { ...input, enabled } });
    await load();
  }

  async function remove(rule: Rule) {
    if (!confirm(`Delete rule “${rule.name}”?`)) return;
    await api(`/api/rules/${rule.id}`, { method: 'DELETE' });
    await load();
  }

  const connected = repos.filter((r) => r.connected);

  return (
    <div>
      <PageHeader
        title="Rules"
        description="When an event matches a rule's conditions, the bot performs its actions."
        actions={
          !editing && (
            <Button variant="primary" onClick={() => setEditing({ id: null, input: EMPTY })}>
              New rule
            </Button>
          )
        }
      />

      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {rules !== null && connected.length === 0 && (
        <div className="mb-4">
          <Alert tone="blue">
            No repositories are connected yet. Rules only run on{' '}
            <Link to="/repos" className="font-medium underline">
              connected repositories
            </Link>
            .
          </Alert>
        </div>
      )}

      {editing && (
        <RuleForm
          key={editing.id ?? 'new'}
          initial={editing.input}
          repos={connected}
          aiEnabled={me?.aiEnabled ?? false}
          slackConfigured={me?.slackConfigured ?? false}
          onCancel={() => setEditing(null)}
          onSave={async (input) => {
            await api(editing.id ? `/api/rules/${editing.id}` : '/api/rules', {
              method: editing.id ? 'PUT' : 'POST',
              body: input,
            });
            setEditing(null);
            await load();
          }}
        />
      )}

      {rules === null ? (
        <p className="py-10 text-center text-sm text-slate-500">Loading…</p>
      ) : rules.length === 0 && !editing ? (
        <Card className="px-6 py-10 text-center">
          <h3 className="font-medium">No rules yet</h3>
          <p className="mt-2 text-sm text-slate-500">Start from a template or create your own.</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {TEMPLATES.map((t) => (
              <Button key={t.label} onClick={() => setEditing({ id: null, input: t.rule })}>
                {t.label}
              </Button>
            ))}
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {rules.map((r) => (
            <Card key={r.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <Toggle checked={r.enabled} onChange={(v) => void toggle(r, v)} label={`Enable ${r.name}`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.name}</span>
                  <Badge tone="violet">{EVENT_LABEL[r.event]}</Badge>
                  <Badge>{r.repoFullName ?? 'all connected repos'}</Badge>
                </div>
                <p className="mt-1 text-sm text-slate-500">{describeRule(r)}</p>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    const { id, repoFullName: _, ...input } = r;
                    setEditing({ id, input });
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                >
                  Edit
                </Button>
                <Button variant="danger" onClick={() => void remove(r)}>
                  Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function describeRule(r: Rule): string {
  const c = r.conditions;
  const when: string[] = [];
  if (c.keywords.length) when.push(`${r.event === 'push' ? 'commit message' : 'title'} contains ${c.keywords.join(' / ')}`);
  if (c.bodyKeywords.length) when.push(`body contains ${c.bodyKeywords.join(' / ')}`);
  if (c.authors.length) when.push(`author is ${c.authors.join(' / ')}`);
  if (c.labels.length) when.push(`labelled ${c.labels.join(' / ')}`);
  if (c.branches.length) when.push(`branch is ${c.branches.join(' / ')}`);
  const then: string[] = [];
  if (r.actions.addLabels.length) then.push(`add ${r.actions.addLabels.join(', ')}`);
  if (r.actions.applyAiLabel) then.push('apply AI label');
  if (r.actions.comment) then.push('comment');
  if (r.actions.ai) then.push('AI summary');
  if (r.actions.slack) then.push('Slack alert');
  return `${when.length ? `If ${when.join(' and ')}` : 'Always'} → ${then.join(', ') || 'record only'}`;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none';

function Check({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={`flex items-start gap-2 ${disabled ? 'opacity-50' : ''}`}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-indigo-600" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="text-sm font-medium text-slate-700">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

function RuleForm({
  initial,
  repos,
  aiEnabled,
  slackConfigured,
  onSave,
  onCancel,
}: {
  initial: RuleInput;
  repos: Repo[];
  aiEnabled: boolean;
  slackConfigured: boolean;
  onSave: (input: RuleInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [rule, setRule] = useState(initial);
  // Comma-separated text inputs are kept as raw strings while editing.
  const [text, setText] = useState({
    keywords: initial.conditions.keywords.join(', '),
    bodyKeywords: initial.conditions.bodyKeywords.join(', '),
    authors: initial.conditions.authors.join(', '),
    labels: initial.conditions.labels.join(', '),
    branches: initial.conditions.branches.join(', '),
    addLabels: initial.actions.addLabels.join(', '),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isPush = rule.event === 'push';
  const setActions = (patch: Partial<RuleInput['actions']>) => setRule({ ...rule, actions: { ...rule.actions, ...patch } });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave({
        ...rule,
        conditions: {
          keywords: toList(text.keywords),
          bodyKeywords: isPush ? [] : toList(text.bodyKeywords),
          authors: toList(text.authors),
          labels: isPush ? [] : toList(text.labels),
          branches: rule.event === 'issues' ? [] : toList(text.branches),
        },
        actions: {
          ...rule.actions,
          addLabels: isPush ? [] : toList(text.addLabels),
          applyAiLabel: isPush ? false : rule.actions.applyAiLabel,
          comment: rule.actions.comment?.trim() || null,
        },
      });
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <Card className="mb-6 p-5">
      <form onSubmit={(e) => void submit(e)} className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Rule name">
            <input required className={inputClass} value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} />
          </Field>
          <Field label="When">
            <select className={inputClass} value={rule.event} onChange={(e) => setRule({ ...rule, event: e.target.value as RuleEvent })}>
              {Object.entries(EVENT_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="In">
            <select className={inputClass} value={rule.repoId ?? ''} onChange={(e) => setRule({ ...rule, repoId: e.target.value || null })}>
              <option value="">All connected repositories</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullName}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <fieldset>
          <legend className="mb-3 text-xs font-semibold tracking-wide text-slate-500 uppercase">Conditions (leave empty to match everything; comma-separated)</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={isPush ? 'Commit message contains any of' : 'Title contains any of'}>
              <input className={inputClass} placeholder="bug, crash" value={text.keywords} onChange={(e) => setText({ ...text, keywords: e.target.value })} />
            </Field>
            {!isPush && (
              <Field label="Body contains any of">
                <input className={inputClass} placeholder="steps to reproduce" value={text.bodyKeywords} onChange={(e) => setText({ ...text, bodyKeywords: e.target.value })} />
              </Field>
            )}
            <Field label="Author is any of" hint="GitHub usernames">
              <input className={inputClass} placeholder="octocat" value={text.authors} onChange={(e) => setText({ ...text, authors: e.target.value })} />
            </Field>
            {!isPush && (
              <Field label="Already has any label">
                <input className={inputClass} placeholder="needs-triage" value={text.labels} onChange={(e) => setText({ ...text, labels: e.target.value })} />
              </Field>
            )}
            {rule.event !== 'issues' && (
              <Field label={isPush ? 'Branch is any of' : 'Target branch is any of'}>
                <input className={inputClass} placeholder="main" value={text.branches} onChange={(e) => setText({ ...text, branches: e.target.value })} />
              </Field>
            )}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-3 text-xs font-semibold tracking-wide text-slate-500 uppercase">Actions</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            {!isPush && (
              <Field label="Add labels" hint="Labels that don't exist yet are created.">
                <input className={inputClass} placeholder="bug" value={text.addLabels} onChange={(e) => setText({ ...text, addLabels: e.target.value })} />
              </Field>
            )}
            <Field label={isPush ? 'Comment on the head commit' : 'Post a comment'} hint="Placeholders: {{author}} {{title}} {{repo}} {{number}} {{branch}}">
              <textarea
                rows={2}
                className={inputClass}
                placeholder="Thanks @{{author}}!"
                value={rule.actions.comment ?? ''}
                onChange={(e) => setActions({ comment: e.target.value })}
              />
            </Field>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Check
              checked={rule.actions.slack}
              onChange={(slack) => setActions({ slack })}
              label="Send a Slack alert"
              hint={slackConfigured ? undefined : 'Set up Slack in Settings first'}
            />
            <Check
              checked={rule.actions.ai}
              onChange={(ai) => setActions({ ai })}
              disabled={!aiEnabled}
              label="AI summary"
              hint="Add an AI summary + priority to the comment and Slack alert"
            />
            {!isPush && (
              <Check
                checked={rule.actions.applyAiLabel}
                onChange={(applyAiLabel) => setActions({ applyAiLabel })}
                disabled={!aiEnabled}
                label="Apply AI-suggested label"
              />
            )}
          </div>
        </fieldset>

        {error && <Alert>{error}</Alert>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save rule'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
