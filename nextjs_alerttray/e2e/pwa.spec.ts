import { test, expect, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { FakePushService, verifyVapid, type FakeSubscriber } from './fake-push-service';

/*
 * The whole PWA push path, for real:
 *   iPhone home-screen app (simulated in Chromium) subscribes →
 *   alert pushed with an API key → projection → background processor →
 *   encrypted, VAPID-signed Web Push → push service (local HTTPS fake) →
 *   decrypted payload delivered into the app's real service worker →
 *   system notification shown → listed in the inbox.
 */

const ROOT = path.resolve(__dirname, '..');
const WORKER_DIR = path.resolve(ROOT, '..', 'background_processor');
const INTERNAL_KEY = `e2e-${randomUUID()}`;

let dataDir: string;
let baseURL: string;
let pushService: FakePushService;
const children: ChildProcess[] = [];
const logs: string[] = [];
const swLogs: string[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function start(command: string, args: string[], cwd: string, env: Record<string, string>, label: string): ChildProcess {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = (chunk: Buffer) => logs.push(...chunk.toString().split('\n').filter(Boolean).map(line => `[${label}] ${line}`));
  child.stdout!.on('data', record);
  child.stderr!.on('data', record);
  children.push(child);
  return child;
}

async function waitForHttp(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${url} did not come up:\n${logs.slice(-40).join('\n')}`);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'alerttray-e2e-'));
  pushService = new FakePushService();
  await pushService.start();

  const port = await freePort();
  baseURL = `http://localhost:${port}`;
  start('npx', ['next', 'start', '-p', String(port), '-H', 'localhost'], ROOT, {
    DATABASE_PATH: dataDir,
    BACKGROUND_PROCESSOR_API_KEY: INTERNAL_KEY,
    WEB_PUSH_EXTRA_ENDPOINT_ORIGINS: pushService.origin,
    VAPID_PUBLIC_KEY: '',
    VAPID_PRIVATE_KEY: '',
    VAPID_SUBJECT: 'mailto:e2e@example.com',
    REGISTRATION: ''
  }, 'next');
  await waitForHttp(`${baseURL}/login`);

  start('npx', ['tsx', 'src/index.ts'], WORKER_DIR, {
    ALERTTRAY_API_URL: baseURL,
    API_KEY: INTERNAL_KEY,
    NODE_EXTRA_CA_CERTS: pushService.certPath,  // trust the fake push service's self-signed cert
    NODE_ENV: 'test',
    DELIVERY_DRY_RUN: '',
    EMAIL_BOUNCE_MONITOR: '0',
    GMAIL_USER: '', GMAIL_APP_PASSWORD: '',
    PHONE_GATEWAY_API_KEY: '',
    APNS_TEAM_ID: '', APNS_KEY_ID: '', APNS_BUNDLE_ID: ''
  }, 'worker');
});

test.afterAll(async () => {
  for (const child of children) child.kill('SIGTERM');
  await pushService?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test.beforeEach(() => { swLogs.length = 0; });

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('server-logs', { body: logs.filter(l => !/Internal API auth|^\[next\]   [-✅]/.test(l)).slice(-200).join('\n'), contentType: 'text/plain' });
    await testInfo.attach('service-worker', { body: swLogs.join('\n') || '(none)', contentType: 'text/plain' });
  }
});

/** Sign up through the real UI; leaves the page signed in. */
async function signUp(page: Page): Promise<string> {
  const email = `e2e-${randomUUID()}@example.com`;
  await page.goto(`${baseURL}/register`);
  await page.fill('#email', email);
  await page.fill('#password', 'e2e-password-123');
  await page.fill('#confirmPassword', 'e2e-password-123');
  await page.click('button[type="submit"]');
  await page.waitForURL(url => !url.pathname.startsWith('/register'));
  return email;
}

async function createApiKey(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch('/api/api-keys/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'e2e' })
    });
    return (await response.json()).apiKey.key as string;
  });
}

async function pushAlert(apiKey: string, alert: { title: string; message: string; severity: string; purposeId?: string }) {
  const response = await fetch(`${baseURL}/api/notifications/push`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    // recipients: {} → no phone/email for this alert, so only the PWA gets it (no SMTP/gateway in e2e)
    body: JSON.stringify({ purposeId: 'e2e', ...alert, recipients: {} })
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ notificationId: string; channels: string[] }>;
}

/**
 * An iPhone running AlertTray from the home screen. Chromium stands in for
 * WebKit: it reports itself as an iPhone in standalone mode, and its
 * PushManager returns `subscriber` (a subscription to the fake push service
 * whose keys the test holds) instead of registering with Google.
 */
async function iphoneHomeScreenApp(browser: Browser, subscriber: FakeSubscriber): Promise<BrowserContext> {
  const iphone = devices['iPhone 15'];
  const context = await browser.newContext({
    userAgent: iphone.userAgent,
    viewport: iphone.viewport,
    deviceScaleFactor: iphone.deviceScaleFactor,
    isMobile: true,
    hasTouch: true
  });
  // The service worker needs the real permission to show notifications.
  await context.grantPermissions(['notifications'], { origin: baseURL });
  await context.addInitScript((sub) => {
    Object.defineProperty(navigator, 'standalone', { get: () => true });
    // What the page sees before/after the user answers the permission prompt.
    let permission = localStorage.getItem('e2e-permission') ?? 'default';
    Object.defineProperty(Notification, 'permission', { get: () => permission });
    Notification.requestPermission = async () => {
      permission = 'granted';
      localStorage.setItem('e2e-permission', permission);
      return 'granted';
    };
    const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    let current: PushSubscription | null = null;
    const make = (key: ArrayBuffer) => ({
      endpoint: sub.endpoint,
      expirationTime: null,
      options: { applicationServerKey: key, userVisibleOnly: true },
      toJSON: () => sub,
      unsubscribe: async () => { current = null; localStorage.removeItem('e2e-key'); return true; },
      getKey: () => null
    }) as unknown as PushSubscription;
    const saved = localStorage.getItem('e2e-key');
    if (saved) current = make(Uint8Array.from(atob(saved.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)).buffer);
    PushManager.prototype.getSubscription = async function () { return current; };
    PushManager.prototype.subscribe = async function (options?: PushSubscriptionOptionsInit) {
      const key = new Uint8Array(options!.applicationServerKey as ArrayBuffer).slice().buffer;
      localStorage.setItem('e2e-key', toBase64Url(new Uint8Array(key)));
      current = make(key);
      return current;
    };
  }, subscriber.json);
  return context;
}

/** Hand a push payload to the page's real service worker, as the OS would. */
async function deliverToServiceWorker(context: BrowserContext, page: Page, payload: string): Promise<void> {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const cdp = await context.newCDPSession(page);
  const registrations: { registrationId: string; scopeURL: string; isDeleted: boolean }[] = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', event => registrations.push(...event.registrations));
  cdp.on('ServiceWorker.workerErrorReported', event => swLogs.push(`[sw-error] ${JSON.stringify(event.errorMessage)}`));
  cdp.on('ServiceWorker.workerVersionUpdated', event => swLogs.push(`[sw-version] ${JSON.stringify(event.versions)}`));
  await cdp.send('ServiceWorker.enable');
  await expect.poll(() => registrations.find(r => !r.isDeleted && r.scopeURL === `${baseURL}/`)).toBeTruthy();
  const { registrationId } = registrations.find(r => !r.isDeleted && r.scopeURL === `${baseURL}/`)!;
  swLogs.push(`[deliver] ${new Date().toISOString()} registration=${registrationId} ${payload.slice(0, 60)}`);
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: baseURL, registrationId, data: payload });
  swLogs.push(`[delivered] ${new Date().toISOString()}`);
}

/**
 * Record every notification the service worker shows (title + options, as
 * passed to showNotification). We read this rather than
 * registration.getNotifications(): headless Chromium on Linux drops most
 * displayed notifications from that list (in a 40-push stress run every push
 * event showed its notification, but getNotifications kept only 2).
 */
async function recordShownNotifications(context: BrowserContext, page: Page) {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const worker = context.serviceWorkers().find(w => w.url().startsWith(baseURL))
    ?? await context.waitForEvent('serviceworker', w => w.url().startsWith(baseURL));
  await worker.evaluate(() => {
    const sw = self as unknown as { __shown?: unknown[]; registration: ServiceWorkerRegistration };
    if (sw.__shown) return;
    sw.__shown = [];
    const show = sw.registration.showNotification.bind(sw.registration);
    sw.registration.showNotification = (title: string, options?: NotificationOptions) => {
      sw.__shown!.push({ title, ...options });
      return show(title, options);
    };
  });
  // If the worker were restarted the record would be lost and the assertions fail (never pass falsely).
  return () => worker.evaluate(() => (self as unknown as { __shown?: unknown[] }).__shown ?? []) as Promise<Record<string, unknown>[]>;
}

test('is an installable home-screen app: manifest, icons, iOS meta tags and a fresh service worker', async ({ page }) => {
  const manifest = await (await fetch(`${baseURL}/manifest.webmanifest`)).json();
  expect(manifest).toMatchObject({ name: 'AlertTray', display: 'standalone', start_url: '/inbox', scope: '/' });
  for (const icon of manifest.icons) {
    const response = await fetch(`${baseURL}${icon.src}`);
    expect(response.status, icon.src).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
  }
  expect(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true);

  const sw = await fetch(`${baseURL}/sw.js`);
  expect(sw.status).toBe(200);
  expect(sw.headers.get('cache-control')).toContain('no-cache');
  expect(sw.headers.get('content-type')).toContain('javascript');

  await page.goto(`${baseURL}/login`);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('meta[name="mobile-web-app-capable"], meta[name="apple-mobile-web-app-capable"]').first()).toHaveAttribute('content', 'yes');
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'AlertTray');
  const touchIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
  expect((await fetch(`${baseURL}${touchIcon}`)).status).toBe(200);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);

  // Signed-out app launch goes to login and comes back to the inbox afterwards.
  await page.goto(`${baseURL}/inbox`);
  await page.waitForURL(/\/login\?next=%2Finbox|\/login\?next=\/inbox/);
  await expect(page).toHaveTitle('AlertTray');
});

test('in an iPhone Safari tab, explains how to add AlertTray to the home screen', async ({ browser }) => {
  const iphone = devices['iPhone 15'];
  const context = await browser.newContext({ userAgent: iphone.userAgent, viewport: iphone.viewport, isMobile: true, hasTouch: true });
  // iOS Safari only exposes Web Push to home-screen apps.
  await context.addInitScript(() => { delete (window as { PushManager?: unknown }).PushManager; });
  const page = await context.newPage();
  await signUp(page);
  await page.goto(`${baseURL}/inbox`);
  const panel = page.getByTestId('push-panel');
  await expect(panel).toHaveAttribute('data-state', 'needs-install');
  await expect(panel).toContainText('Add to Home Screen');
  await context.close();
});

test('iPhone home-screen app: enable notifications, receive real encrypted pushes, show them, list them', async ({ browser }) => {
  const subscriber = pushService.newSubscriber();
  const context = await iphoneHomeScreenApp(browser, subscriber);
  const page = await context.newPage();

  // Opening the installed app (manifest start_url) while signed out → login → back to the inbox.
  await page.goto(`${baseURL}/`);
  await page.waitForURL(/\/login/);
  await page.getByRole('link', { name: /create a new account/i }).click();
  await page.waitForURL(/\/register/);
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  const email = `e2e-${randomUUID()}@example.com`;
  await page.fill('#email', email);
  await page.fill('#password', 'e2e-password-123');
  await page.fill('#confirmPassword', 'e2e-password-123');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/inbox/);  // standalone mode lands in the inbox, not the desktop dashboard
  await expect(page.getByText('No notifications yet')).toBeVisible();

  const panel = page.getByTestId('push-panel');
  await expect(panel).toHaveAttribute('data-state', 'prompt');
  await panel.getByRole('button', { name: 'Enable notifications' }).click();
  await expect(panel).toHaveAttribute('data-state', 'subscribed');
  await expect(panel).toContainText('Notifications on');

  const { publicKey } = await page.evaluate(async () => (await fetch('/api/web-push/config')).json());

  // 1) "Send test" from the app.
  let since = Date.now();
  await panel.getByRole('button', { name: 'Send test' }).click();
  const testPush = await pushService.waitFor(subscriber.endpoint, since);
  const vapid = verifyVapid(testPush.headers.authorization, publicKey, subscriber.endpoint);
  expect(vapid.sub).toBe('mailto:e2e@example.com');
  expect(testPush.headers['content-encoding']).toBe('aes128gcm');
  expect(Number(testPush.headers.ttl)).toBe(86400);
  const testPayload = JSON.parse(subscriber.decrypt(testPush));
  expect(testPayload).toMatchObject({
    web_push: 8030,
    notification: { title: 'AlertTray test', navigate: expect.stringMatching(new RegExp(`^${baseURL}/inbox\\?n=`)) }
  });
  await expect(page.getByTestId('notification').filter({ hasText: 'AlertTray test' })).toBeVisible();

  // 2) A critical alert from an integration, via the public API key.
  const apiKey = await createApiKey(page);
  since = Date.now();
  const { notificationId, channels } = await pushAlert(apiKey, { title: 'Disk full', message: '/var is at 99% on db-1', severity: 'critical' });
  expect(channels).toEqual(['webpush']);
  const alertPush = await pushService.waitFor(subscriber.endpoint, since);
  expect(alertPush.headers.urgency).toBe('high');
  verifyVapid(alertPush.headers.authorization, publicKey, subscriber.endpoint);
  const decrypted = subscriber.decrypt(alertPush);
  const alertPayload = JSON.parse(decrypted);
  expect(alertPayload.notification).toMatchObject({
    title: '🚨 Disk full',
    body: '/var is at 99% on db-1',
    navigate: `${baseURL}/inbox?n=${notificationId}`,
    tag: notificationId,
    data: { notificationId, severity: 'critical', url: `/inbox?n=${notificationId}` }
  });

  // The phone receives it: the service worker shows a system notification.
  const shown = await recordShownNotifications(context, page);
  await deliverToServiceWorker(context, page, decrypted);
  await expect.poll(shown).toContainEqual(expect.objectContaining({
    title: '🚨 Disk full', body: '/var is at 99% on db-1', tag: notificationId, requireInteraction: true,
    data: expect.objectContaining({ url: `/inbox?n=${notificationId}`, notificationId })
  }));

  // …and the open inbox picks it up, newest first, unread.
  const items = page.getByTestId('notification');
  await expect(items.first()).toContainText('Disk full');
  await expect(items.first()).toContainText('Critical');
  await expect(items.first()).toHaveAttribute('data-unread', 'true');
  await expect(page.getByTestId('unread-count')).toHaveText('2');

  // Tapping the notification opens /inbox?n=<id>: expanded, highlighted, marked read; delivery recorded.
  await page.goto(`${baseURL}/inbox?n=${notificationId}`);
  const opened = page.locator(`#n-${notificationId}`);
  await expect(opened).toHaveAttribute('data-unread', 'false');
  await expect(opened).toContainText(/read|delivered/);
  await expect(page.getByTestId('unread-count')).toHaveText('1');

  // A malformed push still shows a notification (iOS revokes apps that push silently).
  const shownAfterReload = await recordShownNotifications(context, page);
  await deliverToServiceWorker(context, page, 'not json');
  await expect.poll(shownAfterReload).toContainEqual(expect.objectContaining({ title: 'AlertTray', body: 'not json' }));

  // Turning notifications off removes this device server-side: the next alert is not pushed to it.
  await panel.getByRole('button', { name: 'Turn off' }).click();
  await expect(panel).toHaveAttribute('data-state', 'prompt');
  const after = await pushAlert(apiKey, { title: 'After opt-out', message: 'x', severity: 'high' });
  expect(after.channels).toEqual([]);
  await context.close();
});

test('a subscription the push service reports gone (410) is removed and not pushed again', async ({ browser }) => {
  const subscriber = pushService.newSubscriber();
  pushService.statusFor.set(new URL(subscriber.endpoint).pathname, 410);
  const context = await iphoneHomeScreenApp(browser, subscriber);
  const page = await context.newPage();
  await signUp(page);
  await page.goto(`${baseURL}/inbox`);
  await page.getByRole('button', { name: 'Enable notifications' }).click();
  await expect(page.getByTestId('push-panel')).toHaveAttribute('data-state', 'subscribed');
  const apiKey = await createApiKey(page);

  const since = Date.now();
  const first = await pushAlert(apiKey, { title: 'Into the void', message: 'x', severity: 'medium' });
  expect(first.channels).toEqual(['webpush']);
  await pushService.waitFor(subscriber.endpoint, since);

  await expect.poll(() => {
    const db = new Database(path.join(dataDir, 'system', 'system.db'), { readonly: true });
    try {
      return db.prepare('SELECT COUNT(*) AS n FROM web_push_subscriptions WHERE endpoint = ?').get(subscriber.endpoint);
    } finally { db.close(); }
  }, { timeout: 20_000 }).toEqual({ n: 0 });

  const second = await pushAlert(apiKey, { title: 'Again', message: 'x', severity: 'medium' });
  expect(second.channels).toEqual([]);
  await context.close();
});

test('inbox scrolls back through history, marks read, and filters unread', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUp(page);
  const apiKey = await createApiKey(page);
  for (let i = 1; i <= 70; i++) {
    await pushAlert(apiKey, {
      title: `Alert #${i}`,
      message: `Message body ${i}`,
      severity: (['low', 'medium', 'high', 'critical'] as const)[i % 4],
      purposeId: `svc-${i % 3}`
    });
  }

  // The projection runs every second; let it catch up before opening the inbox.
  await expect.poll(() => page.evaluate(async () => (await (await fetch('/api/notifications?limit=1')).json()).unreadCount)).toBe(70);
  await page.goto(`${baseURL}/inbox`);
  const items = page.getByTestId('notification');
  await expect(items.first()).toContainText('Alert #70');
  await expect(items).toHaveCount(30);
  await expect(page.getByTestId('unread-count')).toHaveText('70');

  // Infinite scroll: reach the bottom twice to load all 70, oldest last.
  for (const expected of [60, 70]) {
    await items.last().scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 20_000);
    await expect(items).toHaveCount(expected);
  }
  await expect(items.last()).toContainText('Alert #1');
  await expect(page.getByText('That’s everything.')).toBeVisible();
  const titles = await page.getByTestId('notification-title').allTextContents();
  expect(titles).toEqual(Array.from({ length: 70 }, (_, i) => `Alert #${70 - i}`));

  // Tap one: expands and is marked read.
  const oldest = items.filter({ has: page.getByTestId('notification-title').getByText('Alert #1', { exact: true }) });
  await Promise.all([page.waitForResponse('**/api/notifications/read'), oldest.click()]);
  await expect(oldest).toHaveAttribute('data-unread', 'false');
  await expect(page.getByTestId('unread-count')).toHaveText('69');

  // Survives a reload (it is persisted, not just local state).
  await page.reload();
  await expect(page.getByTestId('unread-count')).toHaveText('69');

  await page.getByRole('tab', { name: 'Unread' }).click();
  await expect(items).toHaveCount(30);
  await Promise.all([page.waitForResponse('**/api/notifications/read'), page.getByRole('button', { name: 'Mark all read' }).click()]);
  await expect(page.getByTestId('unread-count')).toHaveCount(0);
  await page.reload();
  await page.getByRole('tab', { name: 'Unread' }).click();
  await expect(page.getByText('You’re all caught up')).toBeVisible();

  // An alert arriving while the inbox is open appears without a reload (polling).
  await page.getByRole('tab', { name: 'All' }).click();
  await pushAlert(apiKey, { title: 'Late arrival', message: 'new', severity: 'high' });
  await expect(items.first()).toContainText('Late arrival', { timeout: 15_000 });
  await expect(page.getByTestId('unread-count')).toHaveText('1');
});
