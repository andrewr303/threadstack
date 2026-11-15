import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const root = '/Users/andrew/dev/threadkeeper/paperclip';
const target = path.join(root, 'extension/src/entrypoints/manager/PaperclipConnection.tsx');
const require = createRequire(target);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const esbuild = require('esbuild');
const before = fs.readFileSync('/tmp/threadkeeper-guidance-supplement-before/extension/src/entrypoints/manager/PaperclipConnection.tsx', 'utf8');
const after = fs.readFileSync(target, 'utf8');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
assert.equal(sha(before), '41ca3e1123dd4b96fdd160ac3c5b64a1387ed45e5cf4ca9c621086d95e75f891');
assert.equal(sha(after), '982956d519009febb6e627aef3637812634467edf5a3382c35cb392baa36563f');
async function component(contents) {
  const result = await esbuild.build({ stdin: { contents, resolveDir: path.dirname(target), sourcefile: target, loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', external: ['react'], write: false, logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  return module.exports.PaperclipStatus;
}
const original = await component(before);
const current = await component(after);
const results = [];
for (const state of ['stopped', 'start_failed']) {
  const connection = { snapshot: { state, origin: 'http://localhost:3100', reason: 'fixture start failed' }, retry() {}, setup() {}, allowAccess() {} };
  const beforeHtml = renderToStaticMarkup(React.createElement(original, { connection }));
  const afterHtml = renderToStaticMarkup(React.createElement(current, { connection }));
  assert.equal(afterHtml, beforeHtml);
  results.push({ state, exactHtmlEqual: true, renderedHtml: afterHtml });
}
console.log(JSON.stringify({ beforeSha256: sha(before), afterSha256: sha(after), noBrowserOrServiceCalls: true, results }, null, 2));
