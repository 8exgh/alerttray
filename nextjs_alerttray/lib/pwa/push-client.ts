/**
 * Browser side of Web Push for the AlertTray PWA. Client components only.
 *
 * iPhone rules (iOS/iPadOS 16.4+): push is only available to a site added to
 * the home screen and opened from there, and the permission prompt must come
 * from a tap. So the inbox shows "Add to Home Screen" help in Safari, and an
 * "Enable notifications" button in the installed app.
 */

export type PushState =
  | 'loading'
  | 'needs-install'   // iPhone/iPad Safari tab: add to home screen first
  | 'unsupported'     // browser has no Web Push
  | 'prompt'          // can ask for permission
  | 'denied'          // user blocked notifications
  | 'subscribed';     // this device receives alerts

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined' &&
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (error) {
    console.error('Service worker registration failed:', error);
    return null;
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const left = new Uint8Array(a);
  return left.length === b.length && left.every((byte, i) => byte === b[i]);
}

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (isIos()) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Browser';
}

async function fetchPublicKey(): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch('/api/web-push/config', { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.publicKey !== 'string') {
    throw new Error(data.error || 'Push is not available right now');
  }
  return urlBase64ToUint8Array(data.publicKey);
}

async function saveSubscription(subscription: PushSubscription): Promise<void> {
  const response = await fetch('/api/web-push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON(), deviceName: deviceName() })
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Could not register this device');
  }
}

/**
 * Subscribe with the server's current VAPID key, replacing a subscription
 * made with a different key (it would be rejected by the push service).
 */
async function subscribe(registration: ServiceWorkerRegistration): Promise<PushSubscription> {
  const key = await fetchPublicKey();
  const existing = await registration.pushManager.getSubscription();
  if (existing && sameKey(existing.options.applicationServerKey, key)) return existing;
  if (existing) await existing.unsubscribe();
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'prompt';
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? 'subscribed' : 'prompt';
}

/** Ask for permission and subscribe. Call directly from a tap handler. */
export async function enablePush(): Promise<PushState> {
  // First thing in the gesture: Safari only shows the prompt for a user action.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'prompt';
  const registration = (await registerServiceWorker()) && (await navigator.serviceWorker.ready);
  if (!registration) throw new Error('Could not start the notification service');
  await saveSubscription(await subscribe(registration));
  return 'subscribed';
}

/**
 * On every app open: re-send the subscription so the server has it (it drops
 * subscriptions the push service reports expired), and re-subscribe if the
 * server's key changed. No-op unless permission was already granted.
 */
export async function syncPushSubscription(): Promise<PushState> {
  const state = await getPushState();
  if (!pushSupported() || Notification.permission !== 'granted') return state;
  try {
    const registration = await navigator.serviceWorker.ready;
    await saveSubscription(await subscribe(registration));
    return 'subscribed';
  } catch (error) {
    console.warn('Could not sync push subscription:', error);
    return state;
  }
}

export async function currentEndpoint(): Promise<string | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  return (await registration?.pushManager.getSubscription())?.endpoint ?? null;
}

/** Stop alerts to this device (server first, so a failure leaves nothing half-done on the server). */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await fetch('/api/web-push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint })
  });
  await subscription.unsubscribe();
}

export async function sendTestPush(): Promise<void> {
  const endpoint = await currentEndpoint();
  const response = await fetch('/api/web-push/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(endpoint ? { endpoint } : {})
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Could not send a test notification');
  }
}

export function setAppBadge(count: number): void {
  const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (count > 0) nav.setAppBadge?.(count).catch(() => {});
  else nav.clearAppBadge?.().catch(() => {});
}
