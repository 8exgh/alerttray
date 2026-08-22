import fetch from 'node-fetch';

/**
 * Client for the 8Examples phone-call-gateway
 * (https://phone-gateway.fusenv.com, repo: 8exgh/phone-call-gateway).
 *
 * Auth is a per-client bearer token minted by the gateway admin
 * (`POST /clients` → `pgw_…`). Calls and texts always go out from the
 * number registered to that client, so `from` is never passed.
 *
 * The gateway has no idempotency key: AlertTray's task queue guarantees each
 * delivery task is handed to the processor once, so we never retry here.
 */

export interface SmsResult {
  sid: string;
  status: string;
  to: string;
  from: string;
}

export interface CallResult {
  orchestrationId: string;
  callId: string;
  to: string;
  from: string;
  /** Final status after polling, or 'running' if we stopped waiting. */
  status: 'running' | 'ended' | 'failed';
  reason?: string;
}

interface OrchestrationRecord {
  id: string;
  status: 'running' | 'ended' | 'failed';
  reason?: string;
  errors?: string[];
}

export class PhoneGatewayError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'PhoneGatewayError';
  }
}

export class PhoneGatewayClient {
  private baseUrl: string;
  private apiKey: string;
  private requestTimeoutMs = 30_000;
  /** How long to wait for an outbound call to finish before reporting it. */
  private callWaitMs: number;
  private callPollMs = 5_000;
  
  constructor() {
    this.baseUrl = (process.env.PHONE_GATEWAY_URL || 'https://phone-gateway.fusenv.com').replace(/\/+$/, '');
    this.apiKey = process.env.PHONE_GATEWAY_API_KEY || '';
    this.callWaitMs = Number(process.env.PHONE_GATEWAY_CALL_WAIT_MS || 180_000);
    
    if (!this.apiKey) console.warn('PHONE_GATEWAY_API_KEY not configured — call/sms deliveries will be skipped');
  }
  
  isConfigured(): boolean {
    return !!this.apiKey;
  }
  
  async sendSms(to: string, body: string): Promise<SmsResult> {
    this.assertConfigured();
    // Gateway rejects bodies over 1600 chars
    const data = await this.request<SmsResult>('POST', '/sms', { to, body: body.slice(0, 1600) });
    return data;
  }
  
  /**
   * Place a voice call that reads the alert out loud. The gateway runs an LLM
   * voice agent; we pin it to a narrow "read this alert, confirm, hang up"
   * goal and disable mid-call tools so it cannot wander.
   */
  async placeCall(to: string, opts: { openingLine: string; goal: string; voice?: string }): Promise<CallResult> {
    this.assertConfigured();
    
    const started = await this.request<{
      orchestrationId: string;
      callId: string;
      to: string;
      from: string;
      status: 'running';
      statusUrl: string;
    }>('POST', '/orchestrations', {
      to,
      goal: opts.goal,
      openingLine: opts.openingLine,
      ...(opts.voice ? { voice: opts.voice } : {}),
      tools: []
    });
    
    // Poll until the call ends so a failed/unanswered call is reported as such
    const deadline = Date.now() + this.callWaitMs;
    let last: OrchestrationRecord = { id: started.orchestrationId, status: 'running' };
    while (Date.now() < deadline) {
      await sleep(this.callPollMs);
      try {
        last = await this.request<OrchestrationRecord>('GET', `/orchestrations/${started.orchestrationId}`);
      } catch (error) {
        console.warn(`Polling call ${started.orchestrationId} failed:`, (error as Error).message);
        continue;
      }
      if (last.status !== 'running') break;
    }
    
    return {
      orchestrationId: started.orchestrationId,
      callId: started.callId,
      to: started.to,
      from: started.from,
      status: last.status,
      reason: last.reason ?? last.errors?.[0]
    };
  }
  
  private assertConfigured(): void {
    if (!this.apiKey) {
      throw new Error('PHONE_GATEWAY_API_KEY not configured');
    }
  }
  
  private async request<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal
      });
      
      const text = await response.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
      
      if (!response.ok) {
        throw new PhoneGatewayError(response.status, gatewayErrorMessage(response.status, data, text));
      }
      
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function gatewayErrorMessage(status: number, data: unknown, raw: string): string {
  let msg = raw.trim();
  if (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
    msg = (data as { error: string }).error;
  }
  if (msg.length > 300) msg = msg.slice(0, 300) + '…';
  
  switch (status) {
    case 401:
      return `phone gateway rejected the token (${status}): ${msg} — check PHONE_GATEWAY_API_KEY`;
    case 403:
      return `phone gateway refused (${status}): ${msg}`;
    case 429:
      return `phone gateway quota exhausted (${status}): ${msg}`;
    case 424:
      return `phone gateway provider failure (${status}): ${msg}`;
    default:
      return `phone gateway error (${status}): ${msg}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
