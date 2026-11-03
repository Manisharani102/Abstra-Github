import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth';
import { cx } from './ui';

const icon = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 shrink-0">
    {d}
  </svg>
);

const links = [
  {
    to: '/',
    label: 'Dashboard',
    end: true,
    icon: icon(
      <>
        <rect x="3" y="3" width="7" height="9" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" />
        <rect x="3" y="16" width="7" height="5" rx="1.5" />
      </>,
    ),
  },
  {
    to: '/rules',
    label: 'Rules',
    icon: icon(<path d="M4 6h10M4 12h16M4 18h7M17 4v4M14 18h6M17 16v4" />),
  },
  {
    to: '/repos',
    label: 'Repositories',
    icon: icon(
      <>
        <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z" />
        <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3" />
      </>,
    ),
  },
  {
    to: '/settings',
    label: 'Settings',
    icon: icon(
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </>,
    ),
  },
];

export function Logo({ dark = false }: { dark?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 font-semibold">
      <img src="/favicon.svg" alt="" className="h-8 w-8" />
      <span className={cx('tracking-tight', dark && 'text-white')}>Repo Autopilot</span>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { me, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="flex h-full flex-col bg-gradient-to-b from-slate-900 via-slate-900 to-indigo-950 px-3 py-5">
      <div className="px-2">
        <Logo dark />
      </div>

      <p className="mt-8 mb-2 px-3 text-[11px] font-semibold tracking-wider text-slate-500 uppercase">Menu</p>
      <nav className="flex flex-col gap-1">
        {links.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cx(
                'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition',
                isActive
                  ? 'bg-indigo-500/15 text-white ring-1 ring-indigo-400/30'
                  : 'text-slate-400 hover:bg-white/5 hover:text-white',
              )
            }
          >
            {({ isActive }) => (
              <>
                <span className={cx(isActive ? 'text-indigo-300' : 'text-slate-500 group-hover:text-slate-300')}>
                  {l.icon}
                </span>
                {l.label}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {me && (
        <div className="mt-auto rounded-xl bg-white/5 p-3 ring-1 ring-white/10">
          <div className="flex items-center gap-3">
            {me.avatarUrl ? (
              <img src={me.avatarUrl} alt="" className="h-9 w-9 rounded-full ring-2 ring-indigo-400/40" />
            ) : (
              <div className="h-9 w-9 rounded-full bg-indigo-500/30" />
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-white">{me.login}</p>
              <p className="text-xs text-slate-400">Signed in with GitHub</p>
            </div>
          </div>
          <button
            className="mt-3 w-full rounded-lg px-3 py-1.5 text-sm text-slate-300 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white"
            onClick={() => void logout().then(() => navigate('/login'))}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 lg:block">
        <Sidebar />
      </aside>

      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur lg:hidden">
        <Logo />
        <button
          aria-label="Open menu"
          className="rounded-lg p-2 text-slate-600 hover:bg-slate-100"
          onClick={() => setOpen(true)}
        >
          {icon(<path d="M4 6h16M4 12h16M4 18h16" />)}
        </button>
      </header>

      {open && (
        <div className="fixed inset-0 z-30 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 shadow-xl">
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <main className="px-4 py-8 lg:pl-64">
        <div className="mx-auto max-w-6xl lg:px-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
