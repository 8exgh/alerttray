import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

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
  
  constructor() {
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
    if (!this.isConfigured()) {
      throw new Error('GMAIL_USER/GMAIL_APP_PASSWORD not configured');
    }
    
    const info = await this.getTransporter().sendMail({
      from: this.from,
      to: message.to,
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
