import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebPushError } from 'web-push';
import { formatWebPushPayload } from '../src/message-format';
import { WebPushClient, WebPushSubscriptionExpiredError, parseWebPushRecipient, type VapidConfig } from '../src/web-push-client';
import { DeliveryDispatcher, mask } from '../src/delivery-dispatcher';
import type { DeliveryTask } from '../src/api-client';

const recipient = JSON.stringify({
  endpoint: 'https://web.push.apple.com/QGx7abc',
  keys: { p256dh: 'BKey', auth: 'auth' },
  appOrigin: 'https://alerts.example.com'
});
const vapid: VapidConfig = { publicKey: 'pub', privateKey: 'priv', subject: null };

test('web push payload is declarative when the app origin is known, plain otherwise, and stays small', () => {
  const alert = { title: 'Disk full', message: '/var at 99%', severity: 'critical' as const, notificationId: 'n-1' };
  assert.deepEqual(JSON.parse(formatWebPushPayload(alert, 'https://alerts.example.com')), {
    web_push: 8030,
    notification: {
      title: '🚨 Disk full',
      body: '/var at 99%',
      navigate: 'https://alerts.example.com/inbox?n=n-1',
      tag: 'n-1',
      silent: false,
      data: { notificationId: 'n-1', severity: 'critical', url: '/inbox?n=n-1' }
    }
  });
  assert.deepEqual(JSON.parse(formatWebPushPayload({ ...alert, severity: 'low' }, null)), {
    title: 'Disk full', body: '/var at 99%', tag: 'n-1', notificationId: 'n-1', severity: 'low', url: '/inbox?n=n-1'
  });
  const huge = formatWebPushPayload({ ...alert, title: 'T'.repeat(5000), message: '€'.repeat(5000) }, 'https://alerts.example.com');
  // Web Push caps the encrypted record at 4096 bytes; leave room for encryption overhead.
  assert.ok(Buffer.byteLength(huge) <= 3000, `payload is ${Buffer.byteLength(huge)} bytes`);
  assert.match(JSON.parse(huge).notification.body, /^€+…$/);
  assert.match(JSON.parse(huge).notification.title, /^🚨 T+…$/);
  // Characters that JSON-escape (quotes, control chars) expand; the encoded size is what counts.
  const escaped = formatWebPushPayload({ ...alert, message: '"\u0001'.repeat(3000) }, 'https://alerts.example.com');
  assert.ok(Buffer.byteLength(escaped) <= 3000, `payload is ${Buffer.byteLength(escaped)} bytes`);
});

test('WebPushClient signs with the server VAPID pair, maps urgency, and classifies push service errors', async () => {
  let loads = 0;
  const calls: { subscription: unknown; payload: unknown; options: any }[] = [];
  let respond: () => Promise<any> = async () => ({ statusCode: 201, body: '', headers: { 'apns-id': 'apns-123' } });
  const client = new WebPushClient(async () => { loads++; return vapid; }, (async (subscription: unknown, payload: unknown, options: unknown) => {
    calls.push({ subscription, payload, options });
    return respond();
  }) as any);

  process.env.GMAIL_USER = 'sender@example.com';
  delete process.env.VAPID_SUBJECT;
  assert.deepEqual(await client.sendNotification(recipient, '{"x":1}', 'critical'), { providerMessageId: 'apns-123' });
  assert.deepEqual(calls[0].subscription, { endpoint: 'https://web.push.apple.com/QGx7abc', keys: { p256dh: 'BKey', auth: 'auth' } });
  assert.equal(calls[0].payload, '{"x":1}');
  assert.deepEqual(calls[0].options.vapidDetails, { subject: 'mailto:sender@example.com', publicKey: 'pub', privateKey: 'priv' });
  assert.equal(calls[0].options.urgency, 'high');
  assert.equal(calls[0].options.TTL, 86400);

  respond = async () => ({ statusCode: 201, body: '', headers: { location: 'https://fcm/msg/1' } });
  assert.deepEqual(await client.sendNotification(recipient, '{}', 'low'), { providerMessageId: 'https://fcm/msg/1' });
  assert.equal(calls[1].options.urgency, 'normal');
  assert.equal(loads, 1, 'VAPID keys are cached');

  for (const status of [404, 410]) {
    respond = async () => { throw new WebPushError('gone', status, {}, 'Unregistered', 'https://web.push.apple.com/QGx7abc'); };
    await assert.rejects(client.sendNotification(recipient, '{}', 'low'), (error: unknown) =>
      error instanceof WebPushSubscriptionExpiredError && error.statusCode === status);
  }

  respond = async () => { throw new WebPushError('bad', 500, {}, 'oops', 'https://web.push.apple.com/QGx7abc'); };
  await assert.rejects(client.sendNotification(recipient, '{}', 'low'), (error: unknown) =>
    !(error instanceof WebPushSubscriptionExpiredError) && /web\.push\.apple\.com: HTTP 500 oops/.test(String(error)));
  assert.equal(loads, 1);

  // Rejected credentials: maybe the server's pair changed, so the next send reloads it.
  respond = async () => { throw new WebPushError('jwt', 403, {}, '{"reason":"BadJwtToken"}', 'https://web.push.apple.com/QGx7abc'); };
  await assert.rejects(client.sendNotification(recipient, '{}', 'low'), /HTTP 403/);
  respond = async () => ({ statusCode: 201, body: '', headers: {} });
  await client.sendNotification(recipient, '{}', 'low');
  assert.equal(loads, 2);

  const configured = new WebPushClient(async () => ({ ...vapid, subject: 'https://alerts.example.com' }), (async (_s: unknown, _p: unknown, options: any) => {
    calls.push({ subscription: _s, payload: _p, options });
    return { statusCode: 201, body: '', headers: {} };
  }) as any);
  await configured.sendNotification(recipient, '{}', 'medium');
  assert.equal(calls[calls.length - 1].options.vapidDetails.subject, 'https://alerts.example.com');

  assert.throws(() => parseWebPushRecipient('+15551234567'), /not a subscription/);
  assert.throws(() => parseWebPushRecipient('{"endpoint":"https://x"}'), /missing/);
});

test('dispatcher routes webpush tasks, honours dry run and masks subscriptions in logs', async () => {
  const task: DeliveryTask = {
    id: 't', notificationId: 'n-9', userId: 'u', channel: 'webpush', recipient,
    title: 'Deploy failed', message: 'build #12', severity: 'high', attempts: 0
  };
  const sent: { recipient: string; payload: string; severity: string }[] = [];
  const fakeClient = {
    sendNotification: async (r: string, payload: string, severity: string) => { sent.push({ recipient: r, payload, severity }); return { providerMessageId: 'id-1' }; }
  } as unknown as WebPushClient;

  delete process.env.DELIVERY_DRY_RUN;
  const dispatcher = new DeliveryDispatcher(async () => false, async () => vapid, fakeClient);
  assert.deepEqual(await dispatcher.dispatch(task), { providerMessageId: 'id-1' });
  assert.equal(sent[0].severity, 'high');
  assert.equal(JSON.parse(sent[0].payload).notification.navigate, 'https://alerts.example.com/inbox?n=n-9');
  assert.equal(JSON.parse(sent[0].payload).notification.title, '⚠️ Deploy failed');

  process.env.DELIVERY_DRY_RUN = '1';
  const dry = new DeliveryDispatcher(async () => false, async () => vapid, fakeClient);
  assert.deepEqual(await dry.dispatch(task), { providerMessageId: 'dry-run' });
  assert.equal(sent.length, 1);
  delete process.env.DELIVERY_DRY_RUN;

  assert.equal(mask(recipient), 'webpush:web.push.apple.com');
  assert.equal(mask('{oops'), 'webpush:?');
  assert.equal(mask('+15551234567'), '+15…567');
});
