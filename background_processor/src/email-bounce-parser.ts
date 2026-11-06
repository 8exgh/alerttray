import { simpleParser, type StructuredHeader } from 'mailparser';

export interface EmailBounce {
  originalMessageId: string;
  recipient: string;
  status: string;
  diagnostic: string;
}

/** RFC 3464 fields are folded headers, separated into per-message/recipient blocks. */
function fields(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) result.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return result;
}

/** Only machine-readable permanent failures; never infer a bounce from prose/subject. */
export async function parseEmailBounces(source: Buffer): Promise<EmailBounce[]> {
  const mail = await simpleParser(source, {
    keepDeliveryStatus: true,
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true
  });
  const contentType = mail.headers.get('content-type') as StructuredHeader | undefined;
  if (contentType?.value !== 'multipart/report' ||
      String(contentType.params?.['report-type']).toLowerCase() !== 'delivery-status') return [];

  // Read only the returned original message's headers, not IDs mentioned in
  // human-readable text, subjects or unrelated quoted messages.
  const originalIds = new Set<string>();
  for (const attachment of mail.attachments) {
    if (['message/rfc822', 'text/rfc822-headers'].includes(attachment.contentType)) {
      const headerBlock = attachment.content.toString('utf8').split(/\r?\n\r?\n/, 1)[0];
      const id = fields(headerBlock).get('message-id');
      if (id) originalIds.add(id);
    }
  }
  const reports = mail.attachments.filter(a => a.contentType === 'message/delivery-status');
  // Some MTAs include this extension instead of attaching original headers.
  for (const report of reports) {
    const id = fields(report.content.toString('utf8').split(/\r?\n\r?\n/, 1)[0]).get('original-message-id');
    if (id) originalIds.add(id);
  }
  if (originalIds.size !== 1) return [];
  const [originalMessageId] = originalIds;
  if (!/^<[^<>\s]+@[^<>\s]+>$/.test(originalMessageId) || originalMessageId.length > 998) return [];

  const bounces: EmailBounce[] = [];
  for (const report of reports) {
    for (const block of report.content.toString('utf8').split(/\r?\n\r?\n/)) {
      const values = fields(block);
      const status = values.get('status') || '';
      if (values.get('action')?.toLowerCase() !== 'failed' || !/^5\.\d{1,3}\.\d{1,3}$/.test(status)) continue;
      const rawRecipient = values.get('original-recipient') || values.get('final-recipient') || '';
      const match = /^(?:rfc822|utf-8)\s*;\s*(.+)$/i.exec(rawRecipient);
      const recipient = match?.[1].trim().toLowerCase();
      if (!recipient || !/^[^\s<>@]+@[^\s<>@]+$/.test(recipient)) continue;
      bounces.push({
        originalMessageId,
        recipient,
        status,
        diagnostic: (values.get('diagnostic-code') || `Delivery failed (${status})`)
          .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000)
      });
    }
  }
  return bounces;
}
