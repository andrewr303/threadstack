'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const HOST = 'com.threadkeeper.accounts';
const VERSION = '1.1.0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTENSION_ID = /^[a-p]{32}$/;
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
// Every Chromium browser keeps its own NativeMessagingHosts folder and never looks in another
// browser's. The installer registers the helper in each of these that exists on this Mac.
const BROWSERS = [
  { name: 'Google Chrome', dir: 'Google/Chrome' },
  { name: 'Google Chrome Beta', dir: 'Google/Chrome Beta' },
  { name: 'Google Chrome Dev', dir: 'Google/Chrome Dev' },
  { name: 'Google Chrome Canary', dir: 'Google/Chrome Canary' },
  { name: 'Google Chrome for Testing', dir: 'Google/Chrome for Testing' },
  { name: 'Chromium', dir: 'Chromium' },
  { name: 'Microsoft Edge', dir: 'Microsoft Edge' },
  { name: 'Microsoft Edge Beta', dir: 'Microsoft Edge Beta' },
  { name: 'Microsoft Edge Dev', dir: 'Microsoft Edge Dev' },
  { name: 'Microsoft Edge Canary', dir: 'Microsoft Edge Canary' },
  { name: 'Brave', dir: 'BraveSoftware/Brave-Browser' },
  { name: 'Arc', dir: 'Arc/User Data' },
  { name: 'Vivaldi', dir: 'Vivaldi' },
  { name: 'Opera', dir: 'com.operasoftware.Opera' }
];
// Library backups: one gzip file per backup, written in pieces by the extension.
const BACKUP_NAME = /^library-\d{8}-\d{6}(-\d{1,3})?\.tkbackup$/;
const BACKUP_KEEP = 5;
const BACKUP_MAX_BYTES = 8 * 1024 * 1024 * 1024;
const BACKUP_CHUNK_BYTES = 512 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;

function aiUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw Error('Invalid session URL.');
  let u; try { u = new URL(value); } catch { throw Error('Invalid session URL.'); }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || !ALLOWED_HOSTS.includes(u.hostname)) throw Error('Only https addresses on supported AI sites may be opened.');
  return u.href;
}
/** The extension ID a browser derives from a manifest `key` (base64 of the public key). */
function extensionIdFromKey(keyBase64) {
  const hex = crypto.createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
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

// ---- Library backups ----------------------------------------------------------------------
// The helper stores bytes it is given and hands them back. It never reads what is inside.
function backupDir(home) { return path.join(home, SUPPORT, 'Threadkeeper/Backups'); }
function backupStamp(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
}
function cleanMeta(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  // Counts come from the extension and are only shown; nothing is decided on them alone.
  const count = v => (Number.isSafeInteger(v) && v >= 0 && v <= 1e9 ? v : 0);
  const text = v => (typeof v === 'string' ? v.slice(0, 80) : '');
  return { threads: count(m.threads), messages: count(m.messages), createdAt: text(m.createdAt), extensionVersion: text(m.extensionVersion), extensionId: EXTENSION_ID.test(m.extensionId || '') ? m.extensionId : '' };
}
function listBackups(home) {
  const dir = backupDir(home);
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => BACKUP_NAME.test(n)); } catch { return []; }
  const out = [];
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (!stat.isFile()) continue;
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8')); } catch { /* no details saved */ }
      out.push({ name, bytes: stat.size, ...cleanMeta(meta) });
    } catch { /* removed meanwhile */ }
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}
/**
 * Which backups to delete: all but the newest BACKUP_KEEP, and never the largest file, the one
 * with the most threads, the one with the most messages, or the one just written (`justWritten`).
 * A fresh or damaged library (few threads, or threads that lost their messages) must not be able
 * to push the full one out. File size is measured here, so it does not depend on what the
 * extension says a backup holds.
 */
function backupsToPrune(backups, keep = BACKUP_KEEP, justWritten = null) {
  const sorted = [...backups].sort((a, b) => (a.name < b.name ? 1 : -1));
  // Ties go to the older backup: it is the one further from whatever went wrong since.
  const most = field => sorted.reduce((best, b) => (!best || (b[field] || 0) >= (best[field] || 0) ? b : best), null);
  const kept = new Set([most('bytes'), most('threads'), most('messages')]);
  return sorted.slice(keep).filter(b => !kept.has(b) && b.name !== justWritten).map(b => b.name);
}
/** One connection's backup state: at most one backup being written at a time. */
function createBackupSession({ home = os.homedir(), now = () => new Date() } = {}) {
  const dir = backupDir(home);
  let writing = null;
  const abort = () => {
    if (!writing) return;
    try { fs.closeSync(writing.fd); } catch { /* already closed */ }
    try { fs.unlinkSync(writing.file); } catch { /* already gone */ }
    writing = null;
  };
  return {
    abort,
    handle(message) {
      switch (message.type) {
        case 'backup-list':
          return { ok: true, backups: listBackups(home) };
        case 'backup-begin': {
          abort();
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          // Pieces left by a backup that never finished. Recent ones may belong to Threadkeeper in
          // another browser backing up right now, so only old ones are cleared.
          for (const n of fs.readdirSync(dir)) {
            if (!n.startsWith('.partial-')) continue;
            try { const f = path.join(dir, n); if (now().getTime() - fs.statSync(f).mtimeMs > 3600000) fs.unlinkSync(f); } catch { /* in use */ }
          }
          const file = path.join(dir, `.partial-${crypto.randomBytes(8).toString('hex')}`);
          writing = { file, fd: fs.openSync(file, 'wx', 0o600), bytes: 0 };
          return { ok: true };
        }
        case 'backup-chunk': {
          if (!writing) throw Error('No backup is being written.');
          if (typeof message.data !== 'string' || !message.data) throw Error('Invalid backup data.');
          const data = Buffer.from(message.data, 'base64');
          if (!data.length || writing.bytes + data.length > BACKUP_MAX_BYTES) { abort(); throw Error('The backup is too large.'); }
          let written = 0;
          while (written < data.length) written += fs.writeSync(writing.fd, data, written);
          writing.bytes += data.length;
          return { ok: true, bytes: writing.bytes };
        }
        case 'backup-commit': {
          if (!writing) throw Error('No backup is being written.');
          if (!writing.bytes) { abort(); throw Error('The backup is empty.'); }
          // The extension says how many bytes it sent; a file of another size is not kept.
          if (message.bytes !== undefined && (message.bytes !== writing.bytes || fs.fstatSync(writing.fd).size !== writing.bytes)) { abort(); throw Error('The backup did not arrive whole.'); }
          const meta = cleanMeta(message.meta);
          fs.fsyncSync(writing.fd);
          fs.closeSync(writing.fd);
          const stamp = backupStamp(now());
          let name = `library-${stamp}.tkbackup`;
          for (let i = 1; fs.existsSync(path.join(dir, name)); i++) name = `library-${stamp}-${i}.tkbackup`;
          fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(meta), { mode: 0o600 });
          fs.renameSync(writing.file, path.join(dir, name));
          const bytes = writing.bytes;
          writing = null;
          for (const old of backupsToPrune(listBackups(home), BACKUP_KEEP, name)) {
            for (const f of [old, old + '.json']) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* already gone */ } }
          }
          return { ok: true, name, bytes };
        }
        case 'backup-abort':
          abort();
          return { ok: true };
        case 'backup-read': {
          if (typeof message.name !== 'string' || !BACKUP_NAME.test(message.name)) throw Error('Unknown backup.');
          const offset = message.offset;
          if (!Number.isSafeInteger(offset) || offset < 0) throw Error('Invalid backup position.');
          let fd;
          try { fd = fs.openSync(path.join(dir, message.name), 'r'); } catch { throw Error('That backup no longer exists.'); }
          try {
            const size = fs.fstatSync(fd).size;
            const buffer = Buffer.alloc(Math.max(0, Math.min(BACKUP_CHUNK_BYTES, size - offset)));
            const read = buffer.length ? fs.readSync(fd, buffer, 0, buffer.length, offset) : 0;
            return { ok: true, data: buffer.subarray(0, read).toString('base64'), done: offset + read >= size, bytes: size };
          } finally { fs.closeSync(fd); }
        }
        default:
          throw Error('Unknown request.');
      }
    }
  };
}

async function handle(message, options = {}) {
  const platform = options.platform || process.platform;
  if (message?.type === 'ping') return platform === 'darwin' ? { ok: true, version: VERSION, platform: 'macOS', backups: true } : { ok: false, error: 'The account profile helper requires macOS.' };
  if (['paperclip.status', 'paperclip.start', 'paperclip.install'].includes(message?.type)) return handlePaperclip(message.type, options);
  if (typeof message?.type === 'string' && message.type.startsWith('backup-')) {
    if (platform !== 'darwin') throw Error('The account profile helper requires macOS.');
    const session = options.session || createBackupSession(options);
    try { return session.handle(message); } catch (e) {
      // Only this file's own short sentences reach the extension, never a system error with a path.
      throw Error(/^[A-Z][^/\\]*\.$/.test(e.message) ? e.message : 'The backup folder could not be used.');
    }
  }
  const plan = launchPlan(message, options);
  const mkdir = options.mkdir || (p => fs.mkdirSync(p, { recursive: true, mode: 0o700 }));
  // No cookie or credential reads. Only this app's dedicated profile directory is created.
  mkdir(plan.profile);
  const run = options.run || ((cmd, args, opts) => new Promise((resolve, reject) => execFile(cmd, args, opts, e => e ? reject(Error('Chrome could not be opened. Check that Google Chrome is installed and try again.')) : resolve())));
  await run(plan.command, plan.args, plan.options);
  return { ok: true, opened: true };
}

async function handlePaperclip(type, options) {
  if ((options.platform || process.platform) !== 'darwin') return { ok: false, error: 'unsupported_platform' };
  const registration = options.paperclip;
  if (!registration || !path.isAbsolute(registration.root || '') || !path.isAbsolute(registration.shim || '')
      || !/^[A-Za-z0-9_-]{1,80}$/.test(registration.instanceId || '')) return { ok: false, error: 'paperclip_not_registered' };
  const exists = options.exists || fs.existsSync;
  if (!exists(registration.root) || !exists(registration.shim)) return { ok: false, error: 'paperclip_start_failed' };
  const run = options.run || ((command, args, opts) => new Promise((resolve, reject) => execFile(command, args, opts,
    (error, stdout) => error ? reject(error) : resolve({ stdout }))));
  const env = { HOME: options.home || os.homedir(), PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    PAPERCLIP_SHIM_PATH: registration.shim };
  for (const name of ['USER', 'LOGNAME', 'TMPDIR']) if (process.env[name]) env[name] = process.env[name];
  const invoke = verb => run(registration.shim, ['service', verb, '--json', '--instance', registration.instanceId],
    { cwd: registration.root, env, timeout: verb === 'install' ? 60_000 : 15_000, maxBuffer: 1024 * 1024, windowsHide: true });
  try {
    if (type === 'paperclip.install') {
      await invoke('install');
      return { ok: true, started: true };
    }
    const result = await invoke('status');
    const status = JSON.parse(result.stdout);
    if (typeof status.installed !== 'boolean' || typeof status.active !== 'boolean') throw Error('invalid_status');
    // An upstream install can use the same instance label. A background auto-start must never
    // replace its executable; only the explicit Set up Paperclip action may install this fork.
    // Without a serviceName the label cannot be tied to this registration, so it is not trusted.
    if (status.installed && typeof status.serviceName !== 'string') { status.installed = false; status.active = false; }
    if (status.installed) {
      const name = registration.instanceId === 'default' ? 'ing.paperclip.paperclipai' : `ing.paperclip.paperclipai.${registration.instanceId}`;
      const definition = path.join(env.HOME, 'Library/LaunchAgents', `${name}.plist`);
      let executable = null;
      try {
        const content = (options.readFile || (file => fs.readFileSync(file, 'utf8')))(definition);
        const match = content.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/);
        executable = match?.[1].replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]);
      } catch { /* A missing or unreadable definition is not this registered service. */ }
      if (executable !== registration.shim) { status.installed = false; status.active = false; }
    }
    if (type === 'paperclip.status') return { ok: true, paperclip: { service: !status.installed ? 'not_installed' : status.active ? 'running' : 'stopped' } };
    // Paperclip's start() can install a missing launchd definition. Automatic starts must not.
    if (!status.installed) return { ok: false, error: 'paperclip_not_registered' };
    if (!status.active) await invoke('start');
    return { ok: true, started: true };
  } catch { return { ok: false, error: 'paperclip_start_failed' }; }
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
      if (n < 2 || n > MAX_FRAME_BYTES) { dead = true; buffer = Buffer.alloc(0); onError(Error('Native message exceeds the allowed size.')); return; }
      if (buffer.length < 4 + n) return;
      const body = buffer.subarray(4, 4 + n); buffer = buffer.subarray(4 + n);
      try { onMessage(JSON.parse(body.toString('utf8'))); } catch { onError(Error('Invalid native JSON message.')); }
    }
  }, end() { if (buffer.length && !dead) onError(Error('Incomplete native message.')); } };
}
module.exports = { HOST, VERSION, ALLOWED_HOSTS, BROWSERS, SUPPORT, EXTENSION_ID, BACKUP_NAME, BACKUP_KEEP, BACKUP_CHUNK_BYTES, MAX_FRAME_BYTES, aiUrl, extensionIdFromKey, profileDir, launchPlan, backupDir, listBackups, backupsToPrune, createBackupSession, handle, frame, createDecoder };
