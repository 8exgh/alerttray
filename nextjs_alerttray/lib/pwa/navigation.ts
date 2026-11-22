import { isStandalone } from './push-client';

/**
 * Where to go after signing in: a same-site `?next=` path if given, the
 * inbox in the installed app (PWA mode), otherwise the web dashboard.
 */
export function postLoginPath(): string {
  const next = new URLSearchParams(window.location.search).get('next');
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')) return next;
  return isStandalone() ? '/inbox' : '/dashboard';
}
