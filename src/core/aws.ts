import { AwsClient } from 'aws4fetch';

/**
 * Amazon Web Services access from extension pages and the service worker.
 *
 * Two credential kinds are supported, both stored in extension IndexedDB:
 * - a Bedrock API key (bearer token; short-term tokens last at most 12 hours),
 * - IAM access keys (optionally with a session token), signed with SigV4 by
 *   aws4fetch (MIT, Michael Hart) because the official @anthropic-ai/bedrock-sdk
 *   and @anthropic-ai/aws-sdk import Node built-ins and do not bundle for a
 *   browser extension.
 *
 * Host access is requested per region at runtime (optional_host_permissions),
 * so the extension holds no AWS host permission until the user configures one.
 */

export type AwsAuthMode = 'api_key' | 'iam';

export interface AwsSettings {
  region: string;
  auth: AwsAuthMode;
  /** Amazon Bedrock API key (bearer token). */
  bedrockApiKey: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional STS session token for temporary credentials. */
  sessionToken: string;
}

export const DEFAULT_AWS_SETTINGS: AwsSettings = {
  region: 'us-east-1',
  auth: 'api_key',
  bedrockApiKey: '',
  accessKeyId: '',
  secretAccessKey: '',
  sessionToken: '',
};

/** SigV4 signing names. bedrock-runtime and bedrock-agent-runtime sign as "bedrock". */
export type AwsSigningService = 'bedrock' | 'bedrock-mantle' | 'aws-external-anthropic';

const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

export function isValidAwsRegion(region: string): boolean {
  return REGION_RE.test(region.trim());
}

export function awsCredentialsReady(aws: AwsSettings): boolean {
  if (!isValidAwsRegion(aws.region)) return false;
  return aws.auth === 'api_key'
    ? aws.bedrockApiKey.trim().length > 0
    : aws.accessKeyId.trim().length > 0 && aws.secretAccessKey.trim().length > 0;
}

export function bedrockRuntimeUrl(region: string, path: string): string {
  return `https://bedrock-runtime.${region.trim()}.amazonaws.com${path}`;
}

export function bedrockAgentRuntimeUrl(region: string, path: string): string {
  return `https://bedrock-agent-runtime.${region.trim()}.amazonaws.com${path}`;
}

/**
 * Claude in Amazon Bedrock through the Anthropic Messages API on bedrock-runtime
 * (append /v1/messages). In commercial regions current Claude models are served
 * here, through cross-Region inference profile IDs, not on bedrock-mantle.
 */
export function bedrockRuntimeAnthropicBaseUrl(region: string): string {
  return bedrockRuntimeUrl(region, '/anthropic');
}

/** OpenAI models in Amazon Bedrock (Chat Completions on bedrock-runtime): append /chat/completions. */
export function bedrockRuntimeOpenAiBaseUrl(region: string): string {
  return bedrockRuntimeUrl(region, '/openai/v1');
}

/** Bedrock Mantle Messages endpoint (no longer used for Claude; kept for host-origin bookkeeping). */
export function bedrockMantleBaseUrl(region: string): string {
  return `https://bedrock-mantle.${region.trim()}.api.aws/anthropic`;
}

/** Claude Platform on AWS (Anthropic-operated): append /v1/messages. */
export function awsPlatformBaseUrl(region: string): string {
  return `https://aws-external-anthropic.${region.trim()}.api.aws`;
}

/** Origins the extension needs for the configured AWS region. */
export function awsHostOrigins(region: string, which: Array<'mantle' | 'runtime' | 'agent' | 'platform'>): string[] {
  const r = region.trim();
  const map = {
    mantle: `https://bedrock-mantle.${r}.api.aws/*`,
    runtime: `https://bedrock-runtime.${r}.amazonaws.com/*`,
    agent: `https://bedrock-agent-runtime.${r}.amazonaws.com/*`,
    platform: `https://aws-external-anthropic.${r}.api.aws/*`,
  } as const;
  return Array.from(new Set(which.map((w) => map[w])));
}

export async function hasHostAccess(origins: string[]): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return true;
  try {
    return await chrome.permissions.contains({ origins });
  } catch {
    return false;
  }
}

/**
 * Ask for host access to the given origins. Must run inside a user gesture
 * (a Save or Test click); returns false if the user declines.
 */
export async function requestHostAccess(origins: string[]): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.permissions?.request) return true;
  if (await hasHostAccess(origins)) return true;
  try {
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

interface NormalizedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string | ArrayBuffer | undefined;
  signal: AbortSignal | undefined;
}

async function bodyBytes(body: RequestInit['body']): Promise<string | ArrayBuffer | undefined> {
  if (body == null) return undefined;
  if (typeof body === 'string' || body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  }
  return new Response(body as BodyInit).arrayBuffer();
}

/**
 * Fetch callers pass either (url, init) or a Request (the Anthropic SDK does
 * the latter when middleware is attached). Fold both into one shape, with
 * init taking precedence as fetch() itself does.
 */
async function normalizeRequest(input: RequestInfo | URL, init: RequestInit | undefined, drop: string[]): Promise<NormalizedRequest> {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const headers = new Headers(isRequest ? (input as Request).headers : undefined);
  new Headers(init?.headers ?? {}).forEach((value, name) => headers.set(name, value));
  for (const name of drop) headers.delete(name);
  let body = await bodyBytes(init?.body);
  if (body === undefined && isRequest && (input as Request).body != null) {
    body = await (input as Request).clone().arrayBuffer();
  }
  return {
    url,
    method: init?.method ?? (isRequest ? (input as Request).method : 'GET'),
    headers,
    body,
    signal: init?.signal ?? (isRequest ? (input as Request).signal : undefined) ?? undefined,
  };
}

export interface AwsFetchOptions {
  service: AwsSigningService;
  /** Where a bearer key goes: Bedrock runtime uses Authorization, Mantle uses x-api-key. */
  bearerHeader?: 'authorization' | 'x-api-key';
  /** Headers set by an SDK that must not reach AWS (e.g. a placeholder x-api-key). */
  stripHeaders?: string[];
  baseFetch?: typeof fetch;
  /** Fixed clock for tests. */
  now?: () => Date;
}

/**
 * A fetch that authenticates every request to AWS with the configured
 * credentials. Abort signals and response streaming pass through unchanged.
 */
export function createAwsFetch(aws: AwsSettings, options: AwsFetchOptions): typeof fetch {
  const baseFetch = options.baseFetch ?? ((input, init) => fetch(input, init));
  const strip = options.stripHeaders ?? [];

  if (aws.auth === 'api_key') {
    const key = aws.bedrockApiKey.trim();
    return async (input, init) => {
      const req = await normalizeRequest(input, init, strip);
      if (options.bearerHeader === 'x-api-key') req.headers.set('x-api-key', key);
      else req.headers.set('authorization', `Bearer ${key}`);
      return baseFetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: req.signal });
    };
  }

  const client = new AwsClient({
    accessKeyId: aws.accessKeyId.trim(),
    secretAccessKey: aws.secretAccessKey.trim(),
    sessionToken: aws.sessionToken.trim() || undefined,
    service: options.service,
    region: aws.region.trim(),
    retries: 0,
  });
  return async (input, init) => {
    const req = await normalizeRequest(input, init, [...strip, 'authorization', 'x-api-key']);
    const datetime = options.now ? options.now().toISOString().replace(/[:-]|\.\d{3}/g, '') : undefined;
    const signed = await client.sign(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      ...(datetime ? { aws: { datetime } } : {}),
    });
    return baseFetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body: req.body,
      signal: req.signal,
    });
  };
}

/** POST JSON to an AWS endpoint and map failures to readable errors. */
export async function awsPostJson(
  awsFetch: typeof fetch,
  url: string,
  body: unknown
): Promise<unknown> {
  const res = await awsFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const data = (await res.json()) as { message?: string; Message?: string };
      detail = data.message ?? data.Message ?? '';
    } catch {
      // non-JSON error body
    }
    throw new AwsRequestError(describeAwsStatus(res.status, new URL(url).hostname, detail), res.status);
  }
  return res.json();
}

export class AwsRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AwsRequestError';
  }
}

export function describeAwsStatus(status: number, host: string, detail: string): string {
  const suffix = detail ? `: ${detail}` : '';
  if (status === 401 || status === 403) {
    return `AWS rejected the credentials for ${host} (HTTP ${status})${suffix}. Check the key, its expiry and the IAM permissions for this model.`;
  }
  if (status === 404) return `${host} has no such model or route in this region (HTTP 404)${suffix}.`;
  if (status === 429) return `Throttled by ${host} (HTTP 429)${suffix}; will retry later.`;
  if (status === 400) return `${host} rejected the request (HTTP 400)${suffix}.`;
  return `${host} returned HTTP ${status}${suffix}.`;
}
