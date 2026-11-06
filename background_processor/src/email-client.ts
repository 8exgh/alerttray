import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { emailRecipients, isEmailSuppressed } from './email-suppression';

/**
 * Email via SMTP. Follows the house convention (8examples, daycare):
 * Gmail SMTP on 465 authenticated with GMAIL_USER / GMAIL_APP_PASSWORD and
 * the from-address derived from the authenticated user. SMTP_HOST/SMTP_PORT
 * can override the host for a non-Gmail relay.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailResult {
  messageId: string;
  accepted: string[];
}

export class EmailClient {
  private transporter: Transporter | null = null;
  private user: string;
  private pass: string;
  private host: string;
  private port: number;
  private from: string;
  
  constructor(private checkSuppression: (recipients: string[]) => Promise<boolean>) {
    this.user = process.env.GMAIL_USER || process.env.SMTP_USER || '';
    this.pass = process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS || '';
    this.host = process.env.SMTP_HOST || 'smtp.gmail.com';
    this.port = Number(process.env.SMTP_PORT || 465);
    this.from = process.env.EMAIL_FROM || `AlertTray <${this.user}>`;
    
    if (!this.isConfigured()) {
      console.warn('GMAIL_USER/GMAIL_APP_PASSWORD not configured — email deliveries will fail');
    }
  }
  
  isConfigured(): boolean {
    return !!(this.user && this.pass);
  }
  
  async send(message: EmailMessage): Promise<EmailResult> {
    // Enforce this at the last boundary before SMTP, including tasks queued
    // before the address was blocked. Failed tasks are terminal in the queue.
    let suppressed = isEmailSuppressed(message.to);
    if (!suppressed) {
      try {
        // Check every send, including queued tasks and reused transports. A
        // stale cache or unavailable backend must not bypass an automatic block.
        suppressed = await this.checkSuppression(emailRecipients(message.to));
      } catch {
        throw new Error('Email suppression check unavailable');
      }
    }
    if (suppressed) {
      console.info('[email] Delivery suppressed by the worker do-not-email list');
      // The result is stored with the notification: keep the private policy
      // and list out of that error, and do not claim the email was delivered.
      throw new Error('Email delivery unavailable');
    }

    if (!this.isConfigured()) {
      throw new Error('GMAIL_USER/GMAIL_APP_PASSWORD not configured');
    }
    
    const returnPath = process.env.EMAIL_BOUNCE_RETURN_PATH ||
      (this.host.toLowerCase() === 'smtp.gmail.com' ? this.user : undefined);
    const info = await this.getTransporter().sendMail({
      from: this.from,
      to: message.to,
      // Bounce notices must return to the monitored sending account even
      // when EMAIL_FROM uses a display alias or another address.
      ...(returnPath ? { envelope: { from: returnPath, to: message.to } } : {}),
      subject: message.subject,
      text: message.text,
      html: message.html
    });
    
    return {
      messageId: info.messageId,
      accepted: (info.accepted ?? []).map(String)
    };
  }
  
  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.host,
        port: this.port,
        secure: this.port === 465,
        auth: { user: this.user, pass: this.pass }
      });
    }
    return this.transporter;
  }
}
