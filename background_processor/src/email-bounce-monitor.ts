import { ImapFlow } from 'imapflow';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { parseEmailBounces, type EmailBounce } from './email-bounce-parser';

interface Checkpoint { mailboxKey: string; lastUid: number }
interface BounceReporter { reportEmailBounce(bounce: EmailBounce): Promise<boolean> }

export interface BounceMonitorConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  mailbox?: string;
  checkpointPath: string;
  lookbackDays: number;
  pollMs: number;
}

export function bounceMonitorConfig(env = process.env): BounceMonitorConfig | null {
  if (env.DELIVERY_DRY_RUN === '1' || env.EMAIL_BOUNCE_MONITOR === '0') return null;
  const gmail = !env.SMTP_HOST || env.SMTP_HOST.toLowerCase() === 'smtp.gmail.com';
  const host = env.EMAIL_BOUNCE_IMAP_HOST || (gmail ? 'imap.gmail.com' : '');
  const user = env.EMAIL_BOUNCE_IMAP_USER || env.GMAIL_USER || env.SMTP_USER || '';
  const pass = env.EMAIL_BOUNCE_IMAP_PASSWORD || env.GMAIL_APP_PASSWORD || env.SMTP_PASS || '';
  if (!host || !user || !pass) {
    if (env.EMAIL_BOUNCE_MONITOR === '1') console.warn('[email] Bounce monitoring requires IMAP credentials');
    return null;
  }
  return {
    host, user, pass,
    port: Number(env.EMAIL_BOUNCE_IMAP_PORT || 993),
    mailbox: env.EMAIL_BOUNCE_MAILBOX || undefined,
    checkpointPath: env.EMAIL_BOUNCE_CHECKPOINT_PATH || path.join(env.DATABASE_PATH || './data', 'email-bounce-checkpoint.json'),
    lookbackDays: 30,
    pollMs: 60_000
  };
}

/** Read-only IMAP polling; a failed API report never advances the checkpoint. */
export class EmailBounceMonitor {
  private nextPoll = 0;
  private running = false;

  constructor(
    private config: BounceMonitorConfig,
    private reporter: BounceReporter,
    private createClient = () => new ImapFlow({
      host: config.host, port: config.port, secure: true,
      auth: { user: config.user, pass: config.pass },
      logger: false, disableAutoIdle: true,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
      maxLiteralSize: 2 * 1024 * 1024
    })
  ) {}

  /** Called from the worker loop without delaying notification delivery. */
  async pollIfDue(): Promise<void> {
    if (this.running || Date.now() < this.nextPoll) return;
    this.running = true;
    try {
      await this.poll();
    } catch (error) {
      console.error('[email] Bounce check failed; will retry:', error instanceof Error ? error.message : 'unknown error');
    } finally {
      this.running = false;
      this.nextPoll = Date.now() + this.config.pollMs;
    }
  }

  async poll(): Promise<void> {
    const client = this.createClient();
    // ImapFlow can emit errors outside a pending promise. Close the connection
    // so a background socket error cannot crash the delivery worker.
    client.on('error', () => client.close());
    try {
      await client.connect();
      const mailbox = this.config.mailbox ||
        (await client.list()).find(folder => folder.specialUse === '\\All')?.path || 'INBOX';
      const opened = await client.mailboxOpen(mailbox, { readOnly: true });
      const mailboxKey = createHash('sha256')
        .update(JSON.stringify([this.config.host, this.config.port, this.config.user, mailbox, String(opened.uidValidity)]))
        .digest('hex');
      const saved = await this.loadCheckpoint();
      let lastUid = saved?.mailboxKey === mailboxKey ? saved.lastUid : 0;
      const highUid = opened.uidNext - 1;
      if (highUid <= lastUid) return;
      const since = new Date(Date.now() - this.config.lookbackDays * 86400_000);
      const matches = await client.search({
        uid: `${lastUid + 1}:${highUid}`,
        header: { 'content-type': 'multipart/report' },
        ...(lastUid === 0 ? { since } : {})
      }, { uid: true });
      if (!Array.isArray(matches)) throw new Error('IMAP search did not complete');
      const uids = matches.filter(uid => uid > lastUid && uid <= highUid).sort((a, b) => a - b);
      for (const uid of uids.slice(0, 100)) {
        const metadata = await client.fetchOne(uid, { size: true, internalDate: true }, { uid: true });
        if (metadata && (metadata.size || 0) > 2 * 1024 * 1024) {
          console.warn(`[email] Skipping oversized bounce notice UID ${uid}`);
        } else if (metadata) {
          const message = await client.fetchOne(uid, { source: true }, { uid: true });
          if (message && !message.source) throw new Error(`Missing bounce source for UID ${uid}`);
          if (message && message.source) {
            for (const bounce of await parseEmailBounces(message.source)) {
              const matched = await this.reporter.reportEmailBounce(bounce);
              // SMTP acceptance may still be projecting. Retry a recent
              // unmatched report before concluding it belongs to another app.
              const received = metadata.internalDate instanceof Date ? metadata.internalDate.getTime() : Date.now();
              if (!matched && Date.now() - received < 10 * 60_000) return;
            }
          }
        }
        lastUid = uid;
        await this.saveCheckpoint({ mailboxKey, lastUid });
      }
      if (uids.length <= 100) await this.saveCheckpoint({ mailboxKey, lastUid: highUid });
    } finally {
      try { if (client.usable) await client.logout(); }
      finally { client.close(); }
    }
  }

  private async loadCheckpoint(): Promise<Checkpoint | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.config.checkpointPath, 'utf8'));
      if (typeof value.mailboxKey !== 'string' || !Number.isSafeInteger(value.lastUid) || value.lastUid < 0) {
        throw new Error('Invalid email bounce checkpoint');
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await fs.mkdir(path.dirname(this.config.checkpointPath), { recursive: true });
    const temporary = `${this.config.checkpointPath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(checkpoint), { mode: 0o600 });
    await fs.rename(temporary, this.config.checkpointPath);
  }
}
