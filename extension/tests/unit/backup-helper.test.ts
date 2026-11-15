import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThreadkeeperDB } from '../../src/core/db.js';
import {
  AUTO_BACKUP_MAX_AGE_MS,
  AUTO_BACKUP_MIN_GAP_MS,
  backupNow,
  backupStatus,
  maybeAutoBackup,
  restoreFromHelper,
  type BackupEnv,
  type BackupState,
  type HelperPort,
} from '../../src/core/backup-helper.js';
import { helperConnectionReason } from '../../src/core/embed/helper.js';
import { HOLD_STALE_MS, holdAnalysis } from '../../src/core/analysis-hold.js';

const require = createRequire(import.meta.url);
const core = require('../../mac-helper/core.cjs');

let n = 0;
const freshDb = () => new ThreadkeeperDB(`ThreadkeeperBackupHelper_${Date.now()}_${++n}`);

async function seed(db: ThreadkeeperDB, threads: number) {
  for (let i = 0; i < threads; i++) {
    const threadKey = `t${String(i).padStart(4, '0')}`;
    await db.table('conversations').put({ threadKey, provider: 'chatgpt', title: `Thread ${i}`, updatedAt: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z` });
    // Random text does not compress, so the backup spans several helper chunks.
    await db.table('messages').put({ messageKey: `${threadKey}:0`, threadKey, ordinal: 0, role: 'user', content: Array.from({ length: 400 }, () => Math.random().toString(36).slice(2)).join('') });
  }
}

/** The real helper code (mac-helper/core.cjs) behind the port, through its own message framing. */
function world(options: { permission?: boolean; connectError?: string; failOn?: string } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-backup-helper-'));
  const clock = { t: Date.UTC(2026, 4, 1, 12, 0, 0) };
  let state: BackupState | null = null;
  const sent: string[] = [];
  const env: BackupEnv = {
    hasPermission: async () => options.permission !== false,
    connect: (): HelperPort => {
      if (options.connectError) throw new Error(options.connectError);
      const session = core.createBackupSession({ home, now: () => new Date(clock.t) });
      return {
        request: async (message) => {
          sent.push(String(message.type));
          if (options.failOn === message.type) throw new Error('Native host has exited.');
          // Round trip through the helper's framing, which enforces its size limit.
          const out: unknown[] = [];
          const errors: string[] = [];
          core.createDecoder((x: unknown) => out.push(x), (e: Error) => errors.push(e.message)).push(core.frame(message));
          if (errors.length) return { ok: false, error: errors[0] };
          try {
            return await core.handle(out[0], { platform: 'darwin', home, session });
          } catch (e) {
            return { ok: false, error: (e as Error).message };
          }
        },
        close: () => session.abort(),
      };
    },
    load: async () => state,
    save: async (next) => void (state = next),
    extensionId: 'a'.repeat(32),
    extensionVersion: '0.5.0',
    now: () => clock.t,
  };
  return { env, home, clock, sent, state: () => state, done: () => fs.rmSync(home, { recursive: true, force: true }) };
}

describe('helper backups', () => {
  it('backs the library up to disk and restores it into a fresh database', async () => {
    const w = world();
    try {
      const db = freshDb();
      await seed(db, 150);
      const saved = await backupNow(db, w.env);
      expect(saved).toMatchObject({ ok: true, threads: 150, name: 'library-20260501-120000.tkbackup' });
      expect(w.sent.filter((t) => t === 'backup-chunk').length).toBeGreaterThan(1);
      expect(w.state()).toMatchObject({ threads: 150, name: 'library-20260501-120000.tkbackup' });

      const status = await backupStatus(db, w.env);
      expect(status).toMatchObject({ ok: true, helper: true, threads: 150 });
      expect(status.backups).toHaveLength(1);
      expect(status.backups[0]).toMatchObject({ threads: 150, extensionVersion: '0.5.0' });

      // A different extension ID starts with nothing; the files on disk are still there.
      const fresh = freshDb();
      const restored = await restoreFromHelper(fresh, w.env, status.backups[0].name);
      expect(restored).toEqual({ ok: true, threadsAdded: 150, kept: 0, settingsRestored: false });
      expect(await fresh.conversations.count()).toBe(150);
      expect((await fresh.table('messages').get('t0149:0')).content).toBe((await db.table('messages').get('t0149:0')).content);
    } finally {
      w.done();
    }
  });

  it('backs up automatically only when the library changed and the last backup is old enough', async () => {
    const w = world();
    try {
      const db = freshDb();
      expect(await maybeAutoBackup(db, w.env)).toBe('skipped'); // empty library
      expect(fs.existsSync(core.backupDir(w.home))).toBe(false);
      await seed(db, 3);
      expect(await maybeAutoBackup(db, w.env)).toBe('done');
      expect(await maybeAutoBackup(db, w.env)).toBe('skipped'); // unchanged
      await db.table('messages').put({ messageKey: 'new', threadKey: 't0000', ordinal: 9, role: 'user', content: 'changed' });
      expect(await maybeAutoBackup(db, w.env)).toBe('skipped'); // changed, but too soon
      w.clock.t += AUTO_BACKUP_MIN_GAP_MS + 1000;
      expect(await maybeAutoBackup(db, w.env)).toBe('done');
      expect((await backupStatus(db, w.env)).backups).toHaveLength(2);
      // Nothing changed for a day: one more backup, so changed settings are kept too.
      w.clock.t += AUTO_BACKUP_MIN_GAP_MS + 1000;
      expect(await maybeAutoBackup(db, w.env)).toBe('skipped');
      w.clock.t += AUTO_BACKUP_MAX_AGE_MS;
      expect(await maybeAutoBackup(db, w.env)).toBe('done');
      expect(await maybeAutoBackup(db, world({ permission: false }).env)).toBe('skipped');
    } finally {
      w.done();
    }
  });

  it('says what to do when the helper cannot be reached, and leaves no partial file', async () => {
    const db = freshDb();
    await seed(db, 2);
    expect(await backupNow(db, null)).toMatchObject({ ok: false, code: 'helper_unavailable' });
    expect(await backupNow(freshDb(), world().env)).toMatchObject({ ok: false, error: expect.stringMatching(/nothing to back up/) });

    const missing = world({ connectError: 'Specified native messaging host not found.' });
    expect(await backupNow(db, missing.env)).toMatchObject({ ok: false, error: expect.stringMatching(/not installed for this browser/) });
    const status = await backupStatus(db, missing.env);
    expect(status).toMatchObject({ helper: false, threads: 2 });
    expect(status.reason).toMatch(/not installed for this browser/);

    const dies = world({ failOn: 'backup-commit' });
    try {
      const result = await backupNow(db, dies.env);
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/stopped before answering/) });
      // The failure is on record even though no backup ever succeeded, and is not retried at once.
      expect(dies.state()).toMatchObject({ error: expect.stringMatching(/stopped before answering/), failedAt: expect.any(String) });
      expect(await maybeAutoBackup(db, dies.env)).toBe('skipped');
      dies.clock.t += AUTO_BACKUP_MIN_GAP_MS + 1000;
      expect(await maybeAutoBackup(db, dies.env)).toBe('failed');
      expect(fs.readdirSync(core.backupDir(dies.home))).toEqual([]);
      expect(await restoreFromHelper(db, dies.env, '../../etc/passwd')).toMatchObject({ ok: false, error: 'That backup no longer exists.' });
      expect(await restoreFromHelper(db, dies.env, 'library-20200101-000000.tkbackup')).toMatchObject({ ok: false, error: 'That backup no longer exists.' });
    } finally {
      dies.done();
      missing.done();
    }
  });

  it('waits for a running online import instead of backing up half-written threads', async () => {
    const w = world();
    try {
      const db = freshDb();
      await seed(db, 3);
      await holdAnalysis(db, 'run-1', w.clock.t);
      expect(await backupNow(db, w.env)).toMatchObject({ ok: false, code: 'busy', error: expect.stringMatching(/online import is running/) });
      expect(await maybeAutoBackup(db, w.env)).toBe('skipped');
      expect(w.state()).toBeNull();
      // The import ended (or its marker went stale): the backup goes ahead.
      w.clock.t += HOLD_STALE_MS + 1000;
      expect(await maybeAutoBackup(db, w.env)).toBe('done');
    } finally {
      w.done();
    }
  });

  it('runs one backup at a time', async () => {
    const w = world();
    try {
      const db = freshDb();
      await seed(db, 20);
      const [a, b] = await Promise.all([backupNow(db, w.env), backupNow(db, w.env)]);
      expect([a.ok, b.ok].sort()).toEqual([false, true]);
      expect([a, b].find((r) => !r.ok)).toMatchObject({ code: 'busy' });
    } finally {
      w.done();
    }
  });

  it('maps the browser errors to instructions', () => {
    expect(helperConnectionReason(new Error('Specified native messaging host not found.'))).toMatch(/not installed for this browser/);
    expect(helperConnectionReason(new Error('Access to the specified native messaging host is forbidden.'))).toMatch(/not for this copy/);
    expect(helperConnectionReason(new Error('Native host has exited.'))).toMatch(/stopped before answering/);
    expect(helperConnectionReason(new Error('something else'))).toBeNull();
  });
});
