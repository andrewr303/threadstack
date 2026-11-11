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
const { install } = require('../../mac-helper/install.cjs');
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
    expect(await handle({ type: 'ping' }, { platform: 'darwin' })).toEqual({ ok: true, version: '1.0.0', platform: 'macOS' });
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
    bad.writeUInt32LE(65537);
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
