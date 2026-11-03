import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Alert, Badge, Button, Card, PageHeader } from '../components/ui';

export function SettingsPage() {
  const { me, refresh } = useAuth();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);

  async function run(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      await refresh();
      setMessage({ tone: 'green', text: success });
    } catch (err) {
      setMessage({ tone: 'red', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api('/api/settings/slack', { method: 'PUT', body: { webhookUrl: url.trim() } });
      setUrl('');
    }, 'Slack webhook saved.');
  }

  if (!me) return null;

  return (
    <div className="max-w-2xl">
      <PageHeader title="Settings" />

      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-medium">Slack notifications</h2>
            <p className="mt-1 text-sm text-slate-500">
              Create an{' '}
              <a
                className="text-indigo-600 hover:underline"
                href="https://api.slack.com/messaging/webhooks"
                target="_blank"
                rel="noreferrer"
              >
                Incoming Webhook
              </a>{' '}
              for the channel you want alerts in and paste its URL. It is encrypted at rest and never shown again.
            </p>
          </div>
          {me.slackConfigured ? <Badge tone="green">configured</Badge> : <Badge>not set</Badge>}
        </div>

        <form onSubmit={save} className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            type="password"
            autoComplete="off"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={me.slackConfigured ? 'Paste a new URL to replace the current one' : 'https://hooks.slack.com/services/…'}
            className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none"
          />
          <Button variant="primary" type="submit" disabled={busy || !url.trim()}>
            Save
          </Button>
        </form>

        {me.slackConfigured && (
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => void run(() => api('/api/settings/slack/test', { method: 'POST' }), 'Test message sent. Check your Slack channel.')}>
              Send test message
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => void run(() => api('/api/settings/slack', { method: 'PUT', body: { webhookUrl: null } }), 'Slack disconnected.')}
            >
              Remove
            </Button>
          </div>
        )}

        {message && (
          <div className="mt-4">
            <Alert tone={message.tone}>{message.text}</Alert>
          </div>
        )}
      </Card>

      <Card className="mt-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-medium">AI triage</h2>
            <p className="mt-1 text-sm text-slate-500">
              Summarises issues and PRs, suggests a label and a priority. Enable it per rule. Runs on Groq's free tier,
              configured by the server operator.
            </p>
          </div>
          {me.aiEnabled ? <Badge tone="green">available</Badge> : <Badge tone="amber">not configured</Badge>}
        </div>
      </Card>
    </div>
  );
}
