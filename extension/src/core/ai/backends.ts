import Anthropic, { betaRefusalFallbackMiddleware } from '@anthropic-ai/sdk';
import {
  awsHostOrigins,
  awsPlatformBaseUrl,
  bedrockRuntimeAnthropicBaseUrl,
  createAwsFetch,
  isValidAwsRegion,
} from '../aws.js';
import type { AiBackend, AiModelId, SettingsRecord } from '../schema.js';
import { awsModelCredentialsReady, credentialPresent } from '../paperclip/credentials.js';

/**
 * One Anthropic SDK client for three ways of reaching Claude:
 *
 * - Anthropic API (api.anthropic.com) with the user's API key.
 * - Claude in Amazon Bedrock, through the Anthropic Messages API on
 *   https://bedrock-runtime.{region}.amazonaws.com/anthropic. A Bedrock API key
 *   is passed as `apiKey`, the documented path for the standard client; IAM
 *   keys are SigV4-signed (service "bedrock") by a custom fetch. Current Claude
 *   models are only served through cross-Region inference profiles there, so
 *   model ids look like `us.anthropic.claude-haiku-5-5` or
 *   `global.anthropic.claude-haiku-5-5` (see bedrockInferenceProfileId). The
 *   bare `anthropic.` id on bedrock-mantle 404s outside GovCloud.
 *   OpenAI models (GPT-6.1 Sol / Terra) go through openai-bedrock.ts instead.
 * - Claude Platform on AWS (Anthropic-operated), https://aws-external-anthropic.{region}.api.aws,
 *   with a short-term API key (Authorization: Bearer) or SigV4 (service
 *   "aws-external-anthropic") and the anthropic-workspace-id header.
 *   Bare model ids, same features as the Anthropic API.
 */

export interface BackendOption {
  id: AiBackend;
  label: string;
  note: string;
}

export const BACKEND_OPTIONS: BackendOption[] = [
  { id: 'anthropic', label: 'Anthropic API', note: 'An API key from console.anthropic.com.' },
  {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    note: 'Claude in Amazon Bedrock with a Bedrock API key or IAM access keys. Billed through AWS.',
  },
  {
    id: 'aws_platform',
    label: 'Claude Platform on AWS',
    note: 'Anthropic-operated, billed through AWS Marketplace. Needs a workspace ID and a short-term API key or IAM keys.',
  },
];

/** Models that run safety classifiers and accept a refusal fallback. */
const FALLBACK_ELIGIBLE = new Set<AiModelId>(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Client-side fallback target on Bedrock (open access to all Bedrock customers). */
const BEDROCK_FALLBACK_BASE = 'claude-opus-4-8';

/** OpenAI models offered through Amazon Bedrock only. */
const OPENAI_MODELS = new Set<AiModelId>(['gpt-6.1-sol', 'gpt-6.1-terra']);

export function isOpenAiModel(model: AiModelId): boolean {
  return OPENAI_MODELS.has(model);
}

/**
 * Geographic cross-Region inference profiles per geography, as listed by
 * ListInferenceProfiles on 2026-11-12. A model missing from a geography falls
 * back to the global profile, which every commercial source region offers.
 */
const GEO_PROFILES: Record<'us' | 'eu' | 'jp' | 'au', ReadonlySet<string>> = {
  us: new Set([
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-fable-5-1',
    'claude-opus-4-8',
    'gpt-6.1-sol',
    'gpt-6.1-terra',
  ]),
  eu: new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-8']),
  jp: new Set(['claude-opus-5-5', 'claude-haiku-5-5', 'claude-opus-4-8']),
  au: new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-8']),
};

function geographyFor(region: string): keyof typeof GEO_PROFILES | null {
  const r = region.trim();
  if (/^(us|ca)-(?!gov)/.test(r)) return 'us';
  if (r.startsWith('eu-')) return 'eu';
  if (r === 'ap-northeast-1' || r === 'ap-northeast-3') return 'jp';
  if (r === 'ap-southeast-2' || r === 'ap-southeast-4') return 'au';
  return null;
}

/**
 * Bedrock inference profile id for a model called from `region`: the
 * geographic profile (keeps data in that geography) when one exists, else the
 * global one. `base` is the bare model name such as "claude-haiku-5-5".
 */
export function bedrockInferenceProfileId(region: string, base: string): string {
  const vendor = base.startsWith('gpt-') ? 'openai' : 'anthropic';
  const geo = geographyFor(region);
  const prefix = geo && GEO_PROFILES[geo].has(base) ? geo : 'global';
  return `${prefix}.${vendor}.${base}`;
}

/** Set when Bedrock rejected the fallback-credit beta header; later clients skip the middleware. */
let bedrockFallbackRejected = false;

export function markBedrockFallbackUnsupported(): void {
  bedrockFallbackRejected = true;
}

export function bedrockFallbackActive(): boolean {
  return !bedrockFallbackRejected;
}

/** Whether createAiClient attaches the client-side refusal fallback for these settings. */
export function bedrockFallbackAttached(settings: SettingsRecord): boolean {
  return settings.aiBackend === 'bedrock' && bedrockFallbackActive() && FALLBACK_ELIGIBLE.has(settings.aiModel);
}

export function backendLabel(settings: SettingsRecord): string {
  switch (settings.aiBackend) {
    case 'bedrock':
      return `Amazon Bedrock (${settings.aws.region})`;
    case 'aws_platform':
      return `Claude Platform on AWS (${settings.aws.region})`;
    default:
      return 'Anthropic API';
  }
}

export function backendHost(settings: SettingsRecord): string {
  switch (settings.aiBackend) {
    case 'bedrock':
      return new URL(bedrockRuntimeAnthropicBaseUrl(settings.aws.region)).host;
    case 'aws_platform':
      return new URL(awsPlatformBaseUrl(settings.aws.region)).host;
    default:
      return 'api.anthropic.com';
  }
}

/** True when the selected backend has everything it needs to make a request. */
export function aiCredentialsReady(settings: SettingsRecord): boolean {
  if (isOpenAiModel(settings.aiModel) && settings.aiBackend !== 'bedrock') return false;
  switch (settings.aiBackend) {
    case 'bedrock':
      return awsModelCredentialsReady(settings);
    case 'aws_platform': {
      const workspace = /^wrkspc_[A-Za-z0-9]+$/.test(settings.awsPlatformWorkspaceId.trim());
      if (!workspace || !isValidAwsRegion(settings.aws.region)) return false;
      return settings.aws.auth === 'api_key'
        ? credentialPresent(settings, 'awsPlatformApiKey')
        : awsModelCredentialsReady(settings);
    }
    default:
      return credentialPresent(settings, 'anthropicApiKey');
  }
}

/** What is missing, in words the Settings page can show. Null when ready. */
export function aiCredentialsProblem(settings: SettingsRecord): string | null {
  if (aiCredentialsReady(settings)) return null;
  if (isOpenAiModel(settings.aiModel) && settings.aiBackend !== 'bedrock') {
    return 'GPT-6.1 models are only available through Amazon Bedrock. Choose Amazon Bedrock or a Claude model.';
  }
  switch (settings.aiBackend) {
    case 'bedrock':
      if (!isValidAwsRegion(settings.aws.region)) return 'Enter an AWS region such as us-east-1.';
      return settings.aws.auth === 'api_key'
        ? 'Add a Bedrock API key.'
        : 'Add an AWS access key ID and secret access key.';
    case 'aws_platform':
      if (!/^wrkspc_[A-Za-z0-9]+$/.test(settings.awsPlatformWorkspaceId.trim())) {
        return 'Add the Claude Platform on AWS workspace ID (starts with wrkspc_).';
      }
      if (!isValidAwsRegion(settings.aws.region)) return 'Enter the workspace region, such as us-west-2.';
      return settings.aws.auth === 'api_key'
        ? 'Add a short-term API key for Claude Platform on AWS.'
        : 'Add an AWS access key ID and secret access key.';
    default:
      return 'Add an Anthropic API key.';
  }
}

/** Host access the selected backend needs (requested at runtime for AWS). */
export function aiHostOrigins(settings: SettingsRecord): string[] {
  switch (settings.aiBackend) {
    case 'bedrock':
      return awsHostOrigins(settings.aws.region, ['runtime']);
    case 'aws_platform':
      return awsHostOrigins(settings.aws.region, ['platform']);
    default:
      return [];
  }
}

/** The model id the selected backend expects. */
export function resolveModelId(settings: SettingsRecord, model: AiModelId = settings.aiModel): string {
  return settings.aiBackend === 'bedrock' ? bedrockInferenceProfileId(settings.aws.region, model) : model;
}

/** Server-side refusal fallback params (Anthropic API and Claude Platform on AWS only). */
export function serverFallbackParams(
  settings: SettingsRecord,
  model: AiModelId = settings.aiModel
): { betas?: string[]; fallbacks?: 'default' } {
  if (settings.aiBackend === 'bedrock' || !FALLBACK_ELIGIBLE.has(model)) return {};
  return { betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' };
}

export interface AiClientOptions {
  fetchImpl?: typeof fetch;
  /** Bedrock only: attach the client-side refusal fallback middleware. */
  withBedrockFallback?: boolean;
}

export function createAiClient(settings: SettingsRecord, options: AiClientOptions = {}): Anthropic {
  const common = {
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
    timeout: 180_000,
  } as const;
  const fetchImpl = options.fetchImpl;

  if (settings.aiBackend === 'bedrock') {
    const baseURL = bedrockRuntimeAnthropicBaseUrl(settings.aws.region);
    const middleware =
      options.withBedrockFallback !== false && bedrockFallbackAttached(settings)
        ? [betaRefusalFallbackMiddleware([{ model: bedrockInferenceProfileId(settings.aws.region, BEDROCK_FALLBACK_BASE) }])]
        : undefined;
    if (settings.aws.auth === 'api_key') {
      return new Anthropic({
        ...common,
        baseURL,
        apiKey: settings.aws.bedrockApiKey.trim(),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        ...(middleware ? { middleware } : {}),
      });
    }
    return new Anthropic({
      ...common,
      baseURL,
      // Placeholder so the SDK does not demand a key; the signing fetch removes it.
      apiKey: 'sigv4',
      fetch: createAwsFetch(settings.aws, { service: 'bedrock', stripHeaders: ['x-api-key'], baseFetch: fetchImpl }),
      ...(middleware ? { middleware } : {}),
    });
  }

  if (settings.aiBackend === 'aws_platform') {
    const baseURL = awsPlatformBaseUrl(settings.aws.region);
    const defaultHeaders = { 'anthropic-workspace-id': settings.awsPlatformWorkspaceId.trim() };
    if (settings.aws.auth === 'api_key') {
      return new Anthropic({
        ...common,
        baseURL,
        apiKey: null,
        authToken: settings.awsPlatformApiKey.trim(),
        defaultHeaders,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
    }
    return new Anthropic({
      ...common,
      baseURL,
      apiKey: 'sigv4',
      defaultHeaders,
      fetch: createAwsFetch(settings.aws, {
        service: 'aws-external-anthropic',
        stripHeaders: ['x-api-key'],
        baseFetch: fetchImpl,
      }),
    });
  }

  return new Anthropic({
    ...common,
    apiKey: settings.anthropicApiKey.trim(),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
