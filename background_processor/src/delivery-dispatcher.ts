import type { DeliveryTask } from './api-client';
import { PushSender } from './push-sender';
import { PhoneGatewayClient } from './phone-gateway-client';
import { EmailClient } from './email-client';
import {
  formatSms,
  formatCallOpeningLine,
  formatCallGoal,
  formatEmailSubject,
  formatEmailText,
  formatEmailHtml,
  type AlertContent
} from './message-format';

export interface DispatchOutcome {
  providerMessageId?: string;
}

/**
 * Executes one delivery task on the channel it was routed to. Routing itself
 * (which severities go to which channels) is decided server-side in
 * nextjs_alerttray/lib/delivery/routing-policy.ts; this only knows how to
 * send.
 *
 * DELIVERY_DRY_RUN=1 logs what would be sent and reports success without
 * touching APNS, the phone gateway or SMTP — handy for local development.
 */
export class DeliveryDispatcher {
  private pushSender: PushSender;
  private phoneGateway: PhoneGatewayClient;
  private email: EmailClient;
  private dryRun: boolean;
  
  constructor() {
    this.pushSender = new PushSender();
    this.phoneGateway = new PhoneGatewayClient();
    this.email = new EmailClient();
    this.dryRun = process.env.DELIVERY_DRY_RUN === '1';
    
    if (this.dryRun) console.log('🧪 DELIVERY_DRY_RUN=1 — nothing will actually be sent');
  }
  
  async dispatch(task: DeliveryTask): Promise<DispatchOutcome> {
    const alert: AlertContent = {
      title: task.title,
      message: task.message,
      severity: task.severity,
      notificationId: task.notificationId
    };
    
    switch (task.channel) {
      case 'apns':
        return this.sendPush(task);
      case 'sms':
        return this.sendSms(task, alert);
      case 'call':
        return this.placeCall(task, alert);
      case 'email':
        return this.sendEmail(task, alert);
      case 'emergency':
        // iPhone emergency alerts are being built separately on the iOS side.
        throw new Error('emergency channel not implemented yet');
      default:
        throw new Error(`Unknown delivery channel: ${String(task.channel)}`);
    }
  }
  
  private async sendPush(task: DeliveryTask): Promise<DispatchOutcome> {
    if (this.dryRun) {
      console.log(`🧪 [apns] would push to ${mask(task.recipient)}: ${task.title}`);
      return {};
    }
    await this.pushSender.sendNotification({
      deviceToken: task.recipient,
      title: task.title,
      message: task.message,
      data: task.data || {}
    });
    return {};
  }
  
  private async sendSms(task: DeliveryTask, alert: AlertContent): Promise<DispatchOutcome> {
    const body = formatSms(alert);
    if (this.dryRun) {
      console.log(`🧪 [sms] would text ${mask(task.recipient)}: ${body}`);
      return { providerMessageId: 'dry-run' };
    }
    const result = await this.phoneGateway.sendSms(task.recipient, body);
    return { providerMessageId: result.sid };
  }
  
  private async placeCall(task: DeliveryTask, alert: AlertContent): Promise<DispatchOutcome> {
    const openingLine = formatCallOpeningLine(alert);
    const goal = formatCallGoal(alert);
    if (this.dryRun) {
      console.log(`🧪 [call] would call ${mask(task.recipient)} and say: ${openingLine}`);
      return { providerMessageId: 'dry-run' };
    }
    const result = await this.phoneGateway.placeCall(task.recipient, {
      openingLine,
      goal,
      voice: process.env.PHONE_GATEWAY_VOICE || undefined
    });
    if (result.status === 'failed') {
      throw new Error(`call ${result.orchestrationId} failed: ${result.reason ?? 'unknown reason'}`);
    }
    return { providerMessageId: result.orchestrationId };
  }
  
  private async sendEmail(task: DeliveryTask, alert: AlertContent): Promise<DispatchOutcome> {
    const subject = formatEmailSubject(alert);
    if (this.dryRun) {
      console.log(`🧪 [email] would email ${mask(task.recipient)}: ${subject}`);
      return { providerMessageId: 'dry-run' };
    }
    const result = await this.email.send({
      to: task.recipient,
      subject,
      text: formatEmailText(alert),
      html: formatEmailHtml(alert)
    });
    return { providerMessageId: result.messageId };
  }
}

/** Mask a recipient (token, phone or email) for logs. */
export function mask(recipient: string): string {
  if (recipient.includes('@')) {
    const [local, domain] = recipient.split('@');
    return `${local.slice(0, 2)}…@${domain}`;
  }
  if (recipient.startsWith('+')) {
    return `${recipient.slice(0, 3)}…${recipient.slice(-3)}`;
  }
  return `${recipient.slice(0, 8)}…`;
}
