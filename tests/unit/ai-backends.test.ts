import { describe, expect, it } from 'vitest';
import {
  aiCredentialsProblem,
  aiCredentialsReady,
  aiHostOrigins,
  markBedrockFallbackUnsupported,
  resolveModelId,
  serverFallbackParams,
} from '../../src/core/ai/backends.js';
import { analyzeThreadWithClaude, askLibraryWithClaude, testClaudeConnection } from '../../src/core/ai/claude.js';
import { DEFAULT_AWS_SETTINGS } from '../../src/core/aws.js';
import { normalizeSettings, type SettingsRecord } from '../../src/core/schema.js';

type Call = { url: string; headers: Record<string, string>; body: any };

const ANALYSIS = {
  title: 'Idempotent Stripe webhook handler',
  gist: 'Chose a processed_events table to dedupe retries.',
  summary: 'Summary.',
  userGoal: null,
  outcome: null,
  kind: 'debugging',
  topics: ['stripe'],
  entities: [],
  project: null,
  status: 'active',
  statusReason: 'In progress',
  whereYouLeftOff: { text: 'Write the replay test.', messageNumber: 1, quote: 'charged twice' },
  decisions: [],
  actionItems: [],
  openQuestions: [],
  artifacts: [],
};

function messagesFetch(calls: Call[], respond?: (call: Call) => Response | null) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    // The SDK passes (url, init) normally and a Request when middleware is attached.
    const req = new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const text = await req.text();
    const call = { url: req.url, headers, body: text ? JSON.parse(text) : null };
    calls.push(call);
    const custom = respond?.(call);
    if (custom) return custom;
    return new Response(
      JSON.stringify({
        id: `msg_${calls.length}`,
        type: 'message',
        role: 'assistant',
        model: call.body?.model,
        content: [{ type: 'text', text: JSON.stringify(ANALYSIS) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;
}

const INPUT = {
  title: 'Stripe',
  providerLabel: 'Claude',
  providerProjectName: null,
  workspacePath: null,
  updatedAt: null,
  messages: [{ ordinal: 0, role: 'user', content: 'Customers get charged twice when Stripe retries.' }],
  projects: [],
  knownTags: [],
};

function settings(patch: Partial<SettingsRecord>): SettingsRecord {
  return normalizeSettings({ ...patch });
}

describe('AI backends', () => {
  it('Anthropic API: api.anthropic.com, bare model id, server-side fallback', async () => {
    const calls: Call[] = [];
    const s = settings({ aiBackend: 'anthropic', anthropicApiKey: 'sk-ant-test' });
    await analyzeThreadWithClaude(s, INPUT, messagesFetch(calls));
    expect(calls[0].url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages(\?beta=true)?$/);
    // SDK 1.x sends API keys as a bearer token.
    expect(calls[0].headers.authorization).toBe('Bearer sk-ant-test');
    expect(calls[0].body.model).toBe('claude-opus-5-5');
    expect(calls[0].body.fallbacks).toBe('default');
    expect(calls[0].headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
  });

  it('Amazon Bedrock with an API key: Mantle endpoint, bearer key, anthropic.-prefixed model, no server-side fallback', async () => {
    const calls: Call[] = [];
    const s = settings({
      aiBackend: 'bedrock',
      aws: { ...DEFAULT_AWS_SETTINGS, region: 'us-west-2', bedrockApiKey: 'bedrock-api-key-xyz' },
    });
    expect(aiHostOrigins(s)).toEqual(['https://bedrock-mantle.us-west-2.api.aws/*']);
    await analyzeThreadWithClaude(s, INPUT, messagesFetch(calls));
    expect(calls[0].url).toMatch(/^https:\/\/bedrock-mantle\.us-west-2\.api\.aws\/anthropic\/v1\/messages(\?beta=true)?$/);
    // Documented path: standard client, Mantle baseURL, Bedrock key as apiKey.
    expect(calls[0].headers.authorization).toBe('Bearer bedrock-api-key-xyz');
    expect(calls[0].headers['anthropic-version']).toBeTruthy();
    expect(calls[0].body.model).toBe('anthropic.claude-opus-5-5');
    expect(calls[0].body.fallbacks).toBeUndefined();
    expect(calls[0].body.output_config.format.type).toBe('json_schema');
  });

  it('Amazon Bedrock with IAM keys: SigV4 for bedrock-mantle, no API key header', async () => {
    const calls: Call[] = [];
    const s = settings({
      aiBackend: 'bedrock',
      aws: { ...DEFAULT_AWS_SETTINGS, auth: 'iam', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    });
    const res = await testClaudeConnection(s, messagesFetch(calls));
    expect(res.ok).toBe(true);
    expect(res.message).toContain('Amazon Bedrock (us-east-1)');
    expect(calls[0].url).toBe('https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages');
    expect(calls[0].headers['x-api-key']).toBeUndefined();
    expect(calls[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock-mantle\/aws4_request/);
  });

  it('Amazon Bedrock with IAM keys keeps headers and body when the SDK passes a Request (fallback middleware)', async () => {
    const calls: Call[] = [];
    const s = settings({
      aiBackend: 'bedrock',
      aws: { ...DEFAULT_AWS_SETTINGS, auth: 'iam', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', region: 'eu-central-1' },
    });
    const result = await analyzeThreadWithClaude(s, INPUT, messagesFetch(calls));
    expect(result.analysis.gist).toBe(ANALYSIS.gist);
    expect(calls[0].headers['anthropic-version']).toBeTruthy();
    expect(calls[0].headers['x-api-key']).toBeUndefined();
    expect(calls[0].headers.authorization).toContain('/eu-central-1/bedrock-mantle/aws4_request');
    expect(calls[0].headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(calls[0].body.model).toBe('anthropic.claude-opus-5-5');
  });

  it('Bedrock: retries without the fallback middleware if Bedrock rejects its beta header', async () => {
    const calls: Call[] = [];
    const s = settings({ aiBackend: 'bedrock', aws: { ...DEFAULT_AWS_SETTINGS, bedrockApiKey: 'k' } });
    const fetchImpl = messagesFetch(calls, (call) =>
      call.headers['anthropic-beta']?.includes('fallback-credit')
        ? new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Unsupported beta header: fallback-credit-2026-07-01' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        : null
    );
    const result = await analyzeThreadWithClaude(s, INPUT, fetchImpl);
    expect(result.analysis.title).toBe(ANALYSIS.title);
    expect(calls).toHaveLength(2);
    expect(calls[0].headers['anthropic-beta']).toContain('fallback-credit-2026-07-01');
    expect(calls[1].headers['anthropic-beta'] ?? '').not.toContain('fallback-credit');
    markBedrockFallbackUnsupported();
  });

  it('Claude Platform on AWS: workspace header, Bearer key, bare model id, server-side fallback', async () => {
    const calls: Call[] = [];
    const s = settings({
      aiBackend: 'aws_platform',
      awsPlatformWorkspaceId: 'wrkspc_01AbCdEf23GhIj',
      awsPlatformApiKey: 'aws-short-term-token',
      aws: { ...DEFAULT_AWS_SETTINGS, region: 'us-west-2' },
    });
    await analyzeThreadWithClaude(s, INPUT, messagesFetch(calls));
    expect(calls[0].url).toMatch(/^https:\/\/aws-external-anthropic\.us-west-2\.api\.aws\/v1\/messages(\?beta=true)?$/);
    expect(calls[0].headers.authorization).toBe('Bearer aws-short-term-token');
    expect(calls[0].headers['anthropic-workspace-id']).toBe('wrkspc_01AbCdEf23GhIj');
    expect(calls[0].headers['x-api-key']).toBeUndefined();
    expect(calls[0].body.model).toBe('claude-opus-5-5');
    expect(calls[0].body.fallbacks).toBe('default');
  });

  it('streams Ask through the selected backend', async () => {
    const calls: Call[] = [];
    const s = settings({ aiBackend: 'bedrock', aws: { ...DEFAULT_AWS_SETTINGS, bedrockApiKey: 'k' } });
    const sse = [
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'anthropic.claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Use processed_events [T1].' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } },
      { type: 'message_stop' },
    ]
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join('');
    const fetchImpl = messagesFetch(calls, () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const text = await askLibraryWithClaude(s, 'What did I decide?', [], undefined, fetchImpl);
    expect(text).toBe('Use processed_events [T1].');
    expect(calls[0].url).toBe('https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages');
    expect(calls[0].body.model).toBe('anthropic.claude-opus-5-5');
  });

  it('reports what is missing per backend and maps model ids', () => {
    expect(aiCredentialsProblem(settings({}))).toBe('Add an Anthropic API key.');
    expect(aiCredentialsProblem(settings({ aiBackend: 'bedrock' }))).toBe('Add a Bedrock API key.');
    expect(aiCredentialsProblem(settings({ aiBackend: 'aws_platform', awsPlatformApiKey: 't' }))).toContain('wrkspc_');
    expect(aiCredentialsReady(settings({ aiBackend: 'bedrock', aws: { ...DEFAULT_AWS_SETTINGS, bedrockApiKey: 'k' } }))).toBe(true);
    expect(resolveModelId(settings({ aiBackend: 'bedrock', aiModel: 'claude-haiku-5-5' }))).toBe('anthropic.claude-haiku-5-5');
    expect(resolveModelId(settings({ aiBackend: 'aws_platform' }))).toBe('claude-opus-5-5');
    expect(serverFallbackParams(settings({ aiModel: 'claude-haiku-5-5' }))).toEqual({});
  });
});
