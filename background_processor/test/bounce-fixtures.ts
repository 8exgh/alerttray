export function bounceMessage(options: {
  action?: string;
  status?: string;
  recipient?: string;
  messageId?: string;
  originalType?: string;
  extraRecipient?: string;
} = {}): Buffer {
  return Buffer.from([
    'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    'To: sender@example.com',
    'Message-ID: <bounce@example.com>',
    'Subject: Delivery Status Notification (Failure)',
    'MIME-Version: 1.0',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="bounce"',
    '',
    '--bounce',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'The email could not be delivered.',
    '--bounce',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; googlemail.com',
    '',
    `Final-Recipient: rfc822; ${options.recipient || '2907618125@qq.com'}`,
    `Action: ${options.action || 'failed'}`,
    `Status: ${options.status || '5.1.1'}`,
    'Diagnostic-Code: smtp; 550 Mailbox unavailable',
    '    or blocked by the recipient server',
    options.extraRecipient || '',
    '',
    '--bounce',
    `Content-Type: ${options.originalType || 'message/rfc822'}`,
    '',
    `Message-ID: ${options.messageId || '<original@example.com>'}`,
    'From: sender@example.com',
    'To: 2907618125@qq.com',
    'Subject: Alert',
    '',
    'Original message body',
    '--bounce--',
    ''
  ].join('\r\n'));
}
