import assert from 'node:assert/strict';
import { test } from 'node:test';
import { smtpRecipientFailure } from '../src/email-failure';

test('captures explicit SMTP recipient failures for backend suppression classification', () => {
  const failure = { command: 'RCPT TO', responseCode: 550, response: '550 5.1.1 No such user' };
  assert.deepEqual(smtpRecipientFailure(failure, 'Person <INVALID@example.com>'), {
    recipient: 'invalid@example.com', status: '5.1.1', diagnostic: failure.response
  });
  for (const error of [
    new Error('connection failed'),
    { ...failure, command: 'AUTH PLAIN' },
    { ...failure, command: 'MAIL FROM' },
    { ...failure, command: 'DATA' },
    { ...failure, responseCode: 450, response: '450 4.2.2 Mailbox full' },
    { ...failure, response: '550 Mailbox unavailable' }
  ]) assert.equal(smtpRecipientFailure(error, 'invalid@example.com'), undefined);
  assert.equal(smtpRecipientFailure(failure, 'first@example.com, second@example.com'), undefined);
});
