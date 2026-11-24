import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ThreadStackDB } from '../../src/core/db.js';
import { JAR_KEY_KV, decryptJar, encryptJar } from '../../src/core/accounts/crypto.js';
import type { StoredCookie } from '../../src/core/workspace/types.js';

let n = 0;
const freshDb = () => new ThreadStackDB(`ThreadStackAccountsCrypto_${Date.now()}_${++n}`);

const cookies: StoredCookie[] = [
  { name: '__Host-sess', value: 'SECRET-SESSION-VALUE', domain: 'claude.ai', hostOnly: true, path: '/', secure: true, httpOnly: true, sameSite: 'strict', session: true },
  {
    name: 'persist',
    value: 'SECRET-PERSIST',
    domain: '.claude.ai',
    hostOnly: false,
    path: '/',
    secure: true,
    httpOnly: false,
    sameSite: 'lax',
    session: false,
    expirationDate: 1794429242,
  },
  {
    name: 'part_c',
    value: 'SECRET-PART',
    domain: 'claude.ai',
    hostOnly: true,
    path: '/',
    secure: true,
    httpOnly: false,
    sameSite: 'no_restriction',
    session: true,
    partitionKey: { topLevelSite: 'https://claude.ai', hasCrossSiteAncestor: false },
  },
];

function asText(data: ArrayBuffer): string {
  return new TextDecoder('latin1').decode(new Uint8Array(data));
}

describe('jar encryption', () => {
  it('round-trips cookies exactly', async () => {
    const db = freshDb();
    const sealed = await encryptJar(db, cookies);
    expect(sealed.cookieCount).toBe(3);
    expect(sealed.iv.byteLength).toBe(12);
    expect(await decryptJar(db, sealed)).toEqual(cookies);
  });

  it('never stores a cookie value in clear text', async () => {
    const db = freshDb();
    const sealed = await encryptJar(db, cookies);
    expect(asText(sealed.data)).not.toContain('SECRET');
    await db.accountJars.put({ accountId: 'acct_1', ...sealed, savedAt: 'now' });
    const row = await db.accountJars.get('acct_1');
    expect(asText(row!.data)).not.toContain('SECRET');
  });

  it('keeps one non-extractable AES-GCM key in its own kv row', async () => {
    const db = freshDb();
    const [a, b] = await Promise.all([encryptJar(db, cookies), encryptJar(db, cookies.slice(0, 1))]);
    const rows = await db.kv.toArray();
    expect(rows.map((r) => r.key)).toEqual([JAR_KEY_KV]);
    const key = rows[0].value as CryptoKey;
    expect(key.extractable).toBe(false);
    expect(key.algorithm.name).toBe('AES-GCM');
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toBeTruthy();
    // Both jars made during the first, concurrent use share that key.
    expect(await decryptJar(db, a)).toEqual(cookies);
    expect(await decryptJar(db, b)).toEqual(cookies.slice(0, 1));
    expect(a.iv).not.toEqual(b.iv);
  });

  it('treats a jar that cannot be decrypted as absent', async () => {
    const db = freshDb();
    const sealed = await encryptJar(db, cookies);
    const damaged = new Uint8Array(sealed.data.slice(0));
    damaged[0] ^= 0xff;
    expect(await decryptJar(db, { iv: sealed.iv, data: damaged.buffer })).toBeNull();
    expect(await decryptJar(db, { iv: new Uint8Array(12), data: sealed.data })).toBeNull();
    // Another database has another key.
    expect(await decryptJar(freshDb(), sealed)).toBeNull();
    // The key was lost.
    await db.kv.delete(JAR_KEY_KV);
    expect(await decryptJar(db, sealed)).toBeNull();
  });
});
