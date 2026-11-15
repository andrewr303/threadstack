import { z } from 'zod';
import { bedrockRuntimeOpenAiBaseUrl, createAwsFetch } from '../aws.js';
import type { SettingsRecord } from '../schema.js';
import { resolveModelId } from './backends.js';

/**
 * OpenAI models (GPT-6.1 Sol / Terra) in Amazon Bedrock, through the
 * OpenAI-compatible Chat Completions API on bedrock-runtime:
 *   POST https://bedrock-runtime.{region}.amazonaws.com/openai/v1/chat/completions
 * with a geographic or global inference profile id (us.openai.gpt-6.1-sol).
 * Auth: a Bedrock API key as a bearer token, or IAM keys SigV4-signed as
 * service "bedrock". Structured output uses response_format json_schema
 * (strict), which needs every property required and additionalProperties false.
 *
 * Results are shaped like the Anthropic SDK's so claude.ts can share its
 * stop-reason and usage handling.
 */

export class OpenAiBedrockError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'OpenAiBedrockError';
  }
}

export interface OpenAiCallParams {
  system: string;
  user: string;
  maxTokens: number;
  effort: SettingsRecord['aiEffort'];
}

export interface OpenAiResult<T> {
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'refusal';
  parsed_output: T | null;
  text: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
}

interface ChatCompletion {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/** Make a JSON Schema acceptable to strict structured outputs. */
export function strictJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictJsonSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === '$schema') continue;
    out[k] = strictJsonSchema(v);
  }
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.required = Object.keys(out.properties as object);
    out.additionalProperties = false;
  }
  return out;
}

const REQUEST_TIMEOUT_MS = 180_000;

function endpoint(settings: SettingsRecord): string {
  return `${bedrockRuntimeOpenAiBaseUrl(settings.aws.region)}/chat/completions`;
}

function body(settings: SettingsRecord, p: OpenAiCallParams, extra: Record<string, unknown>) {
  return {
    model: resolveModelId(settings),
    messages: [
      { role: 'system', content: p.system },
      { role: 'user', content: p.user },
    ],
    max_completion_tokens: p.maxTokens,
    reasoning_effort: p.effort,
    ...extra,
  };
}

async function post(settings: SettingsRecord, payload: unknown, fetchImpl?: typeof fetch): Promise<Response> {
  const awsFetch = createAwsFetch(settings.aws, { service: 'bedrock', baseFetch: fetchImpl });
  const res = await awsFetch(endpoint(settings), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    // Same ceiling as the Anthropic SDK client (backends.ts), so a stalled connection cannot hang a run.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const data = (await res.json()) as { message?: string; Message?: string; error?: { message?: string } };
      detail = data.error?.message ?? data.message ?? data.Message ?? '';
    } catch {
      // non-JSON error body
    }
    throw new OpenAiBedrockError(`${res.status} ${detail}`.trim(), res.status);
  }
  return res;
}

function stopReason(finish: string | null | undefined, refusal: string | null | undefined): OpenAiResult<unknown>['stop_reason'] {
  if (refusal) return 'refusal';
  if (finish === 'length') return 'max_tokens';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}

/** One non-streaming call that returns output validated against `schema`. */
export async function openAiParse<T>(
  settings: SettingsRecord,
  p: OpenAiCallParams & { schema: z.ZodType<T>; schemaName: string },
  fetchImpl?: typeof fetch
): Promise<OpenAiResult<T>> {
  const jsonSchema = strictJsonSchema(z.toJSONSchema(p.schema, { target: 'draft-7' }));
  const res = await post(
    settings,
    body(settings, p, {
      response_format: { type: 'json_schema', json_schema: { name: p.schemaName, schema: jsonSchema, strict: true } },
    }),
    fetchImpl
  );
  const data = (await res.json()) as ChatCompletion;
  const choice = data.choices?.[0];
  const text = choice?.message?.content ?? '';
  const stop = stopReason(choice?.finish_reason, choice?.message?.refusal);
  let parsed: T | null = null;
  if (stop === 'end_turn' && text) {
    try {
      const result = p.schema.safeParse(JSON.parse(text));
      parsed = result.success ? result.data : null;
    } catch {
      parsed = null;
    }
  }
  return {
    model: data.model ?? resolveModelId(settings),
    stop_reason: stop,
    parsed_output: parsed,
    text,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
      // prompt_tokens already includes cached tokens; report 0 here so callers do not double count.
      cache_read_input_tokens: 0,
    },
  };
}

/** Plain-text call, streamed when `onText` is given. */
export async function openAiText(
  settings: SettingsRecord,
  p: OpenAiCallParams,
  onText?: (delta: string) => void,
  fetchImpl?: typeof fetch
): Promise<OpenAiResult<never>> {
  if (!onText) {
    const res = await post(settings, body(settings, p, {}), fetchImpl);
    const data = (await res.json()) as ChatCompletion;
    const choice = data.choices?.[0];
    return {
      model: data.model ?? resolveModelId(settings),
      stop_reason: stopReason(choice?.finish_reason, choice?.message?.refusal),
      parsed_output: null,
      text: choice?.message?.content ?? '',
      usage: {
        input_tokens: data.usage?.prompt_tokens ?? 0,
        output_tokens: data.usage?.completion_tokens ?? 0,
        cache_read_input_tokens: 0,
      },
    };
  }

  const res = await post(settings, body(settings, p, { stream: true, stream_options: { include_usage: true } }), fetchImpl);
  let text = '';
  let model = resolveModelId(settings);
  let finish: string | null = null;
  let refusal = '';
  let usage: ChatCompletion['usage'];
  let streamError = '';
  const handle = (line: string) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let chunk: {
      model?: string;
      choices?: Array<{ delta?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }>;
      usage?: ChatCompletion['usage'];
      error?: { message?: string };
    };
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    if (chunk.error) streamError = chunk.error.message || 'stream error';
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    for (const c of chunk.choices ?? []) {
      if (c.delta?.content) {
        text += c.delta.content;
        onText(c.delta.content);
      }
      if (c.delta?.refusal) refusal += c.delta.refusal;
      if (c.finish_reason) finish = c.finish_reason;
    }
  };
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handle(buffer.slice(0, nl).replace(/\r$/, ''));
        buffer = buffer.slice(nl + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer) handle(buffer.trim());
  }
  if (streamError) throw new OpenAiBedrockError(streamError, 500);
  return {
    model,
    stop_reason: stopReason(finish, refusal),
    parsed_output: null,
    text,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
      cache_read_input_tokens: 0,
    },
  };
}
