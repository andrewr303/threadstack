import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { aiCredentialsProblem, bedrockInferenceProfileId, resolveModelId } from '../../src/core/ai/backends.js';
import {
  CatchUpBriefSchema,
  OrganizePlanSchema,
  ThreadAnalysisSchema,
  analyzeThreadWithClaude,
  askLibraryWithClaude,
  testClaudeConnection,
} from '../../src/core/ai/claude.js';
import { strictJsonSchema } from '../../src/core/ai/openai-bedrock.js';
import { DEFAULT_AWS_SETTINGS } from '../../src/core/aws.js';
import { analysisModelLabel } from '../../src/core/summary-markdown.js';
import { normalizeSettings, type SettingsRecord } from '../../src/core/schema.js';

type Call = { url: string; headers: Record<string, string>; body: any };

function settings(patch: Partial<SettingsRecord>): SettingsRecord {
  return { ...normalizeSettings({}), ...patch } as SettingsRecord;
}

function recordingFetch(calls: Call[], respond: (call: Call) => Response) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const text = await req.text();
    const call = { url: req.url, headers, body: text ? JSON.parse(text) : null };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
}

const INPUT = {
  title: 'Webhook dedupe',
  providerLabel: 'ChatGPT',
  providerProjectName: null,
  workspacePath: null,
  updatedAt: null,
  messages: [{ ordinal: 0, role: 'user', content: 'Customers were charged twice.' }],
  projects: [],
  knownTags: [],
};

describe('Bedrock inference profiles', () => {
  it('uses the geographic profile when Bedrock offers one, else global', () => {
    expect(bedrockInferenceProfileId('us-east-1', 'claude-haiku-5-5')).toBe('us.anthropic.claude-haiku-5-5');
    expect(bedrockInferenceProfileId('ca-central-1', 'claude-opus-5-5')).toBe('us.anthropic.claude-opus-5-5');
    expect(bedrockInferenceProfileId('eu-west-1', 'claude-sonnet-5-5')).toBe('eu.anthropic.claude-sonnet-5-5');
    expect(bedrockInferenceProfileId('eu-west-1', 'claude-fable-5-1')).toBe('global.anthropic.claude-fable-5-1');
    expect(bedrockInferenceProfileId('ap-northeast-1', 'claude-sonnet-5-5')).toBe('global.anthropic.claude-sonnet-5-5');
    expect(bedrockInferenceProfileId('ap-south-1', 'claude-haiku-5-5')).toBe('global.anthropic.claude-haiku-5-5');
    expect(bedrockInferenceProfileId('us-west-2', 'gpt-6.1-sol')).toBe('us.openai.gpt-6.1-sol');
    expect(bedrockInferenceProfileId('eu-central-1', 'gpt-6.1-terra')).toBe('global.openai.gpt-6.1-terra');
  });

  it('labels profile ids', () => {
    expect(analysisModelLabel('us.anthropic.claude-haiku-5-5')).toBe('Claude Haiku 5.5');
    expect(analysisModelLabel('global.openai.gpt-6.1-terra')).toBe('GPT-6.1 Terra');
  });
});

describe('GPT-6.1 on Amazon Bedrock', () => {
  it('requires the Bedrock backend', () => {
    expect(aiCredentialsProblem(settings({ aiModel: 'gpt-6.1-sol', anthropicApiKey: 'sk' }))).toMatch(/only available through Amazon Bedrock/);
  });

  it('every structured-output schema converts to a strict JSON Schema', () => {
    for (const schema of [ThreadAnalysisSchema, OrganizePlanSchema, CatchUpBriefSchema]) {
      const js = strictJsonSchema(z.toJSONSchema(schema, { target: 'draft-7' })) as any;
      expect(js.type).toBe('object');
      expect(js.additionalProperties).toBe(false);
      expect(js.required).toEqual(Object.keys(js.properties));
      expect(JSON.stringify(js)).not.toContain('$schema');
    }
  });

  it('analysis: Chat Completions on bedrock-runtime with a strict json_schema and bearer key', async () => {
    const calls: Call[] = [];
    const s = settings({ aiBackend: 'bedrock', aiModel: 'gpt-6.1-sol', aws: { ...DEFAULT_AWS_SETTINGS, bedrockApiKey: 'bk' } });
    expect(resolveModelId(s)).toBe('us.openai.gpt-6.1-sol');
    // Invalid analysis JSON → no parsed output → retryable output error (proves the parse path runs).
    const fetchImpl = recordingFetch(calls, () =>
      Response.json({
        model: 'us.openai.gpt-6.1-sol',
        choices: [{ finish_reason: 'stop', message: { content: '{"title":"x"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
    );
    await expect(analyzeThreadWithClaude(s, INPUT, fetchImpl)).rejects.toThrow(/no structured analysis/);
    expect(calls[0].url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions');
    expect(calls[0].headers.authorization).toBe('Bearer bk');
    expect(calls[0].body.model).toBe('us.openai.gpt-6.1-sol');
    expect(calls[0].body.reasoning_effort).toBe('medium');
    expect(calls[0].body.response_format.type).toBe('json_schema');
    expect(calls[0].body.response_format.json_schema.strict).toBe(true);
    expect(calls[0].body.messages[0].role).toBe('system');
  });

  it('IAM keys are signed as bedrock; 404 maps to a model-not-available error', async () => {
    const calls: Call[] = [];
    const s = settings({
      aiBackend: 'bedrock',
      aiModel: 'gpt-6.1-terra',
      aws: { ...DEFAULT_AWS_SETTINGS, auth: 'iam', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    });
    const res = await testClaudeConnection(
      s,
      recordingFetch(calls, () => Response.json({ message: 'no such model' }, { status: 404 }))
    );
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Model not available through Amazon Bedrock/);
    expect(calls[0].headers.authorization).toMatch(/Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request/);
    expect(calls[0].body.model).toBe('us.openai.gpt-6.1-terra');
  });

  it('streams Ask answers', async () => {
    const calls: Call[] = [];
    const s = settings({ aiBackend: 'bedrock', aiModel: 'gpt-6.1-terra', aws: { ...DEFAULT_AWS_SETTINGS, bedrockApiKey: 'bk' } });
    const sse = [
      { model: 'us.openai.gpt-6.1-terra', choices: [{ delta: { content: 'Use ' } }] },
      { choices: [{ delta: { content: 'processed_events [T1].' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } },
    ]
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join('') + 'data: [DONE]\n\n';
    const deltas: string[] = [];
    const text = await askLibraryWithClaude(
      s,
      'What did I decide?',
      [],
      (d) => deltas.push(d),
      recordingFetch(calls, () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }))
    );
    expect(text).toBe('Use processed_events [T1].');
    expect(deltas).toEqual(['Use ', 'processed_events [T1].']);
    expect(calls[0].body.stream).toBe(true);
  });
});
