/**
 * A stand-in for Apple's / Google's push service, for e2e tests.
 *
 * It is an HTTPS server (web-push only talks HTTPS) that records every push
 * the background processor sends, so tests can decrypt it exactly as the
 * iPhone would (RFC 8291 aes128gcm) and check the VAPID signature
 * (RFC 8292) against the server's public key.
 */
import { createECDH, createDecipheriv, createPublicKey, hkdfSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface ReceivedPush {
  path: string;
  headers: Record<string, string>;
  body: Buffer;
  at: number;
}

/** A browser-side push subscription whose private key we hold. */
export interface FakeSubscriber {
  endpoint: string;
  json: { endpoint: string; expirationTime: null; keys: { p256dh: string; auth: string } };
  decrypt(push: ReceivedPush): string;
}

export class FakePushService {
  readonly received: ReceivedPush[] = [];
  /** Status to answer per path (default 201). */
  readonly statusFor = new Map<string, number>();
  readonly certPath: string;
  private server!: Server;
  private dir: string;
  origin = '';

  constructor() {
    this.dir = mkdtempSync(path.join(os.tmpdir(), 'alerttray-fake-push-'));
    this.certPath = path.join(this.dir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', path.join(this.dir, 'key.pem'), '-out', this.certPath, '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'
    ], { stdio: 'ignore' });
  }

  async start(): Promise<void> {
    this.server = createServer(
      { key: readFileSync(path.join(this.dir, 'key.pem')), cert: readFileSync(this.certPath) },
      async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
        this.received.push({ path: req.url ?? '', headers, body: Buffer.concat(chunks), at: Date.now() });
        const status = this.statusFor.get(req.url ?? '') ?? 201;
        res.writeHead(status, status < 300 ? { 'apns-id': randomUUID() } : { 'Content-Type': 'application/json' });
        res.end(status < 300 ? '' : JSON.stringify({ reason: status === 410 ? 'Unregistered' : 'Error' }));
      }
    );
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.origin = `https://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Wait until a push for `endpoint` arrives after `since`. */
  async waitFor(endpoint: string, since = 0, timeoutMs = 30_000): Promise<ReceivedPush> {
    const wanted = new URL(endpoint).pathname;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.received.find(p => p.path === wanted && p.at >= since);
      if (hit) return hit;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`no push for ${wanted} within ${timeoutMs}ms`);
  }

  newSubscriber(): FakeSubscriber {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const auth = randomBytes(16);
    const endpoint = `${this.origin}/push/${randomUUID()}`;
    return {
      endpoint,
      json: {
        endpoint,
        expirationTime: null,
        keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }
      },
      decrypt: push => decryptAes128gcm(push.body, ecdh, auth)
    };
  }
}

/** RFC 8291 §3.4 / RFC 8188: decrypt a single-record aes128gcm push message. */
export function decryptAes128gcm(body: Buffer, receiver: ReturnType<typeof createECDH>, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const keyIdLength = body[20];
  const senderPublic = body.subarray(21, 21 + keyIdLength);
  const ciphertext = body.subarray(21 + keyIdLength);
  if (ciphertext.length > recordSize) throw new Error('multi-record messages are not expected');

  const ecdhSecret = receiver.computeSecret(senderPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 0x02) throw new Error('missing last-record padding delimiter');
  return padded.subarray(0, end).toString('utf8');
}

/** RFC 8292: check `Authorization: vapid t=<jwt>, k=<key>`; returns the JWT claims. */
export function verifyVapid(authorization: string, expectedPublicKey: string, endpoint: string): Record<string, unknown> {
  const match = /^vapid t=([^,\s]+),\s*k=([A-Za-z0-9_-]+)$/.exec(authorization);
  if (!match) throw new Error(`not a VAPID header: ${authorization}`);
  const [, token, key] = match;
  if (key !== expectedPublicKey) throw new Error('VAPID key does not match the key the PWA subscribed with');
  const raw = Buffer.from(key, 'base64url');
  const publicKey = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
    format: 'jwk'
  });
  const [header, claims, signature] = token.split('.');
  const valid = verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'));
  if (!valid) throw new Error('VAPID JWT signature is invalid');
  const parsed = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
  if (parsed.aud !== new URL(endpoint).origin) throw new Error(`VAPID aud ${parsed.aud} is not the push service origin`);
  if (typeof parsed.exp !== 'number' || parsed.exp * 1000 < Date.now()) throw new Error('VAPID JWT expired');
  if (typeof parsed.sub !== 'string' || !/^(mailto:|https:)/.test(parsed.sub)) throw new Error('VAPID sub must be mailto: or https:');
  return parsed;
}
