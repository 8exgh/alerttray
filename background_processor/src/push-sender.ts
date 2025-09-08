import { ApnsClient } from './apns-client';

interface PushNotification {
  deviceToken: string;
  title: string;
  message: string;
  data?: Record<string, any>;
}

export class PushSender {
  private apnsClient: ApnsClient;
  
  constructor() {
    this.apnsClient = new ApnsClient();
  }
  
  async sendNotification(notification: PushNotification): Promise<void> {
    await this.apnsClient.sendNotification(
      notification.deviceToken,
      {
        title: notification.title,
        message: notification.message,
        data: notification.data
      }
    );
  }
}