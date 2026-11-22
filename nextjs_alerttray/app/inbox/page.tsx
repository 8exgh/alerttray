'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  disablePush,
  enablePush,
  getPushState,
  isIos,
  isStandalone,
  registerServiceWorker,
  sendTestPush,
  setAppBadge,
  syncPushSubscription,
  type PushState
} from '@/lib/pwa/push-client';

/**
 * PWA home: the signed-in user's notification history (newest first, with
 * infinite scroll) plus the controls to get alerts as system notifications on
 * this device. The installed app opens here (manifest start_url).
 */

type Severity = 'low' | 'medium' | 'high' | 'critical';

interface InboxItem {
  id: string;
  purposeId: string;
  title: string;
  message: string;
  severity: Severity;
  status: 'pending' | 'delivered' | 'failed' | 'read';
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
}

interface Page {
  notifications: InboxItem[];
  nextCursor: string | null;
  unreadCount: number;
}

type Filter = 'all' | 'unread';

const PAGE_SIZE = 30;
const POLL_MS = 5000;

const SEVERITY_STYLE: Record<Severity, { bar: string; pill: string; label: string }> = {
  critical: { bar: 'border-l-red-600', pill: 'bg-red-600 text-white', label: 'Critical' },
  high: { bar: 'border-l-orange-500', pill: 'bg-orange-500 text-white', label: 'High' },
  medium: { bar: 'border-l-amber-400', pill: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200', label: 'Medium' },
  low: { bar: 'border-l-sky-400', pill: 'bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200', label: 'Low' }
};

/** Newest first; ties broken by id, matching the API's order. */
function byNewest(a: InboxItem, b: InboxItem): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function mergeItems(current: InboxItem[], incoming: InboxItem[], keepExisting = false): InboxItem[] {
  const map = new Map(current.map(item => [item.id, item]));
  for (const item of incoming) if (!keepExisting || !map.has(item.id)) map.set(item.id, item);
  return Array.from(map.values()).sort(byNewest);
}

function relativeTime(iso: string, now: number): string {
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function InboxPage() {
  return (
    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-gray-500">Loading…</div>}>
      <Inbox />
    </Suspense>
  );
}

function Inbox() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusId = searchParams.get('n');

  const [items, setItems] = useState<InboxItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [highlightId, setHighlightId] = useState<string | null>(focusId);
  const [now, setNow] = useState(() => Date.now());
  const [menuOpen, setMenuOpen] = useState(false);

  const [pushState, setPushState] = useState<PushState>('loading');
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState<string | null>(null);

  // Has the user paged past the first page? Then polling must not reset the cursor.
  const pagedRef = useRef(false);
  // Bumped on every local read action; a fetch that started before one is
  // stale (it would briefly un-read what the user just read) and is dropped.
  const mutationRef = useRef(0);
  const filterRef = useRef<Filter>(filter);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const fetchPage = useCallback(async (before: string | null, forFilter: Filter): Promise<Page | null> => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (before) params.set('before', before);
    if (forFilter === 'unread') params.set('unread', '1');
    const response = await fetch(`/api/notifications?${params}`, { cache: 'no-store' });
    if (response.status === 401) {
      router.replace(`/login?next=${encodeURIComponent('/inbox')}`);
      return null;
    }
    if (!response.ok) throw new Error('Could not load notifications');
    return response.json();
  }, [router]);

  /** Load (or refresh) the newest page, merging into whatever is already shown. */
  const refresh = useCallback(async (reset = false) => {
    const forFilter = filterRef.current;
    const generation = mutationRef.current;
    try {
      const page = await fetchPage(null, forFilter);
      if (!page || forFilter !== filterRef.current || generation !== mutationRef.current) return;
      setItems(current => (reset ? page.notifications : mergeItems(current, page.notifications)));
      if (reset || !pagedRef.current) setNextCursor(page.nextCursor);
      setUnreadCount(page.unreadCount);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load notifications');
    } finally {
      setLoading(false);
    }
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const forFilter = filterRef.current;
    const generation = mutationRef.current;
    setLoadingMore(true);
    try {
      const page = await fetchPage(nextCursor, forFilter);
      if (!page || forFilter !== filterRef.current) return;
      // Started before a local read action: keep what is shown, only add the older rows.
      const stale = generation !== mutationRef.current;
      pagedRef.current = true;
      setItems(current => mergeItems(current, page.notifications, stale));
      setNextCursor(page.nextCursor);
      if (!stale) setUnreadCount(page.unreadCount);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load older notifications');
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, loadingMore, nextCursor]);

  // First load + whenever the filter changes.
  useEffect(() => {
    filterRef.current = filter;
    pagedRef.current = false;
    setLoading(true);
    refresh(true);
  }, [filter, refresh]);

  // Poll while visible, refresh on return to the app, and on pushes from the service worker.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') refresh(); };
    const interval = setInterval(tick, POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    const onVisible = () => { if (document.visibilityState === 'visible') { setNow(Date.now()); refresh(); } };
    document.addEventListener('visibilitychange', onVisible);
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'alerttray:push') refresh();
      if (event.data?.type === 'alerttray:open' && event.data.notificationId) {
        setHighlightId(event.data.notificationId);
        refresh();
      }
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => {
      clearInterval(interval);
      clearInterval(clock);
      document.removeEventListener('visibilitychange', onVisible);
      navigator.serviceWorker?.removeEventListener('message', onMessage);
    };
  }, [refresh]);

  // Infinite scroll.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !nextCursor) return;
    const observer = new IntersectionObserver(
      entries => { if (entries.some(e => e.isIntersecting)) loadMore(); },
      { rootMargin: '600px 0px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, nextCursor]);

  // Service worker + push subscription state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await registerServiceWorker();
      const state = await syncPushSubscription().catch(() => getPushState());
      if (!cancelled) setPushState(state);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { setAppBadge(unreadCount); }, [unreadCount]);

  const markRead = useCallback(async (item: InboxItem) => {
    if (item.status === 'read') return;
    mutationRef.current++;
    setItems(current => current.map(i => (i.id === item.id ? { ...i, status: 'read', readAt: new Date().toISOString() } : i)));
    setUnreadCount(count => Math.max(0, count - 1));
    await fetch('/api/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationId: item.id })
    }).catch(() => {});
  }, []);

  // Opened from a notification (?n=<id>, or a tap while the app was open):
  // expand it, scroll to it and mark it read.
  useEffect(() => {
    if (!highlightId) return;
    const item = items.find(i => i.id === highlightId);
    if (!item) return;
    setExpanded(current => new Set(current).add(item.id));
    markRead(item);
    requestAnimationFrame(() => {
      document.getElementById(`n-${item.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    const clear = setTimeout(() => setHighlightId(null), 2500);
    return () => clearTimeout(clear);
  }, [highlightId, items, markRead]);

  const markAllRead = async () => {
    const newest = items[0]?.createdAt;
    if (!newest || unreadCount === 0) return;
    mutationRef.current++;
    setItems(current => current.map(i => (i.status === 'read' || i.createdAt > newest ? i : { ...i, status: 'read' })));
    setUnreadCount(0);
    await fetch('/api/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true, upTo: newest })
    }).catch(() => {});
    refresh();
  };

  const toggle = (item: InboxItem) => {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
    markRead(item);
  };

  const runPushAction = async (action: () => Promise<PushState | void>, success?: string) => {
    setPushBusy(true);
    setPushMessage(null);
    try {
      const state = await action();
      if (state) setPushState(state);
      if (success) setPushMessage(success);
    } catch (e) {
      setPushMessage(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setPushBusy(false);
    }
  };

  const handleLogout = async () => {
    // Signing out of the app also stops alerts popping up on this device.
    await disablePush().catch(() => {});
    await fetch('/api/auth/logout', { method: 'POST' });
    setAppBadge(0);
    router.replace('/login?next=/inbox');
  };

  return (
    <div className="flex-1 bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <header
        className="sticky top-0 z-10 bg-white/90 dark:bg-gray-900/90 backdrop-blur border-b border-gray-200 dark:border-gray-800"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <h1 className="text-lg font-semibold flex items-center gap-2">
            Inbox
            {unreadCount > 0 && (
              <span data-testid="unread-count" className="min-w-6 px-1.5 h-6 inline-flex items-center justify-center rounded-full bg-indigo-600 text-white text-xs font-semibold">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </h1>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={markAllRead}
              disabled={unreadCount === 0}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-indigo-600 dark:text-indigo-400 disabled:text-gray-400 dark:disabled:text-gray-600"
            >
              Mark all read
            </button>
            <div className="relative">
              <button
                onClick={() => setMenuOpen(open => !open)}
                aria-label="Menu"
                aria-expanded={menuOpen}
                className="w-9 h-9 inline-flex items-center justify-center rounded-md text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <svg viewBox="0 0 20 20" className="w-5 h-5" fill="currentColor" aria-hidden="true">
                  <circle cx="4" cy="10" r="1.75" /><circle cx="10" cy="10" r="1.75" /><circle cx="16" cy="10" r="1.75" />
                </svg>
              </button>
              {menuOpen && (
                <div className="absolute right-0 mt-1 w-48 rounded-lg shadow-lg bg-white dark:bg-gray-900 ring-1 ring-black/5 dark:ring-white/10 py-1 text-sm">
                  <Link href="/settings" className="block px-4 py-2 hover:bg-gray-50 dark:hover:bg-gray-800">Delivery settings</Link>
                  <Link href="/dashboard" className="block px-4 py-2 hover:bg-gray-50 dark:hover:bg-gray-800">API keys</Link>
                  <button onClick={handleLogout} className="block w-full text-left px-4 py-2 text-red-600 hover:bg-gray-50 dark:hover:bg-gray-800">
                    Log out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="max-w-2xl mx-auto px-4 pb-2 flex gap-2" role="tablist">
          {(['all', 'unread'] as const).map(f => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded-full text-sm font-medium ${
                filter === f
                  ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
                  : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
              }`}
            >
              {f === 'all' ? 'All' : 'Unread'}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4 space-y-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}>
        <PushPanel
          state={pushState}
          busy={pushBusy}
          message={pushMessage}
          onEnable={() => runPushAction(enablePush, 'Notifications are on for this device.')}
          onDisable={() => runPushAction(async () => { await disablePush(); return 'prompt'; }, 'Notifications are off for this device.')}
          onTest={() => runPushAction(async () => { await sendTestPush(); }, 'Test sent — it should pop up in a few seconds.')}
        />

        {error && (
          <div className="rounded-lg bg-red-50 dark:bg-red-950/50 text-red-800 dark:text-red-200 px-4 py-3 text-sm flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => refresh()} className="font-medium underline">Retry</button>
          </div>
        )}

        {loading ? (
          <div className="py-16 text-center text-gray-500">Loading…</div>
        ) : items.length === 0 ? (
          <div className="py-16 text-center text-gray-500 dark:text-gray-400">
            <p className="font-medium text-gray-700 dark:text-gray-300">
              {filter === 'unread' ? 'You’re all caught up' : 'No notifications yet'}
            </p>
            {filter === 'all' && (
              <p className="mt-1 text-sm">Alerts sent with your API key will show up here.</p>
            )}
          </div>
        ) : (
          <ul className="space-y-2" data-testid="notification-list">
            {items.map(item => {
              const style = SEVERITY_STYLE[item.severity] ?? SEVERITY_STYLE.low;
              const isExpanded = expanded.has(item.id);
              const unread = item.status !== 'read';
              return (
                <li
                  key={item.id}
                  id={`n-${item.id}`}
                  data-testid="notification"
                  data-unread={unread ? 'true' : 'false'}
                  className={`rounded-lg border-l-4 ${style.bar} bg-white dark:bg-gray-900 shadow-sm transition-shadow ${
                    highlightId === item.id ? 'ring-2 ring-indigo-500' : ''
                  }`}
                >
                  <button onClick={() => toggle(item)} className="w-full text-left px-4 py-3" aria-expanded={isExpanded}>
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide ${style.pill}`}>{style.label}</span>
                      <span className="truncate text-gray-500 dark:text-gray-400">{item.purposeId}</span>
                      <span className="ml-auto shrink-0 text-gray-500 dark:text-gray-400" title={new Date(item.createdAt).toLocaleString()}>
                        {relativeTime(item.createdAt, now)}
                      </span>
                      {unread && <span className="w-2 h-2 shrink-0 rounded-full bg-indigo-600" aria-label="Unread" />}
                    </div>
                    <p data-testid="notification-title" className={`mt-1.5 ${unread ? 'font-semibold' : 'font-medium text-gray-700 dark:text-gray-300'}`}>{item.title}</p>
                    <p className={`mt-0.5 text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-words ${isExpanded ? '' : 'line-clamp-3'}`}>
                      {item.message}
                    </p>
                    {isExpanded && (
                      <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                        {new Date(item.createdAt).toLocaleString()} · {item.status === 'failed' ? 'delivery failed' : item.status}
                      </p>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div ref={sentinelRef} />
        {nextCursor && !loading && (
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="w-full py-3 text-sm font-medium text-indigo-600 dark:text-indigo-400 disabled:text-gray-400"
          >
            {loadingMore ? 'Loading…' : 'Load older'}
          </button>
        )}
        {!nextCursor && !loading && items.length > PAGE_SIZE && (
          <p className="py-4 text-center text-xs text-gray-400">That’s everything.</p>
        )}
      </main>
    </div>
  );
}

function PushPanel(props: {
  state: PushState;
  busy: boolean;
  message: string | null;
  onEnable: () => void;
  onDisable: () => void;
  onTest: () => void;
}) {
  const { state, busy, message } = props;
  if (state === 'loading') return null;

  const card = 'rounded-lg bg-white dark:bg-gray-900 shadow-sm px-4 py-3 text-sm';
  const primary = 'inline-flex items-center justify-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60';
  const secondary = 'inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-800 disabled:opacity-60';
  const note = message && <p className="mt-2 text-xs text-gray-500 dark:text-gray-400" role="status">{message}</p>;

  if (state === 'needs-install') {
    return (
      <div className={card} data-testid="push-panel" data-state={state}>
        <p className="font-medium">Get alerts as iPhone notifications</p>
        <ol className="mt-1 list-decimal list-inside text-gray-600 dark:text-gray-400 space-y-0.5">
          <li>Tap the Share button <span aria-hidden="true">(□↑)</span> in Safari</li>
          <li>Choose <strong>Add to Home Screen</strong></li>
          <li>Open AlertTray from your home screen and sign in</li>
        </ol>
      </div>
    );
  }
  if (state === 'unsupported') {
    return (
      <div className={`${card} text-gray-500 dark:text-gray-400`} data-testid="push-panel" data-state={state}>
        This browser can’t show push notifications. {isIos() ? 'Update iOS to 16.4 or later.' : 'New alerts still appear here.'}
      </div>
    );
  }
  if (state === 'denied') {
    return (
      <div className={card} data-testid="push-panel" data-state={state}>
        <p className="font-medium">Notifications are blocked</p>
        <p className="mt-1 text-gray-600 dark:text-gray-400">
          {isIos() && isStandalone()
            ? 'Turn them on in Settings → Notifications → AlertTray.'
            : 'Allow notifications for this site in your browser settings.'}
        </p>
      </div>
    );
  }
  if (state === 'prompt') {
    return (
      <div className={card} data-testid="push-panel" data-state={state}>
        <p className="font-medium">Get alerts as notifications on this device</p>
        <p className="mt-0.5 text-gray-600 dark:text-gray-400">They pop up even when AlertTray is closed.</p>
        <button onClick={props.onEnable} disabled={busy} className={`${primary} mt-3`}>
          {busy ? 'Enabling…' : 'Enable notifications'}
        </button>
        {note}
      </div>
    );
  }
  return (
    <div className={card} data-testid="push-panel" data-state={state}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-1.5 font-medium">
          <span className="w-2 h-2 rounded-full bg-green-500" aria-hidden="true" /> Notifications on
        </span>
        <div className="ml-auto flex gap-2">
          <button onClick={props.onTest} disabled={busy} className={secondary}>Send test</button>
          <button onClick={props.onDisable} disabled={busy} className={secondary}>Turn off</button>
        </div>
      </div>
      {note}
    </div>
  );
}
