import { useCallback, useEffect, useState } from 'react';
import { api, type Repo } from '../api';
import { useAuth } from '../auth';
import { Alert, Badge, Button, buttonClass, Card, PageHeader, Toggle } from '../components/ui';

export function ReposPage() {
  const { me } = useAuth();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      setRepos(await api<Repo[]>('/api/repos'));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function sync() {
    setSyncing(true);
    setError(null);
    try {
      const res = await api<{ ok: boolean; errors: string[] }>('/api/repos/sync', { method: 'POST' });
      if (!res.ok) setError(res.errors.join('; '));
      await load();
    } finally {
      setSyncing(false);
    }
  }

  async function setConnected(repo: Repo, connected: boolean) {
    setRepos((rs) => rs?.map((r) => (r.id === repo.id ? { ...r, connected } : r)) ?? null);
    try {
      await api(`/api/repos/${repo.id}/connection`, { method: 'PUT', body: { connected } });
    } catch (err) {
      setError((err as Error).message);
      await load();
    }
  }

  return (
    <div>
      <PageHeader
        title="Repositories"
        description="Repositories the GitHub App can access. The bot only acts on repositories you connect."
        actions={
          <>
            <Button disabled={syncing} onClick={() => void sync()}>
              {syncing ? 'Refreshing…' : 'Refresh from GitHub'}
            </Button>
            {me && (
              <a href={me.installUrl} className={buttonClass('primary')}>
                Add repositories on GitHub
              </a>
            )}
          </>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}

      {repos === null ? (
        <p className="py-10 text-center text-sm text-slate-500">Loading…</p>
      ) : repos.length === 0 ? (
        <Card className="px-6 py-14 text-center">
          <h3 className="font-medium">No repositories yet</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
            Install the GitHub App and choose which repositories it can see. You'll come back here automatically
            afterwards.
          </p>
          {me && (
            <a href={me.installUrl} className={buttonClass('primary', 'mt-5')}>
              Install the GitHub App
            </a>
          )}
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {repos.map((r) => (
              <li key={r.id} className="flex items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <a
                      href={`https://github.com/${r.fullName}`}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate font-medium hover:underline"
                    >
                      {r.fullName}
                    </a>
                    {r.private && <Badge>private</Badge>}
                    {r.suspended && <Badge tone="amber">suspended</Badge>}
                  </div>
                  <p className="text-xs text-slate-500">via installation on {r.account}</p>
                </div>
                <span className="hidden text-sm text-slate-500 sm:inline">{r.connected ? 'Connected' : 'Not connected'}</span>
                <Toggle
                  checked={r.connected}
                  onChange={(v) => void setConnected(r, v)}
                  label={`Connect ${r.fullName}`}
                />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
