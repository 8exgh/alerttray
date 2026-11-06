import { NextRequest, NextResponse } from 'next/server';
import { withInternalAuth, verifySignature } from '@/lib/infrastructure/security/api-security';
import { hasSuppressedEmail } from '@/lib/delivery/email-suppressions';

/** Worker-only check; returns a decision, never the list or suppression reasons. */
export async function POST(request: NextRequest) {
  return withInternalAuth(request, async req => {
    const body = await req.text();
    const signature = req.headers.get('X-Signature');
    if (!signature || !verifySignature(body, signature)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
    let input: unknown;
    try { input = JSON.parse(body); }
    catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
    const recipients = input && typeof input === 'object' && 'recipients' in input ? input.recipients : null;
    if (!Array.isArray(recipients) || !recipients.length || recipients.length > 100 ||
        !recipients.every(recipient => typeof recipient === 'string' && recipient.length <= 320 &&
          /^[^\s<>@]+@[^\s<>@]+$/.test(recipient))) {
      return NextResponse.json({ error: 'Invalid recipients' }, { status: 400 });
    }
    return NextResponse.json({ success: true, suppressed: hasSuppressedEmail(recipients) });
  });
}
