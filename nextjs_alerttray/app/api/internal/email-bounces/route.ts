import { NextRequest, NextResponse } from 'next/server';
import { withInternalAuth, verifySignature } from '@/lib/infrastructure/security/api-security';
import { parseEmailBounceReport, recordEmailBounce } from '@/lib/delivery/email-bounces';
import { initializeSystem } from '@/lib/startup';

/** Authenticated worker endpoint. Bounce details and mailbox access stay private. */
export async function POST(request: NextRequest) {
  return withInternalAuth(request, async req => {
    const body = await req.text();
    const signature = req.headers.get('X-Signature');
    if (!signature || !verifySignature(body, signature)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body); }
    catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
    const report = parseEmailBounceReport(parsed);
    if (!report) return NextResponse.json({ error: 'Invalid email bounce report' }, { status: 400 });
    await initializeSystem();
    const matched = await recordEmailBounce(report);
    return NextResponse.json({ success: true, matched });
  });
}
