// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { helperPaperclip } from '../../src/core/embed/helper.js';
const require = createRequire(import.meta.url);
const { handle } = require('../../mac-helper/core.cjs');
const { install } = require('../../mac-helper/install.cjs');

describe('fixed Paperclip helper registration', () => {
  it('records a source shim without registering a service, and ignores message paths', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-helper-paperclip-'));
    try {
      const fork = path.join(home, "fork ' spaced");
      for (const file of ['cli/src/index.ts', 'cli/node_modules/tsx/dist/cli.mjs']) {
        fs.mkdirSync(path.dirname(path.join(fork, file)), { recursive: true });
        fs.writeFileSync(path.join(fork, file), '');
      }
      fs.writeFileSync(path.join(fork, 'package.json'), '{"name":"paperclip"}');
      fs.writeFileSync(path.join(fork, 'cli/node_modules/tsx/dist/cli.mjs'), 'process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}))');
      const result = install({ platform: 'darwin', home, paperclipRoot: fork, node: process.execPath,
        extensionId: 'a'.repeat(32), source: path.resolve('mac-helper') });
      const config = JSON.parse(fs.readFileSync(path.join(result.root, 'config.json'), 'utf8'));
      expect(config.paperclip.root).toBe(fs.realpathSync(fork));
      expect(fs.readFileSync(config.paperclip.shim, 'utf8')).toContain('exec ');
      // Both names: the server reads the new one, and a server from before the rename the old one.
      expect(fs.readFileSync(config.paperclip.shim, 'utf8')).toContain(`PAPERCLIP_THREADSTACK_EXTENSION_IDS='${'a'.repeat(32)}'`);
      expect(fs.readFileSync(config.paperclip.shim, 'utf8')).toContain(`PAPERCLIP_THREADKEEPER_EXTENSION_IDS='${'a'.repeat(32)}'`);
      expect(fs.readFileSync(config.paperclip.shim, 'utf8')).toContain('PAPERCLIP_BUNDLED_PLUGIN_ROOT=');
      const execution = spawnSync(config.paperclip.shim, ['service', 'status', '--json'], { encoding: 'utf8' });
      expect(execution.status).toBe(0);
      expect(JSON.parse(execution.stdout)).toEqual({ args: [path.join(fork, 'cli/src/index.ts'), 'service', 'status', '--json'], cwd: fs.realpathSync(fork) });
      expect(fs.existsSync(path.join(home, 'Library/LaunchAgents'))).toBe(false);
      const calls: unknown[][] = [];
      // A real status names its service, and the launchd definition must point at this shim.
      const options = { platform: 'darwin', paperclip: config.paperclip,
        readFile: () => `<key>ProgramArguments</key><array><string>${config.paperclip.shim}</string></array>`,
        run: async (...args: unknown[]) => {
          calls.push(args);
          return { stdout: JSON.stringify({ serviceName: 'ing.paperclip.paperclipai', installed: true, active: false }) };
        } };
      expect(await handle({ type: 'paperclip.start', path: '/tmp/evil', command: 'echo stolen', args: ['uninstall'] }, options)).toEqual({ ok: true, started: true });
      expect(calls).toHaveLength(2);
      expect(calls.every(call => call[0] === config.paperclip.shim)).toBe(true);
      expect(calls[1][1]).toEqual(['service', 'start', '--json', '--instance', 'default']);
      expect(JSON.stringify(calls)).not.toContain('evil');
      expect(await handle({ type: 'paperclip.status' }, { platform: 'darwin' })).toEqual({ ok: false, error: 'paperclip_not_registered' });
      expect(await handle({ type: 'paperclip.start' }, { ...options, platform: 'linux' })).toEqual({ ok: false, error: 'unsupported_platform' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('will not auto-install a service from a start request', async () => {
    let starts = 0;
    const reply = await handle({ type: 'paperclip.start' }, { platform: 'darwin', paperclip: {
      root: '/registered', shim: '/registered/shim', instanceId: 'default',
    }, exists: () => true, run: async () => { starts++; return { stdout: '{"installed":false,"active":false}' }; } });
    expect(reply).toEqual({ ok: false, error: 'paperclip_not_registered' });
    expect(starts).toBe(1);
  });

  it('does not contact native messaging without permission and bounds replies', async () => {
    let calls = 0;
    const env = { hasPermission: async () => false, send: async () => { calls++; } };
    expect((await helperPaperclip(env, 'start')).ok).toBe(false);
    expect(calls).toBe(0);
    expect(await helperPaperclip({ ...env, hasPermission: async () => true, send: async () => ({ ok: true, paperclip: { service: 'evil' } }) }, 'status')).toEqual({ ok: false, error: 'helper_unavailable' });
  });

  it('never replaces another Paperclip installation during automatic start', async () => {
    const calls: string[][] = [];
    const result = await handle({ type: 'paperclip.start' }, { platform: 'darwin',
      paperclip: { root: '/fork', shim: '/bridge/paperclip-source', instanceId: 'default' }, exists: () => true,
      readFile: () => '<key>ProgramArguments</key><array><string>/other/paperclipai</string></array>',
      run: async (_command: string, args: string[]) => { calls.push(args); return { stdout: '{"serviceName":"ing.paperclip.paperclipai","installed":true,"active":false}' }; } });
    expect(result).toEqual({ ok: false, error: 'paperclip_not_registered' });
    expect(calls).toHaveLength(1);
  });

  it('treats an installed status without a serviceName as not registered, even when the definition matches', async () => {
    const calls: string[][] = [];
    const options = { platform: 'darwin', paperclip: { root: '/fork', shim: '/bridge/paperclip-source', instanceId: 'default' }, exists: () => true,
      readFile: () => '<key>ProgramArguments</key><array><string>/bridge/paperclip-source</string></array>',
      run: async (_command: string, args: string[]) => { calls.push(args); return { stdout: '{"installed":true,"active":false}' }; } };
    expect(await handle({ type: 'paperclip.status' }, options)).toEqual({ ok: true, paperclip: { service: 'not_installed' } });
    expect(await handle({ type: 'paperclip.start' }, options)).toEqual({ ok: false, error: 'paperclip_not_registered' });
    expect(calls.every(args => args[1] === 'status')).toBe(true);
  });

  it('runs the Finder installer with blank optional answers on the stock macOS Bash', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-helper-finder-'));
    try {
      const bin = path.join(temp, 'bin'); fs.mkdirSync(bin);
      const capture = path.join(temp, 'arguments');
      fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$TASK_CAPTURE"\n', { mode: 0o700 });
      const result = spawnSync('/bin/bash', [path.resolve('mac-helper/Install Mac Helper.command')], {
        input: '\n\n\n', encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TASK_CAPTURE: capture },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(capture, 'utf8')).toBe('install.cjs\n');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
});
