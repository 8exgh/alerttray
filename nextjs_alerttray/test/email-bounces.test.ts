import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

test('bounce reports update delivery history through events and projections', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alerttray-bounces-'));
  const previousPath = process.env.DATABASE_PATH;
  const previousKey = process.env.BACKGROUND_PROCESSOR_API_KEY;
  process.env.DATABASE_PATH = directory;
  process.env.BACKGROUND_PROCESSOR_API_KEY = 'test-internal-key';
  t.after(async () => {
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    if (previousKey === undefined) delete process.env.BACKGROUND_PROCESSOR_API_KEY;
    else process.env.BACKGROUND_PROCESSOR_API_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  });
  const { CommandBus } = await import('../lib/cqrs/command-bus');
  const { QueryBus } = await import('../lib/cqrs/query-bus');
  const { EventStore } = await import('../lib/cqrs/event-store');
  const { ProjectionEngine } = await import('../lib/cqrs/projection-engine');
  const { getReadModelDatabase } = await import('../lib/infrastructure/database/connection');
  const { recordEmailBounce, parseEmailBounceReport } = await import('../lib/delivery/email-bounces');
  const commands = new CommandBus();
  const queries = new QueryBus();
  const userId = randomUUID();
  const engine = new ProjectionEngine();
  const project = async () => { await engine.start(); engine.stop(); };
  t.after(() => engine.stop());

  const schedule = async (withPush = false) => {
    const notificationId = randomUUID();
    await commands.dispatch({ userId, aggregateId: notificationId, type: 'PushNotification', payload: {
      title: 'Test alert', message: 'Body', severity: 'low', purposeId: 'test',
      deliveries: [{ channel: 'email', recipient: 'recipient@example.com' },
        ...(withPush ? [{ channel: 'apns', recipient: 'device-token' }] : [])]
    } });
    await project();
    const tasks = await queries.getDeliveryTasksForNotification(notificationId);
    const email = tasks.find(task => task.channel === 'email')!;
    const messageId = `<${randomUUID()}@example.com>`;
    const complete = async (task = email) => {
      await commands.dispatch({ userId, aggregateId: task.id, type: 'CompleteDeliveryTask', payload: {
        taskId: task.id, notificationId, channel: task.channel, providerMessageId: messageId
      } });
      await project();
    };
    const report = { originalMessageId: messageId, recipient: email.recipient, status: '5.1.1', diagnostic: 'smtp; 550 mailbox unavailable' };
    const notification = async () => (await queries.getNotifications(userId)).find(n => n.id === notificationId)!;
    return { notificationId, email, tasks, messageId, complete, report, notification };
  };

  await t.test('backfills historic SMTP message IDs when upgrading the read database', async () => {
    const sent = await schedule();
    await sent.complete();
    const db = getReadModelDatabase();
    db.exec('DROP INDEX idx_delivery_provider_message');
    db.exec('ALTER TABLE delivery_tasks DROP COLUMN provider_message_id');
    db.exec('ALTER TABLE delivery_tasks DROP COLUMN bounced_at');
    db.close();
    assert.equal((await queries.getEmailTaskByMessageId(sent.messageId, sent.email.recipient))?.id, sent.email.id);
  });

  await t.test('late bounces overturn acceptance, deduplicate and survive late success reports', async () => {
    const sent = await schedule();
    await sent.complete();
    assert.equal((await sent.notification()).status, 'delivered');
    assert.equal(await recordEmailBounce({ ...sent.report, recipient: 'someone-else@example.com' }), false);
    assert.equal(await recordEmailBounce({ ...sent.report, originalMessageId: '<unknown@example.com>' }), false);
    await Promise.all([recordEmailBounce(sent.report), recordEmailBounce(sent.report)]);
    await project();
    const task = await queries.getDeliveryTaskById(sent.email.id);
    assert.equal(task?.status, 'failed');
    assert.equal(task?.completedAt, undefined);
    assert.match(task?.errorMessage || '', /5\.1\.1.*550 mailbox unavailable/);
    assert.equal((await sent.notification()).status, 'failed');
    assert.equal((await sent.notification()).deliveredAt, undefined);
    const bounceEvents = (await new EventStore().getEvents(userId, 0, sent.email.id))
      .filter(event => event.eventType === 'EmailDeliveryBouncedEvent');
    assert.equal(bounceEvents.length, 1);
    await sent.complete();
    assert.equal((await queries.getDeliveryTaskById(sent.email.id))?.status, 'failed');
    assert.equal((await sent.notification()).status, 'failed');
  });

  await t.test('retains successful delivery over another channel and preserves read notifications', async () => {
    const sent = await schedule(true);
    await sent.complete();
    await sent.complete(sent.tasks.find(task => task.channel === 'apns')!);
    await recordEmailBounce(sent.report);
    await project();
    assert.equal((await sent.notification()).status, 'delivered');

    const read = await schedule();
    await read.complete();
    await commands.dispatch({ userId, aggregateId: read.notificationId, type: 'MarkNotificationRead', payload: { notificationId: read.notificationId } });
    await project();
    await recordEmailBounce(read.report);
    await project();
    assert.equal((await read.notification()).status, 'read');
    assert.equal((await queries.getDeliveryTaskById(read.email.id))?.status, 'failed');
  });

  await t.test('settles a notification when the last result is a failure on another channel', async () => {
    const sent = await schedule(true);
    await sent.complete();
    const push = sent.tasks.find(task => task.channel === 'apns')!;
    await commands.dispatch({ userId, aggregateId: push.id, type: 'FailDeliveryTask', payload: {
      taskId: push.id, notificationId: sent.notificationId, channel: 'apns', errorMessage: 'Unregistered device'
    } });
    await project();
    assert.equal((await sent.notification()).status, 'delivered');
    await recordEmailBounce(sent.report);
    await project();
    assert.equal((await sent.notification()).status, 'failed');
  });

  await t.test('rejects invalid reports and accepts only permanent failure statuses', () => {
    const report = { originalMessageId: '<original@example.com>', recipient: 'RECIPIENT@example.com', status: '5.1.1', diagnostic: 'smtp; failure' };
    assert.equal(parseEmailBounceReport(report)?.recipient, 'recipient@example.com');
    for (const invalid of [null, {}, { ...report, status: '4.2.2' }, { ...report, originalMessageId: 'bad' },
      { ...report, diagnostic: 'x'.repeat(1001) }, { ...report, recipient: 'bad\r\naddress@example.com' }]) {
      assert.equal(parseEmailBounceReport(invalid), null);
    }
  });

  await t.test('the internal endpoint requires authentication and a valid body signature', async () => {
    const { NextRequest } = await import('next/server');
    const { POST } = await import('../app/api/internal/email-bounces/route');
    const { createSignature } = await import('../lib/infrastructure/security/api-security');
    const { getProjectionEngine } = await import('../lib/startup');
    t.after(() => getProjectionEngine()?.stop());
    const sent = await schedule();
    await sent.complete();
    const body = JSON.stringify(sent.report);
    const request = (text: string, headers: Record<string, string> = {}) => new NextRequest('http://localhost/api/internal/email-bounces', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: text
    });
    assert.equal((await POST(request(body))).status, 401);
    assert.equal((await POST(request(body, { 'X-API-Key': 'test-internal-key', 'X-Signature': 'wrong' }))).status, 401);
    assert.equal((await POST(request('{', { 'X-API-Key': 'test-internal-key', 'X-Signature': createSignature('{') }))).status, 400);
    const response = await POST(request(body, { 'X-API-Key': 'test-internal-key', 'X-Signature': createSignature(body) }));
    getProjectionEngine()?.stop();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, matched: true });
    await project();
    assert.equal((await queries.getDeliveryTaskById(sent.email.id))?.status, 'failed');
  });
});
