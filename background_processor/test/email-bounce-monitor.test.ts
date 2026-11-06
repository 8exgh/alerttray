import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ImapFlow } from 'imapflow';
import { bounceMonitorConfig, EmailBounceMonitor, type BounceMonitorConfig } from '../src/email-bounce-monitor';
import { bounceMessage } from './bounce-fixtures';

test('configuration uses sender credentials, supports overrides and disables all access for dry runs', () => {
  const sender = { GMAIL_USER: 'sender@example.com', GMAIL_APP_PASSWORD: 'secret' };
  assert.equal(bounceMonitorConfig(sender)?.host, 'imap.gmail.com');
  assert.equal(bounceMonitorConfig(sender)?.user, sender.GMAIL_USER);
  assert.equal(bounceMonitorConfig({ SMTP_USER: sender.GMAIL_USER, SMTP_PASS: 'secret' })?.host, 'imap.gmail.com');
  assert.equal(bounceMonitorConfig({ ...sender, DELIVERY_DRY_RUN: '1' }), null);
  assert.equal(bounceMonitorConfig({ ...sender, EMAIL_BOUNCE_MONITOR: '0' }), null);
  assert.equal(bounceMonitorConfig({ ...sender, SMTP_HOST: 'smtp.example.com' }), null);
  assert.equal(bounceMonitorConfig({ ...sender, EMAIL_BOUNCE_IMAP_HOST: 'imap.example.com', EMAIL_BOUNCE_IMAP_USER: 'bounces@example.com' })?.user, 'bounces@example.com');
  assert.equal(bounceMonitorConfig({}), null);
});

test('IMAP polling is read-only, checkpoints only acknowledged reports, and recovers after restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alerttray-imap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config: BounceMonitorConfig = {
    host: 'imap.example.com', port: 993, user: 'sender@example.com', pass: 'test',
    checkpointPath: path.join(directory, 'checkpoint.json'), lookbackDays: 30, pollMs: 60_000
  };
  const opened: unknown[][] = [];
  const searches: Record<string, unknown>[] = [];
  let validity = 100n;
  let highUid = 10;
  let received = new Date();
  let reports = 0;
  let rejected = true;
  let matched = true;
  let fetched = 0;
  const factory = () => ({
    usable: true,
    on() {},
    async connect() {},
    async list() { return [{ path: '[Gmail]/All Mail', specialUse: '\\All' }]; },
    async mailboxOpen(...args: unknown[]) { opened.push(args); return { uidValidity: validity, uidNext: highUid + 1 }; },
    async search(query: Record<string, unknown>) {
      searches.push(query);
      return [highUid];
    },
    async fetchOne(_uid: number, query: { source?: boolean }) {
      fetched++;
      return query.source ? { source: bounceMessage() } : { size: 1000, internalDate: received };
    },
    async logout() {},
    close() {}
  }) as unknown as ImapFlow;
  const reporter = { async reportEmailBounce() {
    reports++;
    if (rejected) throw new Error('API unavailable');
    return matched;
  } };
  const monitor = new EmailBounceMonitor(config, reporter, factory);
  await assert.rejects(monitor.poll(), /API unavailable/);
  await assert.rejects(readFile(config.checkpointPath), { code: 'ENOENT' });
  assert.deepEqual(opened[0], ['[Gmail]/All Mail', { readOnly: true }]);
  assert.equal(searches[0].uid, '1:10');
  assert.ok(searches[0].since instanceof Date);

  rejected = false;
  await monitor.poll();
  assert.equal(JSON.parse(await readFile(config.checkpointPath, 'utf8')).lastUid, 10);
  assert.equal(reports, 2);
  const fetchedBefore = fetched;
  await new EmailBounceMonitor(config, reporter, factory).poll();
  assert.equal(fetched, fetchedBefore, 'does not refetch acknowledged messages after restart');

  highUid = 11;
  matched = false;
  await monitor.poll();
  assert.equal(JSON.parse(await readFile(config.checkpointPath, 'utf8')).lastUid, 10, 'recent unmatched notices wait for projection');
  assert.equal(searches.at(-1)?.uid, '11:11');
  assert.equal(searches.at(-1)?.since, undefined, 'continuing scans include every new UID after downtime');
  received = new Date(Date.now() - 20 * 60_000);
  await monitor.poll();
  assert.equal(JSON.parse(await readFile(config.checkpointPath, 'utf8')).lastUid, 11, 'unrelated old reports do not block the mailbox');

  validity = 101n;
  await monitor.poll();
  assert.equal(searches.at(-1)?.uid, '1:11', 'UIDVALIDITY changes reset the cursor');
  assert.ok(searches.at(-1)?.since instanceof Date);
});

test('overlapping poll ticks do not open duplicate IMAP connections', async () => {
  const config: BounceMonitorConfig = {
    host: 'imap.example.com', port: 993, user: 'sender@example.com', pass: 'test',
    checkpointPath: '/unused', lookbackDays: 30, pollMs: 60_000
  };
  let release!: () => void;
  let connected = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const monitor = new EmailBounceMonitor(config, { async reportEmailBounce() { return true; } }, () => ({
    usable: false,
    on() {},
    async connect() { connected++; await pending; throw new Error('Disconnected'); },
    close() {}
  }) as unknown as ImapFlow);
  const first = monitor.pollIfDue();
  await monitor.pollIfDue();
  assert.equal(connected, 1);
  release();
  await first;
  await monitor.pollIfDue();
  assert.equal(connected, 1, 'failed connections are retried on the next interval');
});
