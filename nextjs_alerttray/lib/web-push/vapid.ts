import { generateKeyPairSync } from 'crypto';
import { getSystemDatabase } from '@/lib/infrastructure/database/connection';

/**
 * VAPID identifies this server to browser push services (Apple, Google,
 * Mozilla). The PWA subscribes with the public key; the background processor
 * signs every push with the private key, so both must come from one pair.
 *
 * Zero-config by default: the pair is generated once and kept in the system
 * database, and the worker fetches it over the signed internal API
 * (GET /api/internal/web-push/vapid). Set VAPID_PUBLIC_KEY and
 * VAPID_PRIVATE_KEY (base64url, as printed by `npx web-push
 * generate-vapid-keys`) on the Next.js app to pin a pair instead.
 *
 * Changing the pair invalidates every existing subscription: each installed
 * PWA has to subscribe again (it does so automatically on next open).
 */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export function getVapidKeys(): VapidKeys {
  const envPublic = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPrivate = process.env.VAPID_PRIVATE_KEY?.trim();
  if (envPublic || envPrivate) {
    if (!envPublic || !envPrivate) {
      throw new Error('Set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or neither');
    }
    assertVapidKeys({ publicKey: envPublic, privateKey: envPrivate });
    return { publicKey: envPublic, privateKey: envPrivate };
  }

  const db = getSystemDatabase();
  try {
    const existing = readStored(db);
    if (existing) return existing;
    const generated = generateVapidKeys();
    // INSERT OR IGNORE: if another request generated a pair meanwhile, keep theirs.
    db.prepare(`
      INSERT OR IGNORE INTO web_push_vapid (id, public_key, private_key, created_at)
      VALUES (1, ?, ?, ?)
    `).run(generated.publicKey, generated.privateKey, new Date().toISOString());
    return readStored(db)!;
  } finally {
    db.close();
  }
}

function readStored(db: ReturnType<typeof getSystemDatabase>): VapidKeys | null {
  const row = db.prepare('SELECT public_key, private_key FROM web_push_vapid WHERE id = 1')
    .get() as { public_key: string; private_key: string } | undefined;
  return row ? { publicKey: row.public_key, privateKey: row.private_key } : null;
}

/** P-256 key pair in the encoding Web Push uses: uncompressed public point / raw private scalar, base64url. */
export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const publicKey = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from(jwk.y!, 'base64url')
  ]).toString('base64url');
  return { publicKey, privateKey: jwk.d! };
}

function assertVapidKeys(keys: VapidKeys): void {
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const priv = Buffer.from(keys.privateKey, 'base64url');
  if (pub.length !== 65 || pub[0] !== 0x04 || priv.length !== 32) {
    throw new Error('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not a base64url P-256 key pair');
  }
}
