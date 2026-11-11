'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const HOST = 'com.threadkeeper.accounts';
const VERSION = '1.0.0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Sites a person may open in an account's own Chrome profile. Kept in step with
// src/core/embed/helper-protocol.ts (a test compares the two lists).
const BASE_HOSTS = [
  'claude.ai', 'chatgpt.com', 'chat.openai.com', 'grok.com', 'x.com', 'twitter.com', 'cursor.com',
  'muse.ai', 'meta.ai', 'gemini.google.com', 'aistudio.google.com', 'jules.google.com',
  'perplexity.ai', 'chat.deepseek.com', 'chat.mistral.ai', 'copilot.microsoft.com', 'copilot.com',
  'github.com', 'app.devin.ai'
];
const SIGN_IN_HOSTS = ['auth.openai.com', 'accounts.x.ai', 'authenticator.cursor.sh'];
const ALLOWED_HOSTS = [...BASE_HOSTS.flatMap(h => [h, `www.${h}`]), ...SIGN_IN_HOSTS];
const SUPPORT = 'Library/Application Support';
function aiUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw Error('Invalid session URL.');
  let u; try { u = new URL(value); } catch { throw Error('Invalid session URL.'); }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || !ALLOWED_HOSTS.includes(u.hostname)) throw Error('Only https addresses on supported AI sites may be opened.');
  return u.href;
}
// Session Control's profiles keep their logins, so a profile that already exists there wins.
function profileDir(home, profileId, exists = fs.existsSync) {
  const id = profileId.toLowerCase();
  const legacy = path.join(home, SUPPORT, 'SessionControlChrome/Profiles', id);
  return exists(legacy) ? legacy : path.join(home, SUPPORT, 'Threadkeeper/Profiles', id);
}
function launchPlan(message, { platform = process.platform, home = os.homedir(), exists = fs.existsSync } = {}) {
  if (platform !== 'darwin') throw Error('The account profile helper requires macOS.');
  if (!message || message.type !== 'open' || !UUID.test(message.profileId || '')) throw Error('Invalid account profile ID.');
  const url = aiUrl(message.url);
  const app = ['/Applications/Google Chrome.app', path.join(home, 'Applications/Google Chrome.app')].find(p => exists(p));
  if (!app) throw Error('Install Google Chrome in Applications, then try again.');
  const profile = profileDir(home, message.profileId, exists);
  const user = os.userInfo().username;
  return { command: '/usr/bin/open', args: ['-n', '-a', app, '--args', `--user-data-dir=${profile}`, '--profile-directory=Default', '--no-first-run', '--no-default-browser-check', url], profile, options: { timeout: 15000, maxBuffer: 16384, env: { HOME: home, USER: user, LOGNAME: user, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: os.tmpdir() } } };
}
async function handle(message, options = {}) {
  const platform = options.platform || process.platform;
  if (message?.type === 'ping') return platform === 'darwin' ? { ok: true, version: VERSION, platform: 'macOS' } : { ok: false, error: 'The account profile helper requires macOS.' };
  const plan = launchPlan(message, options);
  const mkdir = options.mkdir || (p => fs.mkdirSync(p, { recursive: true, mode: 0o700 }));
  // No cookie or credential reads. Only this app's dedicated profile directory is created.
  mkdir(plan.profile);
  const run = options.run || ((cmd, args, opts) => new Promise((resolve, reject) => execFile(cmd, args, opts, e => e ? reject(Error('Chrome could not be opened. Check that Google Chrome is installed and try again.')) : resolve())));
  await run(plan.command, plan.args, plan.options);
  return { ok: true, opened: true };
}
function frame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8'), header = Buffer.alloc(4); header.writeUInt32LE(body.length); return Buffer.concat([header, body]);
}
function createDecoder(onMessage, onError) {
  let buffer = Buffer.alloc(0), dead = false;
  return { push(chunk) {
    if (dead) return;
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const n = buffer.readUInt32LE(0);
      if (n < 2 || n > 65536) { dead = true; buffer = Buffer.alloc(0); onError(Error('Native message exceeds the allowed size.')); return; }
      if (buffer.length < 4 + n) return;
      const body = buffer.subarray(4, 4 + n); buffer = buffer.subarray(4 + n);
      try { onMessage(JSON.parse(body.toString('utf8'))); } catch { onError(Error('Invalid native JSON message.')); }
    }
  }, end() { if (buffer.length && !dead) onError(Error('Incomplete native message.')); } };
}
module.exports = { HOST, VERSION, ALLOWED_HOSTS, aiUrl, profileDir, launchPlan, handle, frame, createDecoder };
