import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, type ActionLog, type DeliveryStatus, type EventItem, type Stats } from '../api';
import { Alert, Badge, Button, Card, cx, PageHeader, timeAgo, type Tone } from '../components/ui';

const STATUS_TONE: Record<DeliveryStatus, Tone> = {
  pending: 'blue',
  processing: 'blue',
  retrying: 'amber',
  done: 'green',
  ignored: 'gray',
  failed: 'red',
  dead: 'red',
};

const ACTION_TONE: Record<ActionLog['status'], Tone> = {
  running: 'blue',
  succeeded: 'green',
  failed: 'red',
  skipped: 'gray',
};

const PRIORITY_TONE = { low: 'gray', medium: 'blue', high: 'amber', critical: 'red' } as const;

const FILTERS = [
  { key: 'all', label: 'All events' },
  { key: 'failed', label: 'Failures & retries' },
  { key: 'active', label: 'In progress' },
];

/** Subscribes to the server's SSE stream; reconnects automatically (EventSource does this natively). */
function useLiveUpdates(onChange: () => void) {
  const [live, setLive] = useState(false);
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    const es = new EventSource('/api/events/stream');
    let timer: ReturnType<typeof setTimeout> | undefined;
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.addEventListener('delivery', () => {
      // Coalesce bursts (a delivery changes status several times in quick succession).
      clearTimeout(timer);
      timer = setTimeout(() => cb.current(), 300);
    });
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, []);
  return live;
}

export function ActivityPage() {
  const [filter, setFilter] = useState('all');
  const [events, setEvents] = useState<EventItem[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, s] = await Promise.all([
        api<EventItem[]>(`/api/events?filter=${filter}&limit=50`),
        api<Stats>('/api/events/stats'),
      ]);
      setEvents(list);
      setHasMore(list.length === 50);
      setStats(s);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [filter]);

  useEffect(() => {
    setEvents(null);
    void load();
  }, [load]);

  const live = useLiveUpdates(() => void load());

  async function loadMore() {
    if (!events?.length) return;
    const before = events[events.length - 1].receivedAt;
    const more = await api<EventItem[]>(`/api/events?filter=${filter}&limit=50&before=${encodeURIComponent(before)}`);
    setEvents([...events, ...more]);
    setHasMore(more.length === 50);
  }

  async function reconcile() {
    setNotice(null);
    try {
      const res = await api<{ redelivered: number }>('/api/events/reconcile', { method: 'POST' });
      setNotice(
        res.redelivered
          ? `Asked GitHub to redeliver ${res.redelivered} missed event(s).`
          : 'No missed deliveries found. GitHub reports everything was received.',
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const d = stats?.deliveries ?? {};
  const a = stats?.actions ?? {};
  const tiles = [
    { label: 'Events (7d)', value: Object.values(d).reduce((x, y) => x + (y ?? 0), 0) },
    { label: 'Processed', value: d.done ?? 0 },
    { label: 'Retrying', value: d.retrying ?? 0, warn: (d.retrying ?? 0) > 0 },
    { label: 'Failed', value: (d.failed ?? 0) + (d.dead ?? 0), bad: (d.failed ?? 0) + (d.dead ?? 0) > 0 },
    { label: 'Bot actions', value: a.succeeded ?? 0 },
  ];

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Every webhook received and everything the bot did about it."
        actions={
          <>
            <span className="inline-flex items-center gap-2 px-2 text-sm text-slate-500">
              <span className={cx('h-2 w-2 rounded-full', live ? 'animate-pulse bg-emerald-500' : 'bg-slate-300')} />
              {live ? 'Live' : 'Connecting…'}
            </span>
            <Button onClick={() => void reconcile()} title="Ask GitHub to redeliver webhooks we never received">
              Recover missed events
            </Button>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {tiles.map((t) => (
          <Card key={t.label} className="px-4 py-3">
            <div className="text-xs font-medium text-slate-500">{t.label}</div>
            <div
              className={cx(
                'mt-1 text-2xl font-semibold tabular-nums',
                t.bad && 'text-rose-600',
                t.warn && 'text-amber-600',
              )}
            >
              {t.value}
            </div>
          </Card>
        ))}
      </div>

      <div className="mb-4 flex gap-1 rounded-lg bg-slate-100 p-1 text-sm sm:w-fit">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cx(
              'flex-1 rounded-md px-3 py-1.5 font-medium',
              filter === f.key ? 'bg-white shadow-sm' : 'text-slate-500 hover:text-slate-800',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {notice && (
        <div className="mb-4">
          <Alert tone="blue">{notice}</Alert>
        </div>
      )}

      {events === null ? (
        <p className="py-10 text-center text-sm text-slate-500">Loading events…</p>
      ) : events.length === 0 ? (
        <EmptyState filtered={filter !== 'all'} />
      ) : (
        <div className="space-y-3">
          {events.map((e) => (
            <EventCard key={e.id} event={e} onRetried={() => void load()} />
          ))}
          {hasMore && (
            <div className="pt-2 text-center">
              <Button onClick={() => void loadMore()}>Load older events</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <Card className="px-6 py-14 text-center">
      <h3 className="font-medium">{filtered ? 'Nothing here' : 'No events yet'}</h3>
      {!filtered && (
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
          Install the app on a repository, <Link to="/repos" className="text-indigo-600 hover:underline">connect it</Link>,
          add a <Link to="/rules" className="text-indigo-600 hover:underline">rule</Link>, then open an issue or pull
          request. It will show up here within seconds.
        </p>
      )}
    </Card>
  );
}

function EventCard({ event: e, onRetried }: { event: EventItem; onRetried: () => void }) {
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const failedActions = e.actions.filter((a) => a.status === 'failed').length;
  const canRetry = ['failed', 'dead', 'retrying'].includes(e.status);

  async function retry() {
    setRetrying(true);
    try {
      await api(`/api/events/${e.id}/retry`, { method: 'POST' });
      onRetried();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <button className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50" onClick={() => setOpen(!open)}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[e.status]}>{e.status}</Badge>
            <Badge tone="violet">
              {e.event}
              {e.action ? `.${e.action}` : ''}
            </Badge>
            {e.ai && <Badge tone={PRIORITY_TONE[e.ai.priority]}>AI: {e.ai.priority}</Badge>}
            {e.actions.filter((a) => a.type !== 'ai').length > 0 && (
              <span className="text-xs text-slate-500">
                {e.actions.filter((a) => a.status === 'succeeded' && a.type !== 'ai').length} action(s) done
                {failedActions > 0 && <span className="text-rose-600"> · {failedActions} failed</span>}
              </span>
            )}
          </div>
          <p className="mt-1.5 truncate text-sm font-medium">{e.summary}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            {e.repo ?? 'app-level event'} · {timeAgo(e.receivedAt)}
            {e.attempts > 1 && ` · attempt ${e.attempts}`}
            {e.status === 'retrying' && ` · next retry ${timeAgo(e.nextAttemptAt)}`}
          </p>
        </div>
        <span className={cx('mt-1 text-slate-400 transition', open && 'rotate-90')}>›</span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-slate-100 bg-slate-50/60 px-4 py-4 text-sm">
          {e.lastError && (
            <div>
              <div className="mb-1 text-xs font-medium tracking-wide text-slate-500 uppercase">
                {e.status === 'done' || e.status === 'ignored' ? 'Note' : 'Last error'}
              </div>
              <p className={cx('font-mono text-xs break-words', e.status === 'done' || e.status === 'ignored' ? 'text-slate-600' : 'text-rose-700')}>
                {e.lastError}
              </p>
            </div>
          )}

          {e.ai && (
            <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
              <div className="mb-1 flex items-center gap-2 text-xs font-medium text-slate-500">
                AI triage <Badge tone={PRIORITY_TONE[e.ai.priority]}>{e.ai.priority}</Badge>
                <Badge>suggests: {e.ai.label}</Badge>
              </div>
              <p className="text-slate-700">{e.ai.summary}</p>
              <p className="mt-1 text-xs text-slate-400">{e.ai.model}</p>
            </div>
          )}

          <div>
            <div className="mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase">Bot actions</div>
            {e.actions.length === 0 ? (
              <p className="text-slate-500">No actions taken.</p>
            ) : (
              <ul className="divide-y divide-slate-200 rounded-lg bg-white ring-1 ring-slate-200">
                {e.actions.map((a) => (
                  <li key={a.id} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
                    <div className="flex items-center gap-2">
                      <Badge tone={ACTION_TONE[a.status]}>{a.status}</Badge>
                      <span className="font-medium">{a.type}</span>
                    </div>
                    <span className="flex-1 truncate text-slate-500">
                      {describeAction(a)}
                      {a.rule && <span className="text-slate-400"> · rule “{a.rule}”</span>}
                    </span>
                    <span className="text-xs text-slate-400">
                      {a.attempts > 1 && `${a.attempts} attempts · `}
                      {timeAgo(a.updatedAt)}
                    </span>
                    {a.error && <p className="w-full font-mono text-xs text-rose-700 sm:basis-full">{a.error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-xs text-slate-400">delivery {e.id}</span>
            {canRetry && (
              <Button variant="primary" disabled={retrying} onClick={() => void retry()}>
                {retrying ? 'Queuing…' : 'Retry now'}
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function describeAction(a: ActionLog): string {
  const d = a.detail ?? {};
  if (a.status === 'skipped' && typeof d.reason === 'string') return d.reason;
  switch (a.type) {
    case 'label':
      return Array.isArray(d.labels) ? `added ${d.labels.join(', ')}` : 'add labels';
    case 'comment':
      return d.recovered ? 'comment found from an earlier attempt' : 'posted a comment';
    case 'slack':
      return 'sent Slack notification';
    case 'ai':
      return 'AI triage';
  }
}
