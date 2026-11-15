import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { parseDocument } from 'yaml';

const callerText = readFileSync(new URL('../.github/workflows/pr.yml', import.meta.url), 'utf8');
const readWorkflow = (name) => {
  const text = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
  const document = parseDocument(text, { uniqueKeys: true });
  assert.deepEqual(document.errors, [], `${name} must be valid YAML`);
  return { text, value: document.toJS() };
};
const caller = parseDocument(callerText).toJS();

function selected(job, repository, action = 'opened', label) {
  assert.equal(typeof job?.if, 'string', 'Every routed job must have an explicit admission condition');
  return vm.runInNewContext(job.if, { github: { repository, event: { action, label: { name: label } } } });
}

test('canonical and fork CI are mutually exclusive and retain supported PR label behavior', () => {
  const canonical = caller.jobs.ci;
  const fork = caller.jobs.threadkeeper;
  assert.equal(canonical.uses, 'paperclipai/paperclip/.github/workflows/pr-trusted.yml@master');
  assert.equal(fork?.uses, './.github/workflows/threadkeeper-pr.yml');
  for (const repository of ['paperclipai/paperclip', 'AVRCORP/threadkeeper', 'someone/other-fork']) {
    for (const [action, label, eventAllowed] of [
      ['opened', undefined, true], ['synchronize', undefined, true], ['reopened', undefined, true],
      ['labeled', 'profile-ci', true], ['labeled', 'full-ci', true], ['labeled', 'unrelated-label', false],
    ]) {
      assert.equal(selected(canonical, repository, action, label), repository === 'paperclipai/paperclip' && eventAllowed);
      assert.equal(selected(fork, repository, action, label), repository === 'AVRCORP/threadkeeper' && eventAllowed);
    }
  }
});

test('the fork workflow executes PR source only on hosted runners with a read-only token', () => {
  const { text, value } = readWorkflow('threadkeeper-pr.yml');
  assert.deepEqual(Object.keys(value.on), ['workflow_call']);
  assert.deepEqual(value.permissions, { contents: 'read' });
  assert.equal(value.concurrency['cancel-in-progress'], true);
  assert.match(value.concurrency.group, /github\.event\.pull_request\.number/);
  assert.doesNotMatch(text, /pull_request_target|secrets\s*:\s*inherit|\$\{\{\s*secrets\.|id-token:\s*write|runs-on\/fleet=/);
  for (const job of Object.values(value.jobs)) {
    assert.equal(job['runs-on'], 'ubuntu-latest');
    assert.match(job.if, /github\.repository == 'AVRCORP\/threadkeeper'/);
    assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 45);
    const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout?.with?.['persist-credentials'], false);
    assert.ok(job.steps.every(step => step['continue-on-error'] !== true));
    for (const step of job.steps.filter(step => step.uses)) assert.match(step.uses, /@[a-f0-9]{40}$/);
  }
});

test('fork checks use frozen separate installations and cover the actual extension and plugin', () => {
  const { text, value } = readWorkflow('threadkeeper-pr.yml');
  assert.doesNotMatch(text, /--no-frozen-lockfile|--resolution-only|deploy:extension|TK_LIVE_DIR|TK_STABLE_ID=1/);
  for (const job of Object.values(value.jobs)) {
    const commands = job.steps.map(step => step.run ?? '').join('\n');
    assert.match(commands, /pnpm install --frozen-lockfile/);
    const pnpm = job.steps.find(step => step.uses?.startsWith('pnpm/action-setup@'));
    assert.equal(pnpm?.with?.version, '9.15.4');
  }
  const extension = value.jobs.extension_plugin.steps.map(step => step.run ?? '').join('\n');
  assert.match(extension, /npm ci --prefix extension/);
  assert.match(extension, /assertThreadkeeperSafety\(\)/);
  assert.match(extension, /npm --prefix extension run typecheck/);
  assert.match(extension, /npm --prefix extension test -- --maxWorkers=2/);
  assert.match(extension, /TK_OUT_DIR=\/tmp\/tk-build TK_STABLE_ID=0 npm --prefix extension run build/);
  assert.match(extension, /assertBuiltManifest/);
  for (const command of ['typecheck', 'test', 'build']) assert.ok(extension.includes(`pnpm --filter @paperclipai/plugin-browser-sessions ${command}`));
  const integration = value.jobs.ui_server.steps.map(step => step.run ?? '').join('\n');
  assert.match(integration, /pnpm --filter @paperclipai\/ui typecheck/);
  assert.match(integration, /pnpm --filter @paperclipai\/server typecheck/);
  assert.match(integration, /pnpm --filter @paperclipai\/ui build/);
  assert.match(integration, /ThreadkeeperSlot\.test\.tsx/);
  assert.match(integration, /company-live-events-stream\.test\.ts/);
  assert.match(integration, /tool-gateway\.test\.ts/);
  assert.match(text, /full Paperclip/);
});
