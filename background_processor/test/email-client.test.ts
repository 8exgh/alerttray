import assert from 'node:assert/strict';
import { test } from 'node:test';
import nodemailer from 'nodemailer';
import { EmailClient } from '../src/email-client';

test('email suppression is enforced before SMTP', async t => {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  process.env.GMAIL_USER = 'sender@example.com';
  process.env.GMAIL_APP_PASSWORD = 'test-password';
  delete process.env.EMAIL_FROM;
  delete process.env.SMTP_HOST;
  delete process.env.EMAIL_BOUNCE_RETURN_PATH;
  delete process.env.EMAIL_SUPPRESSION_LIST;

  const sendMail = t.mock.fn(async () => ({
    messageId: 'test-message-id',
    accepted: ['allowed@qq.com']
  }));
  const createTransport = t.mock.method(nodemailer, 'createTransport', () => ({ sendMail }));
  const client = new EmailClient(async () => false);
  const message = { subject: 'Alert', text: 'Notification' };

  await t.test('blocks the listed address and SMTP address formats', async () => {
    for (const to of [
      '2907618125@qq.com',
      '  2907618125@QQ.COM  ',
      'Recipient <2907618125@qq.com>',
      '"2907618125"@qq.com',
      'allowed@example.com, 2907618125@qq.com',
      'Alerts: allowed@example.com, 2907618125@qq.com;'
    ]) {
      await assert.rejects(client.send({ ...message, to }), {
        message: 'Email delivery unavailable'
      });
    }
    assert.equal(createTransport.mock.callCount(), 0);
    assert.equal(sendMail.mock.callCount(), 0);
  });

  await t.test('extends the list with private worker configuration', async () => {
    process.env.EMAIL_SUPPRESSION_LIST = ' SECOND@Example.com,third@example.com; fourth@example.com\nfifth@example.com ';
    for (const to of [
      'second@example.com',
      'third@example.com',
      'FOURTH@example.com',
      'fifth@example.com',
      '2907618125@qq.com'
    ]) {
      await assert.rejects(client.send({ ...message, to }), {
        message: 'Email delivery unavailable'
      });
    }
    assert.equal(createTransport.mock.callCount(), 0);
    assert.equal(sendMail.mock.callCount(), 0);
    delete process.env.EMAIL_SUPPRESSION_LIST;
  });

  await t.test('leaves unlisted recipients and message content intact', async () => {
    const allowed = { ...message, to: 'allowed@qq.com', html: '<p>Notification</p>' };
    assert.deepEqual(await client.send(allowed), {
      messageId: 'test-message-id',
      accepted: ['allowed@qq.com']
    });
    assert.equal(createTransport.mock.callCount(), 1);
    assert.equal(sendMail.mock.callCount(), 1);
    assert.deepEqual(sendMail.mock.calls[0].arguments, [{
      from: 'AlertTray <sender@example.com>',
      envelope: { from: 'sender@example.com', to: allowed.to },
      ...allowed
    }]);
  });

  await t.test('also blocks after the SMTP transport has been initialized', async () => {
    await assert.rejects(client.send({ ...message, to: '2907618125@qq.com' }), {
      message: 'Email delivery unavailable'
    });
    assert.equal(sendMail.mock.callCount(), 1);
  });

  await t.test('checks automatic blocks before every send, including after a worker restart', async () => {
    const suppressed = new Set<string>();
    const checks: string[][] = [];
    const lookup = async (recipients: string[]) => {
      checks.push(recipients);
      return recipients.some(address => suppressed.has(address));
    };
    const worker = new EmailClient(lookup);
    await worker.send({ ...message, to: 'new@example.com' });
    const sentBeforeBlock = sendMail.mock.callCount();
    suppressed.add('new@example.com');
    for (const instance of [worker, new EmailClient(lookup)]) {
      await assert.rejects(instance.send({ ...message, to: 'Recipient <NEW@example.com>' }), {
        message: 'Email delivery unavailable'
      });
    }
    assert.equal(sendMail.mock.callCount(), sentBeforeBlock);
    assert.deepEqual(checks.at(-1), ['new@example.com']);
  });

  await t.test('does not contact SMTP when the private suppression check is unavailable', async () => {
    const before = createTransport.mock.callCount();
    const unavailable = new EmailClient(async () => { throw new Error('Backend unavailable'); });
    await assert.rejects(unavailable.send({ ...message, to: 'allowed@example.com' }), {
      message: 'Email suppression check unavailable'
    });
    assert.equal(createTransport.mock.callCount(), before);
  });

  await t.test('suppression takes precedence over missing SMTP credentials', async () => {
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    const unconfigured = new EmailClient(async () => false);
    await assert.rejects(unconfigured.send({ ...message, to: '2907618125@qq.com' }), {
      message: 'Email delivery unavailable'
    });
    assert.equal(sendMail.mock.callCount(), 2);
  });
});
