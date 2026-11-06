import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

test('automatic suppression is persistent, private and limited to recipient failures', async t => {
  const previous = { ...process.env };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alerttray-suppression-'));
  process.env.DATABASE_PATH = directory;
  process.env.BACKGROUND_PROCESSOR_API_KEY = 'suppression-test-key';
  t.after(async () => { process.env = previous; await rm(directory, { recursive: true, force: true }); });
  const { CommandBus } = await import('../lib/cqrs/command-bus');
  const { QueryBus } = await import('../lib/cqrs/query-bus');
  const { ProjectionEngine } = await import('../lib/cqrs/projection-engine');
  const { getSystemDatabase } = await import('../lib/infrastructure/database/connection');
  const { hasSuppressedEmail } = await import('../lib/delivery/email-suppressions');
  const { recordEmailBounce } = await import('../lib/delivery/email-bounces');
  const { EventStore } = await import('../lib/cqrs/event-store');
  const { NextRequest } = await import('next/server');
  const { createSignature } = await import('../lib/infrastructure/security/api-security');
  const { POST: check } = await import('../app/api/internal/email-suppressions/check/route');
  const { POST: reportResult } = await import('../app/api/internal/push-result/route');
  const { getProjectionEngine } = await import('../lib/startup');
  const commands = new CommandBus();
  const queries = new QueryBus();
  const projection = new ProjectionEngine();
  const project = async () => { await projection.start(); projection.stop(); };
  t.after(() => { projection.stop(); getProjectionEngine()?.stop(); });
  const userId = randomUUID();

  const schedule = async () => {
    const notificationId = randomUUID();
    const recipient = `${randomUUID()}@example.com`;
    await commands.dispatch({ userId, aggregateId: notificationId, type: 'PushNotification', payload: {
      purposeId: 'test', title: 'Alert', message: 'Test', severity: 'low', deliveries: [{ channel: 'email', recipient }]
    } });
    await project();
    const [task] = await queries.getDeliveryTasksForNotification(notificationId);
    const originalMessageId = `<${randomUUID()}@example.com>`;
    const complete = async () => {
      await commands.dispatch({ userId, aggregateId: task.id, type: 'CompleteDeliveryTask', payload: {
        taskId: task.id, notificationId, channel: 'email', providerMessageId: originalMessageId
      } });
      await project();
    };
    return { task, notificationId, recipient, originalMessageId, complete };
  };
  const request = (route: string, input: unknown, authenticated = true) => {
    const body = JSON.stringify(input);
    return new NextRequest(`http://localhost/api/internal/${route}`, {
      method: 'POST', body,
      headers: authenticated ? { 'X-API-Key': 'suppression-test-key', 'X-Signature': createSignature(body), 'Content-Type': 'application/json' } : {}
    });
  };

  await t.test('confirmed bounces block immediately, without waiting for projection, across database connections', async () => {
    const sent = await schedule();
    await sent.complete();
    const report = { originalMessageId: sent.originalMessageId, recipient: sent.recipient, status: '5.1.1', diagnostic: 'smtp; 550 User unknown' };
    assert.equal(await recordEmailBounce({ ...report, originalMessageId: '<unknown@example.com>' }), false);
    assert.equal(hasSuppressedEmail([sent.recipient]), false);
    await recordEmailBounce(report);
    assert.equal(hasSuppressedEmail([sent.recipient.toUpperCase()]), true);
    assert.equal(hasSuppressedEmail(['allowed@example.com']), false);
    await recordEmailBounce(report);
    const db = getSystemDatabase();
    const records = db.prepare('SELECT * FROM email_suppressions WHERE recipient = ?').all(sent.recipient);
    assert.equal(records.length, 1);
    db.close();
    assert.equal(hasSuppressedEmail([sent.recipient]), true, 'the block survives reopening the database');
  });

  await t.test('only definite permanent recipient statuses block future messages', async () => {
    const cases: [string, boolean][] = [
      ['5.1.2', true], ['5.1.3', true], ['5.1.6', true], ['5.1.10', true], ['5.2.1', true],
      ['5.2.2', false], ['5.2.3', false], ['5.7.1', false], ['5.1.7', false], ['5.0.0', false]
    ];
    for (const [status, suppressed] of cases) {
      const sent = await schedule();
      await sent.complete();
      await recordEmailBounce({ originalMessageId: sent.originalMessageId, recipient: sent.recipient, status, diagnostic: `smtp; ${status}` });
      assert.equal(hasSuppressedEmail([sent.recipient]), suppressed, `status ${status}`);
    }
  });

  await t.test('the check endpoint requires worker auth/signature and exposes only a decision', async () => {
    const sent = await schedule();
    await sent.complete();
    await recordEmailBounce({ originalMessageId: sent.originalMessageId, recipient: sent.recipient, status: '5.1.1', diagnostic: 'private diagnostic' });
    const body = { recipients: [sent.recipient] };
    assert.equal((await check(request('email-suppressions/check', body, false))).status, 401);
    const tampered = request('email-suppressions/check', body);
    tampered.headers.set('X-Signature', 'wrong');
    assert.equal((await check(tampered)).status, 401);
    assert.equal((await check(request('email-suppressions/check', { recipients: [] }))).status, 400);
    assert.equal((await check(request('email-suppressions/check', { recipients: ['invalid'] }))).status, 400);
    assert.deepEqual(await (await check(request('email-suppressions/check', body))).json(), { success: true, suppressed: true });
    assert.deepEqual(await (await check(request('email-suppressions/check', { recipients: ['allowed@example.com'] }))).json(), { success: true, suppressed: false });
  });

  await t.test('immediate SMTP rejections suppress the matched task recipient only', async () => {
    const sent = await schedule();
    const failure = { recipient: sent.recipient, status: '5.1.1', diagnostic: '550 5.1.1 No such user' };
    const body = { taskId: sent.task.id, notificationId: sent.notificationId, success: false, errorMessage: failure.diagnostic, emailFailure: failure };
    const wrongRecipient = { ...body, emailFailure: { ...failure, recipient: 'unrelated@example.com' } };
    assert.equal((await reportResult(request('push-result', wrongRecipient))).status, 400);
    assert.equal(hasSuppressedEmail(['unrelated@example.com']), false);
    const response = await reportResult(request('push-result', body));
    getProjectionEngine()?.stop();
    assert.deepEqual(await response.json(), { success: true });
    assert.equal(hasSuppressedEmail([sent.recipient]), true);
    const events = await new EventStore().getEvents(userId, 0, sent.task.id);
    assert.equal(events.find(event => event.eventType === 'DeliveryTaskFailedEvent')?.eventData.emailFailure.status, '5.1.1');
  });

  await t.test('migration recovers qualifying failures already behind the mailbox checkpoint', async () => {
    const sent = await schedule();
    await sent.complete();
    await commands.dispatch({ userId, aggregateId: sent.task.id, type: 'RecordEmailBounce', payload: {
      taskId: sent.task.id, notificationId: sent.notificationId, originalMessageId: sent.originalMessageId,
      recipient: sent.recipient, status: '5.1.1', diagnostic: 'smtp; historical bounce'
    } });
    const db = getSystemDatabase();
    db.exec('DROP TABLE email_suppressions');
    db.close();
    assert.equal(hasSuppressedEmail([sent.recipient]), true);
    assert.equal(hasSuppressedEmail(['unrelated@example.com']), false);
  });
});
