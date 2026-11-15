import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const env = process.env;
const receipt = { startedAt: new Date().toISOString(), status: 'running', steps: [],
  agentId: env.PAPERCLIP_AGENT_ID, companyId: env.PAPERCLIP_COMPANY_ID, runId: env.PAPERCLIP_RUN_ID,
  credentialSource: 'normal process-adapter PAPERCLIP_API_KEY environment; values never captured' };
const output = env.TK_AGENT_READ_RECEIPT;
let gatewaySession;
const headers = { Authorization: `Bearer ${env.PAPERCLIP_API_KEY}`, 'X-Paperclip-Run-Id': env.PAPERCLIP_RUN_ID, 'Content-Type': 'application/json' };
async function api(path, method = 'GET', body, extra = {}) {
  const response = await fetch(`${env.PAPERCLIP_API_URL}/api${path}`, { method, headers: { ...headers, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(35_000) });
  const value = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${typeof value.error === 'string' ? value.error : value.error?.message ?? 'request rejected'}`);
  return value;
}
try {
  for (const key of ['PAPERCLIP_API_URL', 'PAPERCLIP_AGENT_ID', 'PAPERCLIP_COMPANY_ID', 'PAPERCLIP_RUN_ID', 'PAPERCLIP_API_KEY']) assert(env[key], `${key} missing from normal adapter environment`);
  const run = await api(`/heartbeat-runs/${env.PAPERCLIP_RUN_ID}`);
  const issueId = run.contextSnapshot?.issueId ?? run.issueId;
  assert(issueId, 'Normal run has no task binding');
  receipt.issueId = issueId;
  const task = await api(`/issues/${issueId}`);
  if (task.checkoutRunId !== env.PAPERCLIP_RUN_ID) {
    await api(`/issues/${issueId}/checkout`, 'POST', { agentId: env.PAPERCLIP_AGENT_ID, expectedStatuses: ['todo', 'backlog', 'in_progress'] });
  }
  receipt.steps.push({ step: 'normal-task-checkout', passed: true });
  gatewaySession = await api('/tool-gateway/sessions', 'POST', { companyId: env.PAPERCLIP_COMPANY_ID,
    agentId: env.PAPERCLIP_AGENT_ID, runId: env.PAPERCLIP_RUN_ID, issueId, ttlMs: 120_000 });
  const gatewayHeader = { 'x-paperclip-tool-gateway-token': gatewaySession.token };
  const catalog = await api('/tool-gateway/tools', 'GET', undefined, gatewayHeader);
  assert(Array.isArray(catalog), 'Gateway catalog is not an array');
  const names = catalog.filter(tool => tool.name?.startsWith('browser-sessions:')).map(tool => tool.name).sort();
  for (const name of ['sessions_list', 'sessions_search', 'session_get', 'session_read']) assert(names.includes(`browser-sessions:${name}`), `${name} not discoverable through real policy`);
  receipt.steps.push({ step: 'actual-tool-catalog', passed: true, browserSessionTools: names });
  const call = async (name, parameters) => {
    const response = await api('/tool-gateway/tools/call', 'POST', { tool: `browser-sessions:${name}`, parameters, timeoutMs: 30_000 }, gatewayHeader);
    assert.equal(response.status, 'completed', `${name} did not complete through gateway`);
    const routed = response.result;
    const result = routed?.result ?? routed;
    assert(!result?.error, `${name}: ${result?.error}`);
    const data = result?.data ?? result?.structuredContent ?? result;
    assert.equal(data?.untrusted, true, `${name} lost its untrusted-data boundary`);
    return { response, data };
  };
  const listed = await call('sessions_list', { limit: 5, sort: 'recent' });
  const session = listed.data.sessions?.find(session => session.messageCount > 0) ?? listed.data.sessions?.[0];
  assert(session?.threadKey, 'Held browser returned no shared test session');
  receipt.steps.push({ step: 'actual-list', passed: true, count: listed.data.sessions.length, invocationId: listed.response.invocationId });
  const query = String(session.title || 'session').split(/\s+/)[0];
  const searched = await call('sessions_search', { query, quality: 'fast', limit: 3 });
  assert(searched.data.sessions?.length > 0, 'Local search did not find the listed session title');
  receipt.steps.push({ step: 'actual-local-search', passed: true, count: searched.data.sessions.length, invocationId: searched.response.invocationId });
  const got = await call('session_get', { threadKey: session.threadKey });
  const metadata = got.data.session ?? got.data.thread ?? got.data;
  receipt.steps.push({ step: 'actual-session-get', passed: true, invocationId: got.response.invocationId,
    citation: { threadKey: session.threadKey, sourceUrl: metadata.url ?? session.url, title: metadata.title ?? session.title } });
  const read = await call('session_read', { threadKey: session.threadKey, maxMessages: 1 });
  const message = read.data.messages?.[0];
  assert(message?.text && Number.isInteger(message.index), 'Bounded read returned no cited message');
  receipt.steps.push({ step: 'actual-bounded-session-read', passed: true, invocationId: read.response.invocationId,
    citation: { threadKey: session.threadKey, sourceUrl: metadata.url ?? session.url, messageIndex: message.index },
    excerpt: message.text.slice(0, 140), untrusted: true });
  await api(`/issues/${issueId}`, 'PATCH', { status: 'done', comment: 'Synthetic process adapter verified actual browser-session catalog, local search, cited metadata and bounded read through the normal tool gateway. No model/provider actions performed.' });
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed'; receipt.error = error.message; process.exitCode = 1;
} finally {
  if (gatewaySession?.sessionId) {
    try { await api(`/tool-gateway/sessions/${gatewaySession.sessionId}/revoke`, 'POST', { companyId: env.PAPERCLIP_COMPANY_ID }); receipt.gatewayRevoked = true; }
    catch (error) { receipt.gatewayRevokeError = error.message; }
  }
  receipt.finishedAt = new Date().toISOString();
  await fs.writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ kind: 'synthetic-agent-read-probe', status: receipt.status, runId: receipt.runId,
    passedSteps: receipt.steps.filter(step => step.passed).length, error: receipt.error ?? null }));
}
