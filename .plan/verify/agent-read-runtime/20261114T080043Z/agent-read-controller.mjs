import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const metadata = JSON.parse(await fs.readFile('/tmp/threadkeeper-acceptance-runtime.json', 'utf8'));
const holdPath = '/tmp/threadkeeper-read-tool-hold.json';
const hold = JSON.parse(await fs.readFile(holdPath, 'utf8'));
assert.equal(hold.phase, 'ready', 'Held UI profile is not ready');
assert.equal(hold.origin, metadata.origin);
assert.equal(hold.companyId, metadata.companyId);
const nonce = crypto.randomUUID().slice(0, 8);
const directory = path.join(metadata.root, 'agent-read-probe-' + nonce);
await fs.mkdir(directory, { recursive: true });
const workerReceipt = path.join(directory, 'worker-result.json');
const receiptPath = path.join(directory, 'controller-result.json');
const receipt = { startedAt: new Date().toISOString(), status: 'running', companyId: metadata.companyId,
  source: 'documented process adapter + normal heartbeat + run-scoped HTTP gateway', directory, cleanup: [] };
const save = () => fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
async function api(route, method = 'GET', body) {
  const response = await fetch(metadata.origin + '/api' + route, { method,
    headers: { 'Content-Type': 'application/json', Origin: metadata.origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(35_000) });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} ${route}: ${typeof data.error === 'string' ? data.error : data.error?.message ?? 'request rejected'}`);
    error.code = data.code ?? data.details?.code; throw error;
  }
  return data;
}
let terminal = false;
try {
  const bridge = await api('/plugins/browser-sessions/api/status?companyId=' + metadata.companyId);
  assert(bridge.connected && bridge.shared && bridge.sessionCount > 0, 'Actual held extension bridge is not connected/shared/populated');
  const agent = await api('/companies/' + metadata.companyId + '/agents', 'POST', {
    name: 'Owned read-gateway proof ' + nonce, role: 'engineer', adapterType: 'process',
    adapterConfig: { command: process.execPath, args: [path.join(metadata.root, 'agent-read-worker.mjs')], cwd: directory,
      timeoutSec: 120, env: { TK_AGENT_READ_RECEIPT: workerReceipt } },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } }, budgetMonthlyCents: 100,
  });
  receipt.agentId = agent.id; await save();
  const issue = await api('/companies/' + metadata.companyId + '/issues', 'POST', {
    title: 'Owned browser-session read proof ' + nonce, status: 'backlog', assigneeAgentId: agent.id,
    description: 'Synthetic Node process only: inspect the real registered tool catalog and read shared test sessions through the normal gateway. No LLM, provider credentials or browser actions.',
  });
  receipt.issueId = issue.id; await save();
  const run = await api('/agents/' + agent.id + '/heartbeat/invoke', 'POST', {
    reason: 'synthetic_browser_sessions_read_proof', payload: { issueId: issue.id }, idempotencyKey: 'read-proof-' + nonce,
  });
  assert(run.id, 'Normal heartbeat was skipped or did not return a run');
  receipt.runId = run.id; await save();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const state = await api('/heartbeat-runs/' + run.id);
    receipt.runStatus = state.status;
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(state.status)) {
      terminal = true; receipt.runErrorCode = state.errorCode ?? null; receipt.runError = state.error ?? null; break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(terminal, 'Routine synthetic process did not finish within bounded probe');
  const result = JSON.parse(await fs.readFile(workerReceipt, 'utf8'));
  receipt.workerReceipt = workerReceipt; receipt.workerStatus = result.status;
  assert.equal(receipt.runStatus, 'succeeded', 'Actual process run did not succeed');
  assert.equal(result.status, 'passed', result.error ?? 'Agent read proof failed');
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed'; receipt.error = error.message;
} finally {
  if (receipt.runId && !terminal) {
    try { await api('/heartbeat-runs/' + receipt.runId + '/cancel', 'POST', {}); receipt.cleanup.push('normal-owned-run-cancel'); }
    catch (error) { receipt.cleanup.push('run-cancel-failed:' + error.message); }
  }
  if (receipt.issueId) {
    try { await api('/issues/' + receipt.issueId, 'DELETE'); receipt.cleanup.push('owned-task-deleted'); }
    catch (error) { receipt.cleanup.push('task-delete-failed:' + error.message); }
  }
  if (receipt.agentId) {
    try {
      await api('/agents/' + receipt.agentId + '/terminate', 'POST', {});
      receipt.cleanup.push('owned-agent-terminated');
      for (let attempt = 0; attempt < 40; attempt++) {
        const agent = await api('/agents/' + receipt.agentId);
        if (['terminated', 'rejected'].includes(agent.lifecycleState)) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      await api('/agents/' + receipt.agentId, 'DELETE'); receipt.cleanup.push('owned-agent-deleted');
    }
    catch (error) {
      receipt.cleanup.push(error.code === 'agent_cost_history_retained' ? 'terminated-agent-audit-history-retained-by-policy' : 'agent-delete-failed:' + error.message);
    }
  }
  receipt.finishedAt = new Date().toISOString(); await save();
  await fs.writeFile('/tmp/threadkeeper-agent-read-probe-result.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  await fs.writeFile(holdPath, JSON.stringify({ phase: 'done', at: new Date().toISOString(), result: receipt.status }) + '\n');
  console.log(JSON.stringify(receipt));
  if (receipt.status !== 'passed') process.exitCode = 1;
}
