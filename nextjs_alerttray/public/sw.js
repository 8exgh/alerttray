/*
 * AlertTray service worker: shows Web Push alerts as system notifications
 * (iPhone home-screen app, iOS 16.4+, and desktop/Android browsers) and opens
 * the inbox when one is tapped.
 *
 * Payloads come from background_processor/src/message-format.ts
 * (formatWebPushPayload): either Declarative Web Push
 * ({ web_push: 8030, notification: {...} }) or a plain { title, body, ... }.
 *
 * iOS revokes the push subscription of a web app that receives a push without
 * showing a notification, so every push shows one, even if the payload is
 * unreadable.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function readPush(event) {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { body: event.data.text() };
    }
  }
  const declarative = data && data.web_push === 8030 && data.notification ? data.notification : null;
  const n = declarative || data || {};
  const extra = n.data || data || {};
  let url = extra.url || '/inbox';
  if (!extra.url && n.navigate) {
    try {
      const target = new URL(n.navigate, self.location.origin);
      if (target.origin === self.location.origin) url = target.pathname + target.search;
    } catch { /* keep /inbox */ }
  }
  const tag = n.tag || extra.notificationId || undefined;
  return {
    title: n.title || 'AlertTray',
    options: {
      body: n.body || 'You have a new alert',
      tag,
      renotify: !!tag,
      requireInteraction: extra.severity === 'critical',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      timestamp: Date.now(),
      data: { url, notificationId: extra.notificationId || null, severity: extra.severity || null }
    }
  };
}

async function postToClients(message) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) client.postMessage(message);
}

/** Home-screen badge = unread count (iOS 16.4+, Chromium). Best effort. */
async function refreshBadge() {
  try {
    if (!self.navigator.setAppBadge) return;
    const response = await fetch('/api/notifications?limit=1', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return;
    const { unreadCount } = await response.json();
    if (unreadCount > 0) await self.navigator.setAppBadge(unreadCount);
    else await self.navigator.clearAppBadge();
  } catch { /* offline or signed out */ }
}

self.addEventListener('push', event => {
  const { title, options } = readPush(event);
  event.waitUntil(
    self.registration.showNotification(title, options).then(() => Promise.all([
      postToClients({ type: 'alerttray:push', notificationId: options.data.notificationId }),
      refreshBadge()
    ]))
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const { url = '/inbox', notificationId = null } = event.notification.data || {};
  const target = new URL(url, self.location.origin);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      if (new URL(existing.url).pathname === '/inbox') {
        existing.postMessage({ type: 'alerttray:open', notificationId });
      } else if ('navigate' in existing) {
        await existing.navigate(target.href);
      }
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

// Browsers that rotate subscriptions (mainly Firefox) tell us here; re-register
// so alerts keep arriving without the user opening the app.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const config = await fetch('/api/web-push/config', { credentials: 'same-origin' });
    if (!config.ok) return;
    const { publicKey } = await config.json();
    const subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    await fetch('/api/web-push/subscribe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON() })
    });
    if (event.oldSubscription) {
      await fetch('/api/web-push/unsubscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: event.oldSubscription.endpoint })
      });
    }
  })());
});
