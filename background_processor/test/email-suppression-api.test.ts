import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiClient } from '../src/api-client';

test('private suppression checks are signed and require a valid backend acknowledgement', async t => {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  let response: unknown = { success: true, suppressed: true };
  let responseStatus = 200;
  const requests: { url: string; body: string; key?: string; signature?: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    requests.push({ url: req.url!, body, key: req.headers['x-api-key'] as string, signature: req.headers['x-signature'] as string });
    res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  process.env.API_KEY = 'test-api-key';
  process.env.ALERTTRAY_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = new ApiClient();
  assert.equal(await api.isEmailSuppressed(['invalid@example.com']), true);
  assert.equal(requests[0].url, '/api/internal/email-suppressions/check');
  assert.equal(requests[0].key, process.env.API_KEY);
  assert.equal(requests[0].signature, createHmac('sha256', process.env.API_KEY).update(requests[0].body).digest('hex'));
  assert.deepEqual(JSON.parse(requests[0].body), { recipients: ['invalid@example.com'] });
  response = { success: true, suppressed: false };
  assert.equal(await api.isEmailSuppressed(['allowed@example.com']), false);
  for (const invalid of [{ error: 'Unavailable' }, { success: false, suppressed: false }, { success: true }]) {
    response = invalid;
    await assert.rejects(api.isEmailSuppressed(['allowed@example.com']));
  }
  response = { success: true, suppressed: false };
  responseStatus = 503;
  await assert.rejects(api.isEmailSuppressed(['allowed@example.com']));
  responseStatus = 200;
  response = { error: 'Failed to update push result' };
  await assert.rejects(api.reportResult({ taskId: 'task', notificationId: 'notification', success: false }), /not acknowledged/);
});
