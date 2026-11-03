import { Navigate, useSearchParams } from 'react-router';
import { useAuth } from '../auth';
import { Logo } from '../components/Layout';
import { Alert } from '../components/ui';

const ERRORS: Record<string, string> = {
  state: 'Your sign-in session expired or was tampered with. Please try again.',
  github: 'GitHub sign-in failed. Please try again.',
};

const steps = [
  ['Sign in & install', 'Sign in with GitHub and install the app on the repositories you want automated.'],
  ['Write rules', 'e.g. issues whose title contains "bug" → add the bug label and alert Slack.'],
  ['Watch it work', 'Every webhook, AI triage and action shows up live, including failures and retries.'],
];

export function LoginPage() {
  const { me, loading } = useAuth();
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/';
  const error = params.get('error');

  if (!loading && me) return <Navigate to={next} replace />;

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-indigo-50 via-white to-white">
      <header className="mx-auto w-full max-w-5xl px-4 py-5">
        <Logo />
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center px-4 pt-12 pb-20 text-center">
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
          Your GitHub repos, on <span className="text-indigo-600">autopilot</span>.
        </h1>
        <p className="mt-4 max-w-xl text-lg text-slate-600">
          React to new issues, pull requests and pushes: label them, comment, triage with AI and notify Slack, using
          rules you configure.
        </p>
        {error && (
          <div className="mt-6 w-full max-w-md">
            <Alert>{ERRORS[error] ?? 'Sign-in failed.'}</Alert>
          </div>
        )}
        <a
          href={`/api/auth/login?next=${encodeURIComponent(next)}`}
          className="mt-8 inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-3 font-medium text-white shadow-lg hover:bg-slate-800"
        >
          <svg viewBox="0 0 16 16" className="h-5 w-5" fill="currentColor" aria-hidden>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          Sign in with GitHub
        </a>
        <div className="mt-16 grid w-full gap-4 text-left sm:grid-cols-3">
          {steps.map(([title, body], i) => (
            <div key={title} className="rounded-xl bg-white p-5 ring-1 ring-slate-200">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700">
                {i + 1}
              </div>
              <h3 className="mt-3 font-medium">{title}</h3>
              <p className="mt-1 text-sm text-slate-500">{body}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
