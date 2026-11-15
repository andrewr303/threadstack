import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { gunzipSync, strFromU8 } from 'fflate';
import { ThreadkeeperDB } from '../../src/core/db.js';
import { BACKUP_FORMAT, BackupFormatError, decodeRows, encodeRow, libraryFingerprint, restoreBackup, writeBackup } from '../../src/core/backup.js';

let n = 0;
const freshDb = () => new ThreadkeeperDB(`ThreadkeeperBackup_${Date.now()}_${++n}`);
const info = { extensionVersion: '0.5.0', extensionId: 'a'.repeat(32), now: () => new Date('2026-01-02T03:04:05Z') };

async function seed(db: ThreadkeeperDB, threads: number, prefix = 't') {
  for (let i = 0; i < threads; i++) {
    const threadKey = `${prefix}${String(i).padStart(4, '0')}`;
    await db.table('conversations').put({ threadKey, provider: 'claude', title: `Thread ${i}`, updatedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z` });
    await db.table('messages').bulkPut([
      { messageKey: `${threadKey}:0`, threadKey, ordinal: 0, role: 'user', content: `Question ${i} with “quotes”, emoji 🧵 and a\nnew line` },
      { messageKey: `${threadKey}:1`, threadKey, ordinal: 1, role: 'assistant', content: 'x'.repeat(3000) },
    ]);
    await db.table('threadVectors').put({ vectorKey: `${threadKey}:v`, threadKey, space: 's', embedding: [0.25, -1.5, i] });
  }
}

async function backupBytes(db: ThreadkeeperDB): Promise<{ chunks: Uint8Array[]; all: Uint8Array }> {
  const chunks: Uint8Array[] = [];
  await writeBackup(db, (c) => void chunks.push(c.slice()), info);
  const all = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return { chunks, all };
}

async function* pieces(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

describe('row encoding', () => {
  it('keeps dates and binary values through JSON', () => {
    const row = {
      key: 'k',
      when: new Date('2026-03-04T05:06:07Z'),
      floats: new Float32Array([1.5, -2.25, 3]),
      bytes: new Uint8Array([0, 255, 7]),
      buffer: new Uint8Array([9, 8]).buffer,
      nested: [{ at: new Date(0) }],
      text: '{"$tk":"date"} is only text',
    };
    const back = decodeRows(encodeRow(row)) as typeof row;
    expect(back.when).toEqual(row.when);
    expect(back.floats).toBeInstanceOf(Float32Array);
    expect(Array.from(back.floats)).toEqual([1.5, -2.25, 3]);
    expect(Array.from(back.bytes)).toEqual([0, 255, 7]);
    expect(Array.from(new Uint8Array(back.buffer))).toEqual([9, 8]);
    expect(back.nested[0].at).toEqual(new Date(0));
    expect(back.text).toBe(row.text);
  });
});

describe('backup and restore', () => {
  it('restores a whole library into an empty one, settings included', async () => {
    const from = freshDb();
    await seed(from, 620);
    await from.table('settings').put({ id: 'default', anthropicApiKey: 'sk-test', theme: 'dark' });
    await from.table('collections').put({ name: 'Research', isStarterArea: false });
    await from.table('accounts').put({ id: 'acct_1', realm: 'claude', label: 'Work', hasJar: true, mode: 'embedded' });
    await from.table('kv').bulkPut([
      { key: 'workspace.state', value: { tabs: 2 }, updatedAt: 'x' },
      { key: 'accounts.jarKey', value: 'never-leaves', updatedAt: 'x' },
      { key: 'accounts.switchJournal', value: { realm: 'claude' }, updatedAt: 'x' },
    ]);
    await from.table('accountJars').put({ accountId: 'acct_1', iv: new Uint8Array(12), data: new ArrayBuffer(4) });
    await from.table('jobs').put({ jobId: 'j1', status: 'pending' });

    const { all, chunks } = await backupBytes(from);
    expect(chunks.length).toBeGreaterThan(1);
    const lines = strFromU8(gunzipSync(all)).trim().split('\n');
    expect(JSON.parse(lines[0])).toMatchObject({ format: BACKUP_FORMAT, threads: 620, messages: 1240, extensionId: info.extensionId });
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ end: true, counts: { conversations: 620, messages: 1240, kv: 1 } });
    const text = lines.join('\n');
    expect(text).not.toContain('never-leaves');
    expect(text).not.toContain('accountJars');
    expect(text).not.toContain('"jobs"');

    const to = freshDb();
    await to.table('settings').put({ id: 'default', theme: 'light' });
    // Odd piece sizes: lines and multi-byte characters are split across pieces.
    const result = await restoreBackup(to, pieces(all, 977));
    expect(result.threadsAdded).toBe(620);
    expect(result.settingsRestored).toBe(true);
    expect(result.meta?.threads).toBe(620);
    expect(await to.conversations.count()).toBe(620);
    expect(await to.messages.count()).toBe(1240);
    expect((await to.table('messages').get('t0007:0')).content).toBe('Question 7 with “quotes”, emoji 🧵 and a\nnew line');
    expect((await to.table('threadVectors').get('t0619:v')).embedding).toEqual([0.25, -1.5, 619]);
    expect(await to.table('settings').get('default')).toMatchObject({ anthropicApiKey: 'sk-test', theme: 'dark' });
    expect((await to.table('accounts').get('acct_1')).hasJar).toBe(false);
    expect(await to.table('kv').get('workspace.state')).toBeTruthy();
    expect(await to.table('kv').get('accounts.jarKey')).toBeUndefined();
    expect(await to.table('accountJars').count()).toBe(0);
    expect(await to.table('jobs').count()).toBe(0);
  });

  it('adds what is missing to a library that has threads and changes nothing it has', async () => {
    const from = freshDb();
    await seed(from, 5);
    await from.table('settings').put({ id: 'default', theme: 'dark' });
    const { all } = await backupBytes(from);

    const to = freshDb();
    await seed(to, 2, 'own');
    await to.table('conversations').put({ threadKey: 't0001', provider: 'claude', title: 'Renamed here', updatedAt: '2027-01-01T00:00:00Z' });
    await to.table('settings').put({ id: 'default', theme: 'light' });
    const result = await restoreBackup(to, pieces(all, 4096));
    expect(result.threadsAdded).toBe(4);
    // The thread already here, its two messages and its vector are all left out.
    expect(result.kept).toBe(4);
    expect(result.settingsRestored).toBe(false);
    expect(await to.conversations.count()).toBe(7);
    expect((await to.conversations.get('t0001'))!.title).toBe('Renamed here');
    expect((await to.table('settings').get('default')).theme).toBe('light');
    // Restoring the same backup again adds nothing.
    const again = await restoreBackup(to, pieces(all, 4096));
    expect(again.threadsAdded).toBe(0);
    expect(await to.messages.count()).toBe(12);
  });

  it('never mixes a backup\'s rows into a thread the library already has', async () => {
    // The backup has all six turns of T; this library captured only the last two, so the same
    // position keys (T:0, T:1) hold different turns.
    const from = freshDb();
    await from.table('conversations').put({ threadKey: 'T', provider: 'claude', title: 'T', updatedAt: '2026-01-01T00:00:00Z', messageCount: 6 });
    for (let i = 0; i < 6; i++) await from.table('messages').put({ messageKey: `T:${i}`, threadKey: 'T', ordinal: i, role: 'user', content: `turn ${i}` });
    await from.table('chunks').put({ chunkKey: 'T:c:3', threadKey: 'T', chunkIndex: 3 });
    await from.table('summaries').put({ threadKey: 'T', sourceRevision: 'r1', text: 'old summary' });
    const { all } = await backupBytes(from);

    const to = freshDb();
    await to.table('conversations').put({ threadKey: 'T', provider: 'claude', title: 'T', updatedAt: '2026-02-01T00:00:00Z', messageCount: 2 });
    await to.table('messages').bulkPut([
      { messageKey: 'T:0', threadKey: 'T', ordinal: 0, role: 'user', content: 'turn 4' },
      { messageKey: 'T:1', threadKey: 'T', ordinal: 1, role: 'user', content: 'turn 5' },
    ]);
    const result = await restoreBackup(to, pieces(all, 4096));
    expect(result.threadsAdded).toBe(0);
    expect(result.added).toEqual({});
    expect((await to.table('messages').where('threadKey').equals('T').sortBy('ordinal')).map((m: { content: string }) => m.content)).toEqual(['turn 4', 'turn 5']);
    expect(await to.table('chunks').count()).toBe(0);
    expect(await to.table('summaries').count()).toBe(0);
  });

  it('keeps deletions made here, and does not delete live threads because the backup once did', async () => {
    const from = freshDb();
    await seed(from, 2); // t0000, t0001
    await from.table('tombstones').put({ threadKey: 'live-here', provider: 'claude', deletedAt: '2026-01-01T00:00:00Z' });
    await from.table('tombstones').put({ threadKey: 'gone-everywhere', provider: 'claude', deletedAt: '2026-01-01T00:00:00Z' });
    const { all } = await backupBytes(from);

    const to = freshDb();
    await to.table('conversations').put({ threadKey: 'live-here', provider: 'claude', title: 'Recaptured', updatedAt: '2026-03-01T00:00:00Z' });
    await to.table('tombstones').put({ threadKey: 't0001', provider: 'claude', deletedAt: '2026-03-01T00:00:00Z' });
    const result = await restoreBackup(to, pieces(all, 4096));
    expect(result.threadsAdded).toBe(1);
    expect(await to.conversations.get('t0000')).toBeTruthy();
    // Deleted here: it and its messages stay gone.
    expect(await to.conversations.get('t0001')).toBeUndefined();
    expect(await to.table('messages').where('threadKey').equals('t0001').count()).toBe(0);
    // Live here: the backup's old deletion is not applied to it.
    expect(await to.table('tombstones').get('live-here')).toBeUndefined();
    expect(await to.table('tombstones').get('gone-everywhere')).toBeTruthy();
  });

  it('refuses files that are not backups and reports a backup that was cut short', async () => {
    const to = freshDb();
    await expect(restoreBackup(to, pieces(new TextEncoder().encode('hello there, not gzip at all'), 8))).rejects.toBeInstanceOf(BackupFormatError);
    await expect(restoreBackup(to, pieces(new Uint8Array(0), 8))).rejects.toThrow(/not a Threadkeeper backup/);

    const from = freshDb();
    await seed(from, 300);
    const { all } = await backupBytes(from);
    await expect(restoreBackup(to, pieces(all.subarray(0, Math.floor(all.length / 2)), 1000))).rejects.toThrow(/incomplete/);
    // Everything before the cut is in the library.
    expect(await to.conversations.count()).toBeGreaterThan(0);
  });

  it('fingerprint changes when the library does', async () => {
    const db = freshDb();
    expect((await libraryFingerprint(db)).threads).toBe(0);
    await seed(db, 2);
    const a = await libraryFingerprint(db);
    expect(a.threads).toBe(2);
    await db.table('messages').put({ messageKey: 't0000:2', threadKey: 't0000', ordinal: 2, role: 'user', content: 'more' });
    const b = await libraryFingerprint(db);
    expect(b.fingerprint).not.toBe(a.fingerprint);
    // Organizing and analysis change it too, not only capture.
    await db.table('changeLogs').put({ changeId: 'c1', createdAt: 'x', undone: 0 });
    const c = await libraryFingerprint(db);
    expect(c.fingerprint).not.toBe(b.fingerprint);
    await db.table('summaries').put({ threadKey: 't0000', sourceRevision: 'r' });
    expect((await libraryFingerprint(db)).fingerprint).not.toBe(c.fingerprint);
  });
});
