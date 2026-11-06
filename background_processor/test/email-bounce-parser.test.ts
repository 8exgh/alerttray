import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEmailBounces } from '../src/email-bounce-parser';
import { bounceMessage } from './bounce-fixtures';

test('parses Gmail-style DSNs and folded SMTP diagnostics', async () => {
  for (const originalType of ['message/rfc822', 'text/rfc822-headers']) {
    assert.deepEqual(await parseEmailBounces(bounceMessage({ originalType })), [{
      originalMessageId: '<original@example.com>',
      recipient: '2907618125@qq.com',
      status: '5.1.1',
      diagnostic: 'smtp; 550 Mailbox unavailable or blocked by the recipient server'
    }]);
  }
});

test('does not confuse delays, successes, ordinary messages or missing IDs with failures', async () => {
  for (const options of [
    { action: 'delayed', status: '4.2.2' },
    { action: 'delivered', status: '2.0.0' },
    { action: 'failed', status: '4.0.0' },
    { messageId: 'not-a-message-id' }
  ]) assert.deepEqual(await parseEmailBounces(bounceMessage(options)), []);
  assert.deepEqual(await parseEmailBounces(Buffer.from(
    'Subject: Mail delivery failed\r\nContent-Type: text/plain\r\n\r\nAction: failed\r\nStatus: 5.1.1'
  )), []);
});

test('only returns failed recipients in a report with several outcomes', async () => {
  const reports = await parseEmailBounces(bounceMessage({ extraRecipient: [
    '', 'Final-Recipient: rfc822; ok@example.com', 'Action: delivered', 'Status: 2.0.0',
    '', 'Final-Recipient: rfc822; OTHER@EXAMPLE.COM', 'Action: failed', 'Status: 5.2.1'
  ].join('\r\n') }));
  assert.equal(reports.length, 2);
  assert.equal(reports[1].recipient, 'other@example.com');
});

test('does not take a message ID from the human-readable body', async () => {
  const source = bounceMessage().toString().replace('Message-ID: <original@example.com>', 'X-Unrelated: ignored')
    .replace('The email could not be delivered.', 'Message-ID: <original@example.com>');
  assert.deepEqual(await parseEmailBounces(Buffer.from(source)), []);
});
