import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

/** A browser-like subscription: real P-256 key + 16-byte auth secret. */
function fakeSubscription(endpoint = `https://web.push.apple.com/${randomUUID()}`) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }
  };
}

test('PWA web push: routing, subscriptions, VAPID, inbox paging and read state', async t => {
  const previous = { ...process.env };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alerttray-webpush-'));
  process.env.DATABASE_PATH = directory;
  process.env.BACKGROUND_PROCESSOR_API_KEY = 'web-push-test-key';
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.WEB_PUSH_EXTRA_ENDPOINT_ORIGINS;
  t.after(async () => { process.env = previous; await rm(directory, { recursive: true, force: true }); });

  const { resolveDeliveryTargets, SEVERITY_LEVELS } = await import('../lib/delivery/routing-policy');
  const subs = await import('../lib/web-push/subscriptions');
  const { getVapidKeys, generateVapidKeys } = await import('../lib/web-push/vapid');
  const { CommandBus } = await import('../lib/cqrs/command-bus');
  const { QueryBus } = await import('../lib/cqrs/query-bus');
  const { ProjectionEngine } = await import('../lib/cqrs/projection-engine');
  const { getSystemDatabase, getReadModelDatabase } = await import('../lib/infrastructure/database/connection');
  const { AuthService } = await import('../lib/infrastructure/security/auth');
  const { ApiSecurity, createSignature } = await import('../lib/infrastructure/security/api-security');
  const { ContactDetailsService } = await import('../lib/infrastructure/users/contact-details');
  const { NextRequest } = await import('next/server');
  const { GET: listNotifications } = await import('../app/api/notifications/route');
  const { POST: markRead } = await import('../app/api/notifications/read/route');
  const { POST: subscribe } = await import('../app/api/web-push/subscribe/route');
  const { POST: unsubscribe } = await import('../app/api/web-push/unsubscribe/route');
  const { GET: config } = await import('../app/api/web-push/config/route');
  const { POST: sendTest } = await import('../app/api/web-push/test/route');
  const { GET: internalVapid } = await import('../app/api/internal/web-push/vapid/route');
  const { POST: pushResult } = await import('../app/api/internal/push-result/route');
  const { POST: publicPush } = await import('../app/api/notifications/push/route');
  const { getProjectionEngine } = await import('../lib/startup');

  const commands = new CommandBus();
  const queries = new QueryBus();
  const projection = new ProjectionEngine();
  const project = async () => { await projection.start(); projection.stop(); };
  t.after(() => { projection.stop(); getProjectionEngine()?.stop(); });

  const newUser = async () => {
    const email = `${randomUUID()}@example.com`;
    const { id: userId } = await AuthService.createUser(email, 'correct horse battery');
    const { token } = await AuthService.createSession(userId);
    return { userId, email, token };
  };
  const sessionRequest = (url: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) =>
    new NextRequest(`http://localhost${url}`, {
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...(token ? { Cookie: `session=${token}` } : {}), ...headers }
    });

  await t.test('every severity fans out to each PWA subscription, independently of call/sms/email', () => {
    for (const severity of SEVERITY_LEVELS) {
      const { targets } = resolveDeliveryTargets(severity, {
        phoneNumber: null, notificationEmail: null, deviceTokens: ['apns-token'],
        webPushSubscriptions: ['{"endpoint":"a"}', '{"endpoint":"b"}']
      });
      assert.deepEqual(targets.filter(t => t.channel === 'webpush').map(t => t.recipient), ['{"endpoint":"a"}', '{"endpoint":"b"}']);
      assert.ok(targets.some(t => t.channel === 'apns'));
    }
    // Contact without subscriptions (older callers) still works.
    assert.deepEqual(resolveDeliveryTargets('low', { phoneNumber: null, notificationEmail: 'x@example.com', deviceTokens: [] }).targets,
      [{ channel: 'email', recipient: 'x@example.com' }]);
  });

  await t.test('subscriptions must come from a real push service with well-formed keys', () => {
    const good = fakeSubscription();
    const parsed = subs.parseWebPushSubscription(good);
    assert.ok(!('error' in parsed));
    assert.equal(parsed.endpoint, good.endpoint);
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc'
    ]) {
      assert.ok(!('error' in subs.parseWebPushSubscription({ ...good, endpoint })), endpoint);
    }
    for (const endpoint of [
      'http://web.push.apple.com/abc',                 // not https
      'https://192.168.4.56:3012/api/internal/tasks',  // internal host
      'https://evilpush.apple.com.attacker.io/x',      // suffix trick
      'https://user:pw@web.push.apple.com/x',
      'not a url'
    ]) {
      assert.ok('error' in subs.parseWebPushSubscription({ ...good, endpoint }), endpoint);
    }
    assert.ok('error' in subs.parseWebPushSubscription({ ...good, keys: { ...good.keys, auth: 'c2hvcnQ' } }));
    assert.ok('error' in subs.parseWebPushSubscription({ ...good, keys: { ...good.keys, p256dh: randomBytes(65).toString('base64url').replace(/^./, 'A') } }));
    assert.ok('error' in subs.parseWebPushSubscription(null));
    // Standard base64 (with + and /) is accepted and normalized to base64url.
    const std = { ...good, keys: { p256dh: Buffer.from(good.keys.p256dh, 'base64url').toString('base64'), auth: Buffer.from(good.keys.auth, 'base64url').toString('base64') } };
    const normalized = subs.parseWebPushSubscription(std);
    assert.ok(!('error' in normalized) && normalized.p256dh === good.keys.p256dh);

    process.env.WEB_PUSH_EXTRA_ENDPOINT_ORIGINS = 'https://127.0.0.1:4555';
    assert.ok(!('error' in subs.parseWebPushSubscription({ ...good, endpoint: 'https://127.0.0.1:4555/push/1' })));
    assert.ok('error' in subs.parseWebPushSubscription({ ...good, endpoint: 'https://127.0.0.1:4556/push/1' }));
    delete process.env.WEB_PUSH_EXTRA_ENDPOINT_ORIGINS;
  });

  await t.test('VAPID pair is generated once, persisted, served to the worker only, and overridable', async () => {
    const first = getVapidKeys();
    assert.equal(Buffer.from(first.publicKey, 'base64url').length, 65);
    assert.equal(Buffer.from(first.privateKey, 'base64url').length, 32);
    assert.deepEqual(getVapidKeys(), first);

    const user = await newUser();
    const response = await config(sessionRequest('/api/web-push/config', user.token));
    assert.deepEqual(await response.json(), { publicKey: first.publicKey });
    assert.equal((await config(sessionRequest('/api/web-push/config', null))).status, 401);

    const internal = (key: string) => new NextRequest('http://localhost/api/internal/web-push/vapid', {
      headers: { 'X-API-Key': key, 'X-Signature': createSignature('') }
    });
    const served = await (await internalVapid(internal('web-push-test-key'))).json();
    assert.deepEqual(served, { success: true, publicKey: first.publicKey, privateKey: first.privateKey, subject: null });
    assert.equal((await internalVapid(internal('wrong'))).status, 401);

    const pinned = generateVapidKeys();
    process.env.VAPID_PUBLIC_KEY = pinned.publicKey;
    process.env.VAPID_PRIVATE_KEY = pinned.privateKey;
    assert.deepEqual(getVapidKeys(), pinned);
    process.env.VAPID_PRIVATE_KEY = '';
    assert.throws(() => getVapidKeys(), /both/);
    process.env.VAPID_PRIVATE_KEY = 'bm90IGEga2V5';
    assert.throws(() => getVapidKeys(), /P-256/);
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    assert.deepEqual(getVapidKeys(), first);
  });

  await t.test('subscribe/unsubscribe routes are session-scoped and an endpoint moves with the signed-in account', async () => {
    const alice = await newUser();
    const bob = await newUser();
    const sub = fakeSubscription();

    assert.equal((await subscribe(sessionRequest('/api/web-push/subscribe', null, { subscription: sub }))).status, 401);
    assert.equal((await subscribe(sessionRequest('/api/web-push/subscribe', alice.token, { subscription: { ...sub, endpoint: 'https://example.com/x' } }))).status, 400);

    const ok = await subscribe(sessionRequest('/api/web-push/subscribe', alice.token,
      { subscription: sub, deviceName: 'iPhone' }, { Origin: 'https://alerts.example.com' }));
    assert.equal(ok.status, 200);
    // Re-sending on every app open is idempotent.
    await subscribe(sessionRequest('/api/web-push/subscribe', alice.token, { subscription: sub }, { Origin: 'https://alerts.example.com' }));
    const [recipient] = subs.WebPushSubscriptionService.recipientsForUser(alice.userId);
    assert.deepEqual(JSON.parse(recipient), { endpoint: sub.endpoint, keys: sub.keys, appOrigin: 'https://alerts.example.com' });
    assert.equal(subs.WebPushSubscriptionService.recipientsForUser(alice.userId).length, 1);
    assert.deepEqual(ContactDetailsService.getDeliveryContact(alice.userId).webPushSubscriptions, [recipient]);

    // Bob cannot remove Alice's subscription.
    const bobRemove = await unsubscribe(sessionRequest('/api/web-push/unsubscribe', bob.token, { endpoint: sub.endpoint }));
    assert.deepEqual(await bobRemove.json(), { success: true, removed: false });
    assert.equal(subs.WebPushSubscriptionService.recipientsForUser(alice.userId).length, 1);

    // Same phone, now signed in as Bob: the endpoint is Bob's, not both.
    await subscribe(sessionRequest('/api/web-push/subscribe', bob.token, { subscription: sub }));
    assert.equal(subs.WebPushSubscriptionService.recipientsForUser(alice.userId).length, 0);
    assert.equal(subs.WebPushSubscriptionService.recipientsForUser(bob.userId).length, 1);

    const removed = await unsubscribe(sessionRequest('/api/web-push/unsubscribe', bob.token, { endpoint: sub.endpoint }));
    assert.deepEqual(await removed.json(), { success: true, removed: true });
    assert.equal(subs.WebPushSubscriptionService.recipientsForUser(bob.userId).length, 0);
  });

  await t.test('public push schedules a webpush task per subscription; test push goes to PWA installs only', async () => {
    const user = await newUser();
    const phone = fakeSubscription();
    const laptop = fakeSubscription('https://fcm.googleapis.com/fcm/send/laptop');
    await subscribe(sessionRequest('/api/web-push/subscribe', user.token, { subscription: phone }, { Origin: 'https://alerts.example.com' }));
    await subscribe(sessionRequest('/api/web-push/subscribe', user.token, { subscription: laptop }, { Origin: 'https://alerts.example.com' }));
    const { key } = await ApiSecurity.createApiKey(user.userId, 'test');

    const pushed = await publicPush(new NextRequest('http://localhost/api/notifications/push', {
      method: 'POST',
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ purposeId: 'disk', title: 'Disk full', message: '/var at 99%', severity: 'critical', recipients: {} })
    }));
    const pushBody = await pushed.json();
    assert.deepEqual(pushBody.channels, ['webpush']);
    await project();
    const tasks = await queries.getDeliveryTasksForNotification(pushBody.notificationId);
    assert.deepEqual(tasks.map(t => [t.channel, subs.endpointOfRecipient(t.recipient)]).sort(),
      [['webpush', laptop.endpoint], ['webpush', phone.endpoint]].sort());

    const testPush = await sendTest(sessionRequest('/api/web-push/test', user.token, { endpoint: phone.endpoint }));
    const testBody = await testPush.json();
    assert.equal(testBody.devices, 1);
    await project();
    const testTasks = await queries.getDeliveryTasksForNotification(testBody.notificationId);
    assert.deepEqual(testTasks.map(t => [t.channel, subs.endpointOfRecipient(t.recipient)]), [['webpush', phone.endpoint]]);

    const nobody = await newUser();
    assert.equal((await sendTest(sessionRequest('/api/web-push/test', nobody.token, {}))).status, 400);
  });

  await t.test('a 404/410 from the push service deletes the subscription; other failures keep it', async () => {
    const user = await newUser();
    const sub = fakeSubscription();
    await subscribe(sessionRequest('/api/web-push/subscribe', user.token, { subscription: sub }));
    const schedule = async () => {
      const notificationId = randomUUID();
      await commands.dispatch({ userId: user.userId, aggregateId: notificationId, type: 'PushNotification', payload: {
        purposeId: 'p', title: 'T', message: 'M', severity: 'low',
        deliveries: subs.WebPushSubscriptionService.recipientsForUser(user.userId).map(recipient => ({ channel: 'webpush', recipient }))
      } });
      await project();
      const [task] = await queries.getDeliveryTasksForNotification(notificationId);
      return task;
    };
    const report = (body: Record<string, unknown>) => {
      const text = JSON.stringify(body);
      return pushResult(new NextRequest('http://localhost/api/internal/push-result', {
        method: 'POST', body: text,
        headers: { 'X-API-Key': 'web-push-test-key', 'X-Signature': createSignature(text), 'Content-Type': 'application/json' }
      }));
    };

    const transient = await schedule();
    await report({ taskId: transient.id, notificationId: transient.notificationId, success: false, errorMessage: 'HTTP 500' });
    assert.equal(subs.WebPushSubscriptionService.isSubscribed(user.userId, sub.endpoint), true);

    const succeeded = await schedule();
    await report({ taskId: succeeded.id, notificationId: succeeded.notificationId, success: true, webPushSubscriptionExpired: true });
    assert.equal(subs.WebPushSubscriptionService.isSubscribed(user.userId, sub.endpoint), true);

    const gone = await schedule();
    const response = await report({ taskId: gone.id, notificationId: gone.notificationId, success: false,
      errorMessage: 'web push subscription expired (HTTP 410)', webPushSubscriptionExpired: true });
    assert.deepEqual(await response.json(), { success: true });
    assert.equal(subs.WebPushSubscriptionService.isSubscribed(user.userId, sub.endpoint), false);
    await project();
    assert.equal((await queries.getDeliveryTaskById(gone.id))!.status, 'failed');
  });

  await t.test('inbox pages through history newest-first without gaps or duplicates, per user', async () => {
    const user = await newUser();
    const other = await newUser();
    for (let i = 0; i < 75; i++) {
      await commands.dispatch({ userId: user.userId, aggregateId: randomUUID(), type: 'PushNotification', payload: {
        purposeId: 'p', title: `Alert ${i}`, message: 'M', severity: 'low', deliveries: []
      } });
      await new Promise(resolve => setTimeout(resolve, 2)); // distinct push times, as real requests have
    }
    await commands.dispatch({ userId: other.userId, aggregateId: randomUUID(), type: 'PushNotification', payload: {
      purposeId: 'p', title: 'Not yours', message: 'M', severity: 'low', deliveries: []
    } });
    await project();

    const seen: string[] = [];
    let before: string | null = null;
    const sizes: number[] = [];
    do {
      const url: string = `/api/notifications?limit=30${before ? `&before=${before}` : ''}`;
      const page = await (await listNotifications(sessionRequest(url, user.token))).json();
      sizes.push(page.notifications.length);
      assert.equal(page.unreadCount, 75);
      seen.push(...page.notifications.map((n: { title: string }) => n.title));
      before = page.nextCursor;
    } while (before);
    assert.deepEqual(sizes, [30, 30, 15]);
    assert.equal(new Set(seen).size, 75);
    assert.ok(!seen.includes('Not yours'));
    // All 75 were projected in one batch: order is still push order (event time), newest first.
    assert.deepEqual(seen, Array.from({ length: 75 }, (_, i) => `Alert ${74 - i}`));
    const all = (await queries.getNotificationsPage(user.userId, { limit: 100 })).notifications;
    assert.deepEqual(all.map(n => n.title), seen);
    for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].createdAt >= all[i].createdAt);

    // Garbage cursor = first page; limit is clamped.
    const garbage = await (await listNotifications(sessionRequest('/api/notifications?before=nonsense&limit=5000', user.token))).json();
    assert.equal(garbage.notifications.length, 75);
    assert.equal((await listNotifications(sessionRequest('/api/notifications', null))).status, 401);
  });

  await t.test('mark one read (owner only) and mark all read up to a point in time', async () => {
    const user = await newUser();
    const other = await newUser();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      ids.push(id);
      await commands.dispatch({ userId: user.userId, aggregateId: id, type: 'PushNotification', payload: {
        purposeId: 'p', title: `N${i}`, message: 'M', severity: 'medium', deliveries: []
      } });
      await project();
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    assert.equal((await markRead(sessionRequest('/api/notifications/read', other.token, { notificationId: ids[0] }))).status, 404);
    // Even an event forged into another user's stream cannot flip this user's row.
    await commands.dispatch({ userId: other.userId, aggregateId: ids[0], type: 'MarkNotificationRead', payload: { notificationId: ids[0] } });
    await project();
    assert.equal((await queries.getNotificationForUser(user.userId, ids[0]))!.status, 'pending');

    assert.equal((await markRead(sessionRequest('/api/notifications/read', user.token, { notificationId: ids[0] }))).status, 200);
    await project();
    assert.equal((await queries.getNotificationForUser(user.userId, ids[0]))!.status, 'read');
    assert.equal(await queries.getUnreadCount(user.userId), 2);

    // "Mark all read" from a screen whose newest item was N1: N2 arrived later and stays unread.
    const n1 = (await queries.getNotificationForUser(user.userId, ids[1]))!;
    assert.equal((await markRead(sessionRequest('/api/notifications/read', user.token, { all: true, upTo: n1.createdAt.toISOString() }))).status, 200);
    await project();
    assert.equal((await queries.getNotificationForUser(user.userId, ids[1]))!.status, 'read');
    assert.equal((await queries.getNotificationForUser(user.userId, ids[2]))!.status, 'pending');
    const unread = await (await listNotifications(sessionRequest('/api/notifications?unread=1', user.token))).json();
    assert.deepEqual(unread.notifications.map((n: { id: string }) => n.id), [ids[2]]);

    assert.equal((await markRead(sessionRequest('/api/notifications/read', user.token, { all: true, upTo: 'yesterday-ish' }))).status, 400);
    assert.equal((await markRead(sessionRequest('/api/notifications/read', user.token, {}))).status, 400);
  });

  await t.test('existing read models are rebuilt to accept webpush tasks without losing rows', async () => {
    const legacyDir = await mkdtemp(path.join(os.tmpdir(), 'alerttray-legacy-'));
    t.after(() => rm(legacyDir, { recursive: true, force: true }));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(legacyDir, 'read_model'), { recursive: true });
    const legacy = new Database(path.join(legacyDir, 'read_model', 'read.db'));
    legacy.exec(`
      CREATE TABLE delivery_tasks (
        id TEXT PRIMARY KEY, notification_id TEXT NOT NULL, user_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK(channel IN ('apns', 'call', 'sms', 'email', 'emergency')),
        recipient TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL,
        severity TEXT NOT NULL CHECK(severity IN ('low', 'medium', 'high', 'critical')),
        data JSON, status TEXT CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
        attempts INTEGER DEFAULT 0, last_attempt_at TIMESTAMP, completed_at TIMESTAMP, error_message TEXT,
        created_at TIMESTAMP, updated_at TIMESTAMP, provider_message_id TEXT, bounced_at TIMESTAMP
      );
      INSERT INTO delivery_tasks (id, notification_id, user_id, channel, recipient, title, message, severity, status, provider_message_id, created_at, updated_at)
      VALUES ('t1', 'n1', 'u1', 'email', 'a@example.com', 'T', 'M', 'low', 'completed', '<m@x>', '2026-01-01', '2026-01-01');
    `);
    legacy.close();

    // connection.ts captured DATABASE_PATH at import, so load a fresh copy for this directory.
    const script = `
      process.env.DATABASE_PATH = ${JSON.stringify(legacyDir)};
      const mod = await import(${JSON.stringify(path.resolve(__dirname, '../lib/infrastructure/database/connection.ts'))});
      const { getReadModelDatabase } = mod.getReadModelDatabase ? mod : mod.default;
      const db = getReadModelDatabase();
      db.prepare("INSERT INTO delivery_tasks (id, notification_id, user_id, channel, recipient, title, message, severity, status) VALUES ('t2','n2','u1','webpush','{}','T','M','low','pending')").run();
      const rows = db.prepare('SELECT id, channel, provider_message_id FROM delivery_tasks ORDER BY id').all();
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'delivery_tasks' AND name LIKE 'idx_%' ORDER BY name").all().map(r => r.name);
      db.close();
      getReadModelDatabase().close(); // second open: no rebuild needed
      console.log(JSON.stringify({ rows, indexes }));
    `;
    const { execFileSync } = await import('node:child_process');
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8'
    });
    const result = JSON.parse(output.trim().split('\n').pop()!);
    assert.deepEqual(result.rows, [
      { id: 't1', channel: 'email', provider_message_id: '<m@x>' },
      { id: 't2', channel: 'webpush', provider_message_id: null }
    ]);
    assert.deepEqual(result.indexes, ['idx_delivery_provider_message', 'idx_delivery_task_channel', 'idx_delivery_task_notification', 'idx_delivery_task_status']);
    assert.equal((output.match(/Rebuilt delivery_tasks/g) ?? []).length, 1);

    // Fresh databases are created with webpush allowed.
    const db = getReadModelDatabase();
    const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'delivery_tasks'`).get() as { sql: string }).sql;
    db.close();
    assert.match(sql, /'webpush'/);
    getSystemDatabase().close();
  });
});
