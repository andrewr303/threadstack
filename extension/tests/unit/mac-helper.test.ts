// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HELPER_ALLOWED_HOSTS, HELPER_HOST, helperOpenRequest, isHelperUrl } from '../../src/core/embed/helper-protocol';

const require = createRequire(import.meta.url);
const core = require('../../mac-helper/core.cjs');
const { install, uninstall, detectExtensionIds } = require('../../mac-helper/install.cjs');
const { launchPlan, handle, frame, createDecoder, aiUrl } = core;

const id = '0b336235-3358-4cb4-9500-123456789abc';
const options = { platform: 'darwin', home: '/Users/test user', exists: (p: string) => p === '/Applications/Google Chrome.app' };

describe('allow-list agreement', () => {
  it('matches the TypeScript list and host name', () => {
    expect([...core.ALLOWED_HOSTS].sort()).toEqual([...HELPER_ALLOWED_HOSTS].sort());
    expect(core.HOST).toBe(HELPER_HOST);
    expect(core.HOST).toBe('com.threadkeeper.accounts');
  });
});

describe('URL allow-list', () => {
  const good = [
    'https://claude.ai/code/session_abc', 'https://www.claude.ai/chat/1', 'https://chatgpt.com/c/abc?x=1',
    'https://github.com/o/r/pull/3', 'https://auth.openai.com/log-in', 'https://app.devin.ai/sessions/x',
  ];
  const bad = [
    'file:///etc/passwd', 'javascript:alert(1)', 'http://claude.ai/code', 'https://evil.test/code',
    'https://claude.ai.evil.test/code', 'https://user:pass@claude.ai/code', 'https://claude.ai:8080/code',
    'https://example.com', 'not a url', 'https://claude.ai/' + 'a'.repeat(2100),
  ];
  it('accepts allow-listed https hosts in both helper and protocol', () => {
    for (const u of good) {
      expect(() => aiUrl(u)).not.toThrow();
      expect(isHelperUrl(u)).toBe(true);
    }
  });
  it('rejects everything else in both', () => {
    for (const u of bad) {
      expect(() => aiUrl(u)).toThrow();
      expect(isHelperUrl(u)).toBe(false);
    }
  });
  it('helperOpenRequest enforces account mode, profile id and url', () => {
    expect(helperOpenRequest({ mode: 'isolated', profileId: id }, 'https://claude.ai/code/x')).toEqual({ type: 'open', profileId: id, url: 'https://claude.ai/code/x' });
    expect(typeof helperOpenRequest({ mode: 'embedded', profileId: id }, 'https://claude.ai/code/x')).toBe('string');
    expect(typeof helperOpenRequest({ mode: 'isolated', profileId: '../x' }, 'https://claude.ai/code/x')).toBe('string');
    expect(typeof helperOpenRequest({ mode: 'isolated' }, 'https://claude.ai/code/x')).toBe('string');
    expect(typeof helperOpenRequest({ mode: 'isolated', profileId: id }, 'https://evil.test/')).toBe('string');
  });
});

describe('launch plan', () => {
  it('confines each profile to a dedicated directory and passes arguments, not a shell command', () => {
    const plan = launchPlan({ type: 'open', profileId: id, url: 'https://claude.ai/code/session_abc' }, options);
    expect(plan.command).toBe('/usr/bin/open');
    expect(plan.profile).toBe(`/Users/test user/Library/Application Support/Threadkeeper/Profiles/${id}`);
    expect(plan.args).toContain(`--user-data-dir=${plan.profile}`);
    expect(plan.args.at(-1)).toBe('https://claude.ai/code/session_abc');
    expect(plan.options.env.HOME).toBe(options.home);
    expect(Object.keys(plan.options.env).sort()).toEqual(['HOME', 'LOGNAME', 'PATH', 'TMPDIR', 'USER']);
    for (const profileId of ['../../Default', id + ';echo stolen', 'default', '-n']) {
      expect(() => launchPlan({ type: 'open', profileId, url: 'https://claude.ai/code' }, options)).toThrow();
    }
  });
  it('prefers an existing Session Control profile directory', () => {
    const legacy = `/Users/test user/Library/Application Support/SessionControlChrome/Profiles/${id}`;
    const plan = launchPlan(
      { type: 'open', profileId: id.toUpperCase(), url: 'https://claude.ai/code' },
      { ...options, exists: (p: string) => p === '/Applications/Google Chrome.app' || p === legacy }
    );
    expect(plan.profile).toBe(legacy);
  });
  it('fails on non-mac platforms', () => {
    expect(() => launchPlan({ type: 'open', profileId: id, url: 'https://claude.ai/code' }, { ...options, platform: 'linux' })).toThrow(/macOS/);
  });
});

describe('handle', () => {
  it('rejects invalid URLs before creating profiles or starting a process', async () => {
    let touched = false;
    for (const url of ['file:///etc/passwd', 'https://evil.test/code']) {
      await expect(handle({ type: 'open', profileId: id, url }, { ...options, mkdir: () => (touched = true), run: () => (touched = true) })).rejects.toThrow();
    }
    expect(touched).toBe(false);
  });
  it('opens once through an injected launcher', async () => {
    const calls: unknown[][] = [];
    const r = await handle({ type: 'open', profileId: id, url: 'https://chatgpt.com/c/1' }, { ...options, mkdir: (p: string) => calls.push(['mkdir', p]), run: async (c: string, a: string[]) => calls.push([c, a]) });
    expect(r).toEqual({ ok: true, opened: true });
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe('/usr/bin/open');
    await expect(handle({ type: 'open', profileId: id, url: 'https://claude.ai/code' }, { ...options, exists: () => false })).rejects.toThrow(/Install Google Chrome/);
  });
  it('ping reports version and platform, and refuses on other systems', async () => {
    expect(await handle({ type: 'ping' }, { platform: 'darwin' })).toEqual({ ok: true, version: '1.1.0', platform: 'macOS', backups: true });
    expect((await handle({ type: 'ping' }, { platform: 'linux' })).ok).toBe(false);
  });
});

describe('native framing', () => {
  it('handles split headers and multiple messages', () => {
    const messages: unknown[] = [], errors: string[] = [];
    const d = createDecoder((x: unknown) => messages.push(x), (e: Error) => errors.push(e.message));
    const data = Buffer.concat([frame({ type: 'ping' }), frame({ type: 'open', profileId: id })]);
    for (let i = 0; i < data.length; i += 3) d.push(data.subarray(i, i + 3));
    d.end();
    expect(messages).toHaveLength(2);
    expect(errors).toHaveLength(0);
  });
  it('rejects oversized frames and stops decoding', () => {
    const errors: string[] = [], messages: unknown[] = [];
    const d = createDecoder((x: unknown) => messages.push(x), (e: Error) => errors.push(e.message));
    const bad = Buffer.alloc(4);
    bad.writeUInt32LE(core.MAX_FRAME_BYTES + 1);
    d.push(bad);
    d.push(frame({ type: 'ping' }));
    expect(errors[0]).toMatch(/size/);
    expect(messages).toHaveLength(0);
  });
  it('reports incomplete and invalid messages', () => {
    const errors: string[] = [];
    const partial = createDecoder(() => {}, (e: Error) => errors.push(e.message));
    partial.push(Buffer.from([1, 0]));
    partial.end();
    expect(errors.at(-1)).toMatch(/Incomplete/);
    const junk = createDecoder(() => {}, (e: Error) => errors.push(e.message));
    const body = Buffer.from('{nope');
    const h = Buffer.alloc(4);
    h.writeUInt32LE(body.length);
    junk.push(Buffer.concat([h, body]));
    expect(errors.at(-1)).toMatch(/Invalid native JSON/);
  });
});

describe('installer', () => {
  it('binds one extension origin and preserves existing profile data', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tk install '$() "));
    try {
      const profile = path.join(home, 'Library/Application Support/Threadkeeper/Profiles/keep');
      fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(path.join(profile, 'sentinel'), 'keep');
      const ext = 'a'.repeat(32);
      const r = install({ platform: 'darwin', home, extensionId: ext, node: process.execPath });
      expect(r.root).toBe(path.join(home, 'Library/Application Support/Threadkeeper/Bridge'));
      expect(path.basename(r.manifest)).toBe('com.threadkeeper.accounts.json');
      const m = JSON.parse(fs.readFileSync(r.manifest, 'utf8'));
      expect(m.name).toBe('com.threadkeeper.accounts');
      expect(m.allowed_origins).toEqual([`chrome-extension://${ext}/`]);
      expect(spawnSync('sh', ['-n', m.path]).status).toBe(0);
      expect(fs.readFileSync(path.join(profile, 'sentinel'), 'utf8')).toBe('keep');
      const ping = spawnSync(process.execPath, [path.join(r.root, 'host.cjs'), m.allowed_origins[0]], { input: frame({ type: 'ping' }) });
      const out: any[] = [];
      createDecoder((x: unknown) => out.push(x), (e: Error) => { throw e; }).push(ping.stdout);
      expect(out[0].ok).toBe(process.platform === 'darwin');
      const wrong = spawnSync(process.execPath, [path.join(r.root, 'host.cjs'), `chrome-extension://${'b'.repeat(32)}/`], { input: frame({ type: 'ping' }) });
      expect(wrong.status).toBe(1);
      expect(wrong.stdout.length).toBe(0);
      expect(() => install({ platform: 'darwin', home, extensionId: '../../bad' })).toThrow(/extension ID/);
      expect(() => install({ platform: 'linux', home, extensionId: ext })).toThrow(/Mac/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('installer: browsers and extension IDs', () => {
  const support = 'Library/Application Support';
  const withHome = (run: (home: string) => void) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-helper-'));
    try {
      run(home);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };

  it('registers the helper with every installed browser, not only Chrome', () =>
    withHome((home) => {
      fs.mkdirSync(path.join(home, support, 'Microsoft Edge/Default'), { recursive: true });
      fs.mkdirSync(path.join(home, support, 'BraveSoftware/Brave-Browser'), { recursive: true });
      const r = install({ platform: 'darwin', home, extensionId: 'a'.repeat(32), node: process.execPath });
      expect(r.browsers).toEqual(['Google Chrome', 'Microsoft Edge', 'Brave']);
      for (const dir of ['Google/Chrome', 'Microsoft Edge', 'BraveSoftware/Brave-Browser']) {
        const m = JSON.parse(fs.readFileSync(path.join(home, support, dir, 'NativeMessagingHosts/com.threadkeeper.accounts.json'), 'utf8'));
        expect(m.path).toBe(path.join(r.root, 'launch-host'));
      }
      // A browser that is not installed gets no folder.
      expect(fs.existsSync(path.join(home, support, 'Vivaldi'))).toBe(false);
      uninstall({ home });
      expect(fs.existsSync(path.join(home, support, 'Microsoft Edge/NativeMessagingHosts/com.threadkeeper.accounts.json'))).toBe(false);
      expect(fs.existsSync(path.join(r.root, 'host.cjs'))).toBe(false);
    }));

  it('keeps earlier extension IDs and lets each of them call the host', () =>
    withHome((home) => {
      const first = 'a'.repeat(32), second = 'c'.repeat(32);
      install({ platform: 'darwin', home, extensionId: first, node: process.execPath });
      const r = install({ platform: 'darwin', home, extensionIds: [second], node: process.execPath });
      expect(r.extensionIds).toEqual([second, first]);
      const m = JSON.parse(fs.readFileSync(r.manifest, 'utf8'));
      expect(m.allowed_origins).toEqual([`chrome-extension://${second}/`, `chrome-extension://${first}/`]);
      for (const id of [first, second]) {
        const ping = spawnSync(process.execPath, [path.join(r.root, 'host.cjs'), `chrome-extension://${id}/`], { input: frame({ type: 'ping' }) });
        expect(ping.status).toBe(0);
        expect(ping.stdout.length).toBeGreaterThan(4);
      }
    }));

  it('starts through the launcher with an empty PATH, and when the recorded Node.js is gone', () =>
    withHome((home) => {
      const ext = 'a'.repeat(32);
      const r = install({ platform: 'darwin', home, extensionId: ext, node: process.execPath });
      const launcher = path.join(r.root, 'launch-host');
      const ok = spawnSync(launcher, [`chrome-extension://${ext}/`], { input: frame({ type: 'ping' }), env: { HOME: home, PATH: '' } });
      expect(ok.status).toBe(0);
      // The recorded Node.js no longer exists: the launcher falls back to another one under HOME.
      const bin = path.join(home, '.nvm/versions/node/v99.0.0/bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.symlinkSync(process.execPath, path.join(bin, 'node'));
      install({ platform: 'darwin', home, extensionId: ext, node: path.join(home, 'removed/node') });
      const text = fs.readFileSync(launcher, 'utf8');
      // Keep only the recorded path and the HOME-relative ones, so the test does not pass by
      // finding this machine's system Node.js.
      fs.writeFileSync(launcher, text.replace(' /opt/homebrew/bin/node /usr/local/bin/node', '').replace(' /usr/bin/node;', ';'));
      const fallback = spawnSync(launcher, [`chrome-extension://${ext}/`], { input: frame({ type: 'ping' }), env: { HOME: home, PATH: '' } });
      expect(fallback.status).toBe(0);
      expect(fallback.stdout.length).toBeGreaterThan(4);
    }));

  it('finds ThreadStack in browser profiles and adds the fixed ID', () =>
    withHome((home) => {
      const unpacked = path.join(home, 'ext');
      fs.mkdirSync(unpacked, { recursive: true });
      fs.writeFileSync(path.join(unpacked, 'manifest.json'), JSON.stringify({ name: 'ThreadStack' }));
      // A build from before the rename is still named Threadkeeper; it is the same extension.
      const older = path.join(home, 'ext-older');
      fs.mkdirSync(older, { recursive: true });
      fs.writeFileSync(path.join(older, 'manifest.json'), JSON.stringify({ name: 'Threadkeeper' }));
      const profile = path.join(home, support, 'Microsoft Edge/Default');
      fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(
        path.join(profile, 'Secure Preferences'),
        JSON.stringify({
          extensions: {
            settings: {
              ['b'.repeat(32)]: { path: unpacked, location: 4 },
              ['c'.repeat(32)]: { path: older, location: 4 },
              ['d'.repeat(32)]: { manifest: { name: 'Something else' } },
              // An installed extension that only calls itself ThreadStack is not trusted.
              ['e'.repeat(32)]: { manifest: { name: 'ThreadStack' }, path: unpacked },
              'not-an-id': { manifest: { name: 'ThreadStack' } },
            },
          },
        })
      );
      const source = path.join(home, 'repo/mac-helper');
      fs.mkdirSync(path.join(home, 'repo/shared'), { recursive: true });
      fs.mkdirSync(source, { recursive: true });
      const key = Buffer.from('a public key').toString('base64');
      fs.writeFileSync(path.join(home, 'repo/shared/extension-key.json'), JSON.stringify({ key }));
      const found = detectExtensionIds({ home, source });
      expect(found).toEqual([
        { id: core.extensionIdFromKey(key), where: 'fixed ID' },
        { id: 'b'.repeat(32), where: 'Microsoft Edge' },
        { id: 'c'.repeat(32), where: 'Microsoft Edge' },
      ]);
      expect(core.extensionIdFromKey(key)).toMatch(/^[a-p]{32}$/);
    }));
});

describe('library backups', () => {
  const withSession = (run: (session: any, home: string, clock: { t: number }) => void) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-backup-'));
    const clock = { t: Date.UTC(2026, 0, 2, 3, 4, 5) };
    try {
      run(core.createBackupSession({ home, now: () => new Date(clock.t) }), home, clock);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
  const write = (session: any, bytes: Buffer, meta: object) => {
    session.handle({ type: 'backup-begin' });
    for (let i = 0; i < bytes.length; i += 1000) session.handle({ type: 'backup-chunk', data: bytes.subarray(i, i + 1000).toString('base64') });
    return session.handle({ type: 'backup-commit', meta });
  };

  it('writes a backup in pieces and reads the same bytes back', () =>
    withSession((session, home) => {
      const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
      const done = write(session, bytes, { threads: 12, messages: 90, createdAt: '2026-01-02T03:04:05Z', extensionVersion: '0.5.0', extensionId: 'a'.repeat(32) });
      expect(done).toEqual({ ok: true, name: 'library-20260102-030405.tkbackup', bytes: 5000 });
      const dir = core.backupDir(home);
      expect(fs.statSync(path.join(dir, done.name)).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(dir).some((n: string) => n.startsWith('.partial-'))).toBe(false);
      expect(session.handle({ type: 'backup-list' }).backups).toEqual([
        { name: done.name, bytes: 5000, threads: 12, messages: 90, createdAt: '2026-01-02T03:04:05Z', extensionVersion: '0.5.0', extensionId: 'a'.repeat(32) },
      ]);
      const first = session.handle({ type: 'backup-read', name: done.name, offset: 0 });
      expect(first.done).toBe(true);
      expect(Buffer.from(first.data, 'base64').equals(bytes)).toBe(true);
      const tail = session.handle({ type: 'backup-read', name: done.name, offset: 4990 });
      expect(Buffer.from(tail.data, 'base64').equals(bytes.subarray(4990))).toBe(true);
    }));

  it('refuses names outside the backup folder and requests out of order', () =>
    withSession((session) => {
      for (const name of ['../../../etc/passwd', 'library-20260102-030405.tkbackup/../x', '.partial-abc', 'x.tkbackup', 42]) {
        expect(() => session.handle({ type: 'backup-read', name, offset: 0 })).toThrow(/Unknown backup/);
      }
      expect(() => session.handle({ type: 'backup-read', name: 'library-20260102-030405.tkbackup', offset: 0 })).toThrow(/no longer exists/);
      expect(() => session.handle({ type: 'backup-chunk', data: 'AAAA' })).toThrow(/No backup/);
      expect(() => session.handle({ type: 'backup-commit', meta: {} })).toThrow(/No backup/);
      session.handle({ type: 'backup-begin' });
      expect(() => session.handle({ type: 'backup-commit', meta: {} })).toThrow(/empty/);
    }));

  it('leaves nothing behind when a backup is cut off', () =>
    withSession((session, home) => {
      session.handle({ type: 'backup-begin' });
      session.handle({ type: 'backup-chunk', data: Buffer.from('half').toString('base64') });
      session.abort();
      expect(fs.readdirSync(core.backupDir(home))).toEqual([]);
      expect(session.handle({ type: 'backup-list' }).backups).toEqual([]);
    }));

  it('keeps the newest backups and never drops the fullest one', () =>
    withSession((session, home, clock) => {
      const full = write(session, Buffer.from('full library'), { threads: 500 });
      for (let i = 0; i < core.BACKUP_KEEP + 2; i++) {
        clock.t += 60_000;
        write(session, Buffer.from('nearly empty'), { threads: 1 });
      }
      const names = session.handle({ type: 'backup-list' }).backups.map((b: any) => b.name);
      expect(names).toHaveLength(core.BACKUP_KEEP + 1);
      expect(names).toContain(full.name);
      expect(fs.readdirSync(core.backupDir(home)).filter((n: string) => n.endsWith('.json'))).toHaveLength(core.BACKUP_KEEP + 1);
      expect(core.backupsToPrune([{ name: 'b', threads: 1 }, { name: 'a', threads: 9 }], 1)).toEqual([]);
      expect(core.backupsToPrune([{ name: 'd', threads: 9, bytes: 9, messages: 9 }, { name: 'c', threads: 1 }, { name: 'b', threads: 2 }, { name: 'a', threads: 1 }], 1)).toEqual(['c', 'b', 'a']);
    }));

  it('answers backup requests through handle with short errors only', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-backup-'));
    try {
      expect(await handle({ type: 'backup-list' }, { platform: 'darwin', home })).toEqual({ ok: true, backups: [] });
      await expect(handle({ type: 'backup-read', name: '../x', offset: 0 }, { platform: 'darwin', home })).rejects.toThrow('Unknown backup.');
      await expect(handle({ type: 'backup-list' }, { platform: 'linux', home })).rejects.toThrow(/macOS/);
      // A system error (the backup folder is a file) never carries its path to the extension.
      fs.mkdirSync(path.join(home, 'Library/Application Support/Threadkeeper'), { recursive: true });
      fs.writeFileSync(path.join(home, 'Library/Application Support/Threadkeeper/Backups'), 'not a folder');
      await expect(handle({ type: 'backup-begin' }, { platform: 'darwin', home })).rejects.toThrow('The backup folder could not be used.');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('fixed extension ID', () => {
  it('the checked-in key yields the checked-in ID', () => {
    const fixed = JSON.parse(fs.readFileSync(path.join(__dirname, '../../shared/extension-key.json'), 'utf8'));
    expect(core.extensionIdFromKey(fixed.key)).toBe(fixed.extensionId);
    expect(fixed.extensionId).toMatch(/^[a-p]{32}$/);
  });
});

describe('library backups: what is never pruned', () => {
  const b = (name: string, threads: number, messages: number, bytes: number) => ({ name, threads, messages, bytes });

  it('keeps the backup that still has the messages when later ones have the same thread count', () => {
    // Threads kept their count but lost their messages; five newer backups follow.
    const list = [b('g', 800, 0, 10), b('f', 800, 0, 10), b('e', 800, 0, 10), b('d', 800, 0, 10), b('c', 800, 0, 10), b('a', 800, 9000, 5000)];
    expect(core.backupsToPrune(list)).toEqual([]);
    expect(core.backupsToPrune([b('h', 800, 0, 10), ...list])).toEqual(['c']);
  });

  it('keeps the largest file whatever counts a backup claims', () => {
    const forged = b('a', 9e15, 9e15, 10);
    const real = b('b', 800, 9000, 5000);
    const fresh = ['h', 'g', 'f', 'e', 'd'].map((n) => b(n, 1, 1, 10));
    expect(core.backupsToPrune([...fresh, real, forged])).not.toContain('b');
  });

  it('never removes the backup it just wrote, and refuses one that did not arrive whole', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-backup-'));
    try {
      const dir = core.backupDir(home);
      fs.mkdirSync(dir, { recursive: true });
      // Six backups dated in the future (the clock was ahead once).
      for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir, `library-2099010${i}-000000.tkbackup`), 'x'.repeat(100 + i));
      const session = core.createBackupSession({ home, now: () => new Date(Date.UTC(2026, 0, 2)) });
      session.handle({ type: 'backup-begin' });
      session.handle({ type: 'backup-chunk', data: Buffer.from('new').toString('base64') });
      const done = session.handle({ type: 'backup-commit', meta: { threads: 3 }, bytes: 3 });
      expect(fs.existsSync(path.join(dir, done.name))).toBe(true);

      session.handle({ type: 'backup-begin' });
      session.handle({ type: 'backup-chunk', data: Buffer.from('short').toString('base64') });
      expect(() => session.handle({ type: 'backup-commit', meta: {}, bytes: 999 })).toThrow(/did not arrive whole/);
      expect(fs.readdirSync(dir).some((n: string) => n.startsWith('.partial-'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('leaves another browser\'s backup in progress alone', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-backup-'));
    try {
      const now = () => new Date();
      const first = core.createBackupSession({ home, now });
      const second = core.createBackupSession({ home, now });
      first.handle({ type: 'backup-begin' });
      first.handle({ type: 'backup-chunk', data: Buffer.from('from edge').toString('base64') });
      second.handle({ type: 'backup-begin' });
      second.handle({ type: 'backup-chunk', data: Buffer.from('from chrome').toString('base64') });
      expect(first.handle({ type: 'backup-commit', meta: { threads: 1 } }).ok).toBe(true);
      expect(second.handle({ type: 'backup-commit', meta: { threads: 1 } }).ok).toBe(true);
      expect(first.handle({ type: 'backup-list' }).backups).toHaveLength(2);
      // A piece abandoned long ago is cleared by the next backup.
      const stale = path.join(core.backupDir(home), '.partial-old');
      fs.writeFileSync(stale, 'x');
      fs.utimesSync(stale, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
      first.handle({ type: 'backup-begin' });
      expect(fs.existsSync(stale)).toBe(false);
      first.abort();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('build: which extension ID a folder gets', () => {
  const script = path.join(__dirname, '../../scripts/build-extension.mjs');
  const liveDir = path.join(__dirname, '../../.output/chrome-mv3');
  const fixed = JSON.parse(fs.readFileSync(path.join(__dirname, '../../shared/extension-key.json'), 'utf8')).extensionId;
  // HOME decides which browser profiles the build looks at; nothing is built by --print-id.
  const printId = (home: string, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [script, '--print-id'], { env: { PATH: process.env.PATH ?? '', HOME: home, ...env }, encoding: 'utf8' }).stdout.trim();
  const withProfile = (settings: object, run: (home: string) => void) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-build-id-'));
    try {
      const profile = path.join(home, 'Library/Application Support/Microsoft Edge Canary/Default');
      fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(path.join(profile, 'Secure Preferences'), JSON.stringify({ extensions: { settings } }));
      run(home);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };

  it.runIf(process.platform === 'darwin')('uses the fixed ID when no browser has the folder loaded', () =>
    withProfile({ ['c'.repeat(32)]: { path: '/somewhere/else' } }, (home) => {
      expect(printId(home)).toBe(`${fixed} fixed`);
    }));

  it.runIf(process.platform === 'darwin')('keeps whatever ID a browser already has the folder loaded under', () =>
    withProfile({ ['c'.repeat(32)]: { path: liveDir } }, (home) => {
      expect(printId(home)).toBe(`${'c'.repeat(32)} path`);
      // Still so when another profile has it under the fixed ID: one library left behind is one too many.
      const other = path.join(home, 'Library/Application Support/Google/Chrome/Default');
      fs.mkdirSync(other, { recursive: true });
      fs.writeFileSync(path.join(other, 'Preferences'), JSON.stringify({ extensions: { settings: { [fixed]: { path: liveDir } } } }));
      expect(printId(home)).toBe(`${'c'.repeat(32)} path`);
      // Moving on purpose.
      expect(printId(home, { TK_STABLE_ID: '1' })).toBe(`${fixed} fixed`);
    }));

  it.runIf(process.platform === 'darwin')('gives a build to another folder no key, so it cannot open the real library', () =>
    withProfile({}, (home) => {
      expect(printId(home, { TK_OUT_DIR: path.join(home, 'test-build') })).toMatch(/^[a-p]{32} path$/);
      expect(printId(home, { TK_OUT_DIR: path.join(home, 'test-build') })).not.toContain(fixed);
    }));
});
