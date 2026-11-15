import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = '/Users/andrew/dev/threadkeeper/paperclip';
const driver = path.join(root, 'extension/scripts/run-paperclip-e2e.mjs');
const source = fs.readFileSync(driver, 'utf8');
const anchor = '  if (process.env.TK_PAPERCLIP_READ_HOLD) {';
assert.equal(source.split(anchor).length - 1, 1);
const start = source.indexOf(anchor);
const end = source.indexOf('\n  }\n', start) + '\n  }\n'.length;
const block = source.slice(start, end);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
assert.equal(block.trimEnd().split('\n').length, 9);
assert.equal(hash(source), '408bff8a995af3b3248fe0b637b092d3501f829d36ad8b9cfa1107554d0a7039');
assert.equal(hash(source.slice(0, start) + source.slice(end)), '525689347e1863abbf62e019ecc33a71da720d7b1abaf9db10958e50c2010b5e');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction('process', 'path', 'cases', 'fs', 'origin', 'fixture', 'extensionId', 'record', 'until', 'cleanup', `try {\n${block}\n} finally { cleanup(); }`);
const results = [];
for (const scenario of ['unset', 'unpaired', 'done', 'timeout']) {
  let cleaned = false;
  const writes = []; const events = []; const waits = [];
  const fileSystem = { writeFileSync: (name, body) => writes.push({ name, body: JSON.parse(body) }), readFileSync: () => JSON.stringify({ phase: 'done' }) };
  const until = async (read, accept, timeout) => { waits.push(timeout); if (scenario === 'timeout') throw new Error('synthetic timeout'); const value = await read(); assert.equal(accept(value), true); return value; };
  let error;
  try { await run({ env: scenario === 'unset' ? {} : { TK_PAPERCLIP_READ_HOLD: '/tmp/owned-read-hold-fixture.json' } }, path, scenario === 'unpaired' ? [] : [{ id: 'pc-session-ui', status: 'pass' }], fileSystem, 'http://127.0.0.1:3217', { companyId: 'synthetic-company' }, 'a'.repeat(32), (...args) => events.push(args), until, () => { cleaned = true; }); }
  catch (cause) { error = cause; }
  assert.equal(cleaned, true);
  if (scenario === 'unset') { assert.equal(error, undefined); assert.deepEqual(writes, []); assert.deepEqual(waits, []); }
  else if (scenario === 'unpaired') { assert.match(error.message, /successful explicit UI pairing/); assert.deepEqual(writes, []); assert.deepEqual(waits, []); }
  else {
    assert.equal(writes.length, 1); assert.deepEqual(Object.keys(writes[0].body), ['phase', 'at', 'origin', 'companyId', 'extensionId']); assert.equal(writes[0].body.phase, 'ready'); assert.deepEqual(waits, [300_000]);
    if (scenario === 'timeout') { assert.match(error.message, /synthetic timeout/); assert.deepEqual(events.map(event => event[1].phase), ['ready']); }
    else { assert.equal(error, undefined); assert.deepEqual(events.map(event => event[1].phase), ['ready', 'done']); }
  }
  results.push({ scenario, passed: true, cleanupReached: cleaned, writes: writes.length, waitTimeoutMs: waits[0] ?? null });
}
console.log(JSON.stringify({ extractedLines: 9, currentSha256: hash(source), reconstructedReviewedSha256: hash(source.slice(0, start) + source.slice(end)), syntheticOnly: true, results }, null, 2));
