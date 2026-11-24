// Saved cookie jars are encrypted at rest with AES-GCM (256-bit key, fresh 12-byte IV per jar).
//
// The key is a non-extractable CryptoKey made once with crypto.subtle.generateKey and kept in
// the kv table under `accounts.jarKey`, a different table from the jars (accountJars). IndexedDB
// stores the CryptoKey object itself; its raw bytes cannot be read back by script.
//
// What this protects against: saved logins showing up in exports, in a backup or copy of a
// single table, or in a casual read of the database (developer tools, a debugging dump).
// What it does NOT protect against: anyone who can run code as this extension (they can use
// the key as we do) or who copies the whole browser profile (the key travels with it). The
// live cookies of the signed-in account sit unencrypted in Chrome's own cookie store anyway.
//
// A jar that fails to decrypt (key lost or replaced, data damaged) is treated as absent: the
// account then needs a sign-in. It is never an error that blocks switching.
import type { ThreadStackDB } from '../db.js';
import type { AccountJarRecord, StoredCookie } from '../workspace/types.js';

export const JAR_KEY_KV = 'accounts.jarKey';

const IV_BYTES = 12;

/** One key lookup per database at a time, so two first saves in one context share one key. */
const keyCache = new WeakMap<ThreadStackDB, Promise<CryptoKey>>();

/** Cross-realm safe: a key read back from IndexedDB may come from another global. */
function isAesKey(value: unknown): value is CryptoKey {
  if (Object.prototype.toString.call(value) !== '[object CryptoKey]') return false;
  const key = value as CryptoKey;
  return key.algorithm?.name === 'AES-GCM' && key.usages.includes('encrypt') && key.usages.includes('decrypt');
}

async function readKey(db: ThreadStackDB): Promise<CryptoKey | null> {
  const row = await db.kv.get(JAR_KEY_KV);
  return isAesKey(row?.value) ? row.value : null;
}

async function createKey(db: ThreadStackDB): Promise<CryptoKey> {
  const existing = await readKey(db);
  if (existing) return existing;
  const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  // Generating is not an IndexedDB call, so it happens outside the transaction; the check
  // inside keeps whichever key reached the table first.
  return db.transaction('rw', db.kv, async () => {
    const again = await readKey(db);
    if (again) return again;
    await db.kv.put({ key: JAR_KEY_KV, value: fresh, updatedAt: new Date().toISOString() });
    return fresh;
  });
}

async function jarKey(db: ThreadStackDB): Promise<CryptoKey> {
  let pending = keyCache.get(db);
  if (!pending) {
    pending = createKey(db);
    keyCache.set(db, pending);
    // Only the lookup in flight is shared; the table stays the one source of the key.
    const clear = () => {
      keyCache.delete(db);
    };
    pending.then(clear, clear);
  }
  return pending;
}

export interface EncryptedJar {
  iv: Uint8Array;
  data: ArrayBuffer;
  cookieCount: number;
}

export async function encryptJar(db: ThreadStackDB, cookies: StoredCookie[]): Promise<EncryptedJar> {
  const key = await jarKey(db);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plain = new TextEncoder().encode(JSON.stringify(cookies));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return { iv, data, cookieCount: cookies.length };
}

const SAME_SITE = new Set(['no_restriction', 'lax', 'strict', 'unspecified']);

function isStoredCookie(value: unknown): value is StoredCookie {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.name === 'string' &&
    typeof c.value === 'string' &&
    typeof c.domain === 'string' &&
    c.domain.length > 0 &&
    typeof c.path === 'string' &&
    typeof c.hostOnly === 'boolean' &&
    typeof c.secure === 'boolean' &&
    typeof c.httpOnly === 'boolean' &&
    typeof c.session === 'boolean' &&
    typeof c.sameSite === 'string' &&
    SAME_SITE.has(c.sameSite) &&
    (c.expirationDate === undefined || typeof c.expirationDate === 'number') &&
    (c.partitionKey === undefined || (typeof c.partitionKey === 'object' && c.partitionKey !== null))
  );
}

/** The jar's cookies, or null when it cannot be read (then the account simply needs a sign-in). */
export async function decryptJar(
  db: ThreadStackDB,
  record: Pick<AccountJarRecord, 'iv' | 'data'>
): Promise<StoredCookie[] | null> {
  try {
    const key = await readKey(db);
    if (!key) return null;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(record.iv) }, key, record.data);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plain));
    if (!Array.isArray(parsed) || !parsed.every(isStoredCookie)) return null;
    return parsed;
  } catch {
    return null;
  }
}
