import { DurableObject } from 'cloudflare:workers';
import {
  ClefEvaluateRequestSchema,
  ContextualEmbeddingRequestSchema,
  EnrichThreadRequestSchema,
  HandoffRequestSchema,
  OrganizePreviewRequestSchema,
  RerankRequestSchema,
  StandardEmbeddingRequestSchema,
} from '../../shared/cloud';
import type { Env } from '../worker-configuration';
import { evaluateWithClef } from './clef';
import {
  runBoundedHandoff,
  runOrganizePreview,
  runThreadEnrichmentWithRepair,
} from './deepseek';
import {
  createContextualEmbeddings,
  createStandardEmbeddings,
  rerankDocuments,
} from './voyage';

const MAX_PAYLOAD_BYTES = 262_144;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function authenticateRequest(
  request: Request,
  env: Env
): Promise<{ ok: true; userId: string } | { ok: false; status: number; error: string }> {
  if (!env.AUTH_TOKEN_HASHES_JSON) {
    return {
      ok: false,
      status: 503,
      error: 'Worker authentication is not configured (AUTH_TOKEN_HASHES_JSON missing).',
    };
  }

  let tokenMap: Record<string, string>;
  try {
    tokenMap = JSON.parse(env.AUTH_TOKEN_HASHES_JSON) as Record<string, string>;
  } catch {
    return {
      ok: false,
      status: 500,
      error: 'Invalid AUTH_TOKEN_HASHES_JSON configuration.',
    };
  }

  const authHeader = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
  if (!match || !match[1]) {
    return {
      ok: false,
      status: 401,
      error: 'Missing or malformed Authorization Bearer token.',
    };
  }

  const tokenHash = await sha256Hex(match[1]);
  if (tokenHash === EMPTY_SHA256) {
    return { ok: false, status: 401, error: 'Empty token hash rejected.' };
  }

  let matchedUserId: string | undefined;
  for (const [configuredHash, configuredUser] of Object.entries(tokenMap)) {
    const a = configuredHash.toLowerCase();
    const b = tokenHash.toLowerCase();
    if (a.length === b.length) {
      let diff = 0;
      for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
      }
      if (diff === 0) {
        matchedUserId = configuredUser;
      }
    }
  }
  const userId = matchedUserId;
  if (!userId || userId.startsWith('disabled_')) {
    return {
      ok: false,
      status: 403,
      error: 'Unauthorized client credential.',
    };
  }

  return { ok: true, userId };
}

export function validateOriginHeader(
  request: Request,
  env: Env
): { ok: true; allowOrigin: string | null } | { ok: false; status: number; error: string } {
  const origin = request.headers.get('Origin');
  if (!origin) {
    return { ok: true, allowOrigin: null };
  }

  const allowedList = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowedList.length > 0) {
    if (!allowedList.includes(origin)) {
      return {
        ok: false,
        status: 403,
        error: 'Request Origin is not in ALLOWED_ORIGINS.',
      };
    }
    return { ok: true, allowOrigin: origin };
  }

  if (origin.startsWith('chrome-extension://') || origin.startsWith('https://')) {
    return { ok: true, allowOrigin: origin };
  }

  return {
    ok: false,
    status: 403,
    error: 'Insecure or disallowed Origin header.',
  };
}

export interface QuotaState {
  dayKey: string;
  requestsUsed: number;
  tokensUsed: number;
}

export class UsageQuotaDO extends DurableObject<Env> {
  private currentDayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const dayKey = this.currentDayKey();
    const maxRequests = Number(this.env?.MAX_DAILY_REQUESTS_PER_USER ?? '100') || 100;
    const maxTokens = Number(this.env?.MAX_DAILY_TOKENS_PER_USER ?? '120000') || 120000;

    let parsedBody: { estimatedTokens?: number; deltaTokens?: number } = {};
    if (url.pathname === '/reserve' || url.pathname === '/record-tokens') {
      try {
        parsedBody = (await request.json()) as {
          estimatedTokens?: number;
          deltaTokens?: number;
        };
      } catch {
        parsedBody = {};
      }
    }

    const executeAtomic = async (): Promise<Response> => {
      if (!this.ctx?.storage?.get || !this.ctx?.storage?.put) {
        return Response.json(
          {
            allowed: false,
            reason: 'Durable Object storage is required for UsageQuotaDO.',
          },
          { status: 503 }
        );
      }

      let current = await this.ctx.storage.get<QuotaState>('quota');

      if (!current || current.dayKey !== dayKey) {
        current = { dayKey, requestsUsed: 0, tokensUsed: 0 };
      }

      if (url.pathname === '/reserve') {
        const estimatedTokens = Math.max(0, Number(parsedBody.estimatedTokens ?? 0));
        if (current.requestsUsed + 1 > maxRequests) {
          return Response.json(
            {
              allowed: false,
              reason: `Daily request quota exhausted (${current.requestsUsed}/${maxRequests}).`,
              state: current,
            },
            { status: 429 }
          );
        }
        if (current.tokensUsed + estimatedTokens > maxTokens) {
          return Response.json(
            {
              allowed: false,
              reason: `Daily token quota exhausted (${current.tokensUsed}/${maxTokens}).`,
              state: current,
            },
            { status: 429 }
          );
        }
        current.requestsUsed += 1;
        current.tokensUsed += estimatedTokens;
        await this.ctx.storage.put('quota', current);
        return Response.json({ allowed: true, state: current });
      }

      if (url.pathname === '/record-tokens') {
        const deltaTokens = Number(parsedBody.deltaTokens ?? 0);
        current.tokensUsed = Math.max(0, current.tokensUsed + deltaTokens);
        await this.ctx.storage.put('quota', current);
        return Response.json({ ok: true, state: current });
      }

      return Response.json({ state: current, maxRequests, maxTokens });
    };

    if (this.ctx?.blockConcurrencyWhile) {
      return this.ctx.blockConcurrencyWhile(executeAtomic);
    }
    return executeAtomic();
  }
}

async function checkAndReserveQuota(
  env: Env,
  userId: string,
  estimatedTokens: number
): Promise<
  | { allowed: true; state: QuotaState }
  | { allowed: false; status: 429 | 503; code: string; reason: string }
> {
  if (!env.USAGE_QUOTA) {
    return {
      allowed: false,
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      reason: 'Durable Object USAGE_QUOTA binding is required.',
    };
  }

  const id = env.USAGE_QUOTA.idFromName(userId);
  const stub = env.USAGE_QUOTA.get(id);
  const res = await stub.fetch('https://quota.internal/reserve', {
    method: 'POST',
    body: JSON.stringify({ estimatedTokens }),
  });
  const data = (await res.json()) as { allowed: boolean; reason?: string; state: QuotaState };
  if (!res.ok || !data.allowed) {
    const status = res.status === 503 ? 503 : 429;
    return {
      allowed: false,
      status,
      code: status === 503 ? 'SERVICE_UNAVAILABLE' : 'QUOTA_EXHAUSTED',
      reason: data.reason ?? 'Quota exceeded.',
    };
  }
  return { allowed: true, state: data.state };
}

async function adjustRecordedTokens(
  env: Env,
  userId: string,
  deltaTokens: number
): Promise<void> {
  if (deltaTokens === 0 || !env.USAGE_QUOTA) return;
  const id = env.USAGE_QUOTA.idFromName(userId);
  const stub = env.USAGE_QUOTA.get(id);
  await stub.fetch('https://quota.internal/record-tokens', {
    method: 'POST',
    body: JSON.stringify({ deltaTokens }),
  });
}

export function resetLocalFallbackQuotasForTest(): void {
  // No-op: isolate-local quota fallback has been removed; UsageQuotaDO is unconditionally required.
}

function jsonResponse(
  body: unknown,
  status = 200,
  allowOrigin: string | null = null
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (allowOrigin) {
    headers['Access-Control-Allow-Origin'] = allowOrigin;
    headers['Vary'] = 'Origin';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export async function handleWorkerRequest(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const originCheck = validateOriginHeader(request, env);
  if (!originCheck.ok) {
    return jsonResponse({ error: originCheck.error }, originCheck.status);
  }

  if (request.method === 'OPTIONS') {
    const headers: Record<string, string> = {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
    };
    if (originCheck.allowOrigin) {
      headers['Access-Control-Allow-Origin'] = originCheck.allowOrigin;
    }
    return new Response(null, { status: 204, headers });
  }

  const auth = await authenticateRequest(request, env);
  if (!auth.ok) {
    return jsonResponse({ error: auth.error }, auth.status, originCheck.allowOrigin);
  }

  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/v1/health') {
    return jsonResponse(
      {
        ok: true,
        userId: auth.userId,
        capabilities: {
          deepseekConfigured: Boolean(
            (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_AI_API_TOKEN) || env.AI
          ),
          clefEnabled: env.ENABLE_CLEF === 'true',
          voyageConfigured: Boolean(env.MONGODB_MODEL_API_KEY),
          geography: env.MONGODB_AI_GEOGRAPHY ?? 'unscoped',
        },
      },
      200,
      originCheck.allowOrigin
    );
  }

  if (request.method !== 'POST') {
    return jsonResponse(
      { error: 'Method not allowed.' },
      405,
      originCheck.allowOrigin
    );
  }

  const rawText = await request.text();
  if (new TextEncoder().encode(rawText).byteLength > MAX_PAYLOAD_BYTES) {
    return jsonResponse(
      { error: `Payload exceeds maximum size of ${MAX_PAYLOAD_BYTES} bytes.` },
      413,
      originCheck.allowOrigin
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawText);
  } catch {
    return jsonResponse(
      { error: 'Request body must be valid JSON.' },
      400,
      originCheck.allowOrigin
    );
  }

  const estimatedTokens = Math.max(64, Math.ceil(rawText.length / 4));

  const reserveOrReject = async (): Promise<Response | null> => {
    const reservation = await checkAndReserveQuota(env, auth.userId, estimatedTokens);
    if (!reservation.allowed) {
      return jsonResponse(
        { error: reservation.reason, code: reservation.code },
        reservation.status,
        originCheck.allowOrigin
      );
    }
    return null;
  };

  try {
    switch (url.pathname) {
      case '/v1/enrich':
      case '/v1/enrich-thread': {
        const validated = EnrichThreadRequestSchema.safeParse(parsedBody);
        if (!validated.success) {
          return jsonResponse(
            { error: 'Invalid enrich request schema.', details: validated.error.issues },
            400,
            originCheck.allowOrigin
          );
        }
        if (
          validated.data.coverage === 'title_only' ||
          validated.data.coverage === 'metadata_only'
        ) {
          return jsonResponse(
            {
              error: `Refusing to summarize ${validated.data.coverage} record without captured messages.`,
              code: 'INSUFFICIENT_COVERAGE',
            },
            422,
            originCheck.allowOrigin
          );
        }
        const quotaErr = await reserveOrReject();
        if (quotaErr) return quotaErr;

        const out = await runThreadEnrichmentWithRepair(env, validated.data, fetchImpl);
        await adjustRecordedTokens(
          env,
          auth.userId,
          out.usage.totalTokens - estimatedTokens
        );
        return jsonResponse(out, 200, originCheck.allowOrigin);
      }

      case '/v1/organize-preview': {
        const validated = OrganizePreviewRequestSchema.safeParse(parsedBody);
        if (!validated.success) {
          return jsonResponse(
            { error: 'Invalid organize-preview schema.', details: validated.error.issues },
            400,
            originCheck.allowOrigin
          );
        }
        const quotaErr = await reserveOrReject();
        if (quotaErr) return quotaErr;

        const out = await runOrganizePreview(env, validated.data, fetchImpl);
        await adjustRecordedTokens(
          env,
          auth.userId,
          out.usage.totalTokens - estimatedTokens
        );
        return jsonResponse(out, 200, originCheck.allowOrigin);
      }

      case '/v1/handoff': {
        const validated = HandoffRequestSchema.safeParse(parsedBody);
        if (!validated.success) {
          return jsonResponse(
            { error: 'Invalid handoff request schema.', details: validated.error.issues },
            400,
            originCheck.allowOrigin
          );
        }
        const quotaErr = await reserveOrReject();
        if (quotaErr) return quotaErr;

        const out = await runBoundedHandoff(env, validated.data, fetchImpl);
        await adjustRecordedTokens(
          env,
          auth.userId,
          out.usage.totalTokens - estimatedTokens
        );
        return jsonResponse(out, 200, originCheck.allowOrigin);
      }

      case '/v1/clef/evaluate':
      case '/v1/clef-evaluate': {
        if (env.ENABLE_CLEF !== 'true') {
          return jsonResponse(
            { error: 'Clef routing/scoring (@cf/cloudflare/clef) is disabled on this Worker.' },
            403,
            originCheck.allowOrigin
          );
        }
        const validated = ClefEvaluateRequestSchema.safeParse(parsedBody);
        if (!validated.success) {
          return jsonResponse(
            { error: 'Invalid Clef request schema.', details: validated.error.issues },
            400,
            originCheck.allowOrigin
          );
        }
        const quotaErr = await reserveOrReject();
        if (quotaErr) return quotaErr;

        const out = await evaluateWithClef(env, validated.data, fetchImpl);
        const used = out.usage.inputTokens + out.usage.outputTokens;
        await adjustRecordedTokens(env, auth.userId, used - estimatedTokens);
        return jsonResponse(out, 200, originCheck.allowOrigin);
      }

      case '/v1/embeddings':
      case '/v1/embeddings/standard': {
        const validated = StandardEmbeddingRequestSchema.safeParse(parsedBody);
        if (!validated.success) {
          return jsonResponse(
            { error: 'Invalid standard embedding schema.', details: validated.error.issues },
            400,
            originCheck.allowOrigin
          );
        }
        const quotaErr = await reserveOrReject();
        if (quotaErr) return quotaErr;

        const out = await createStandardEmbeddings(env, validated.data, fetchImpl);
        await adjustRecordedTokens(
          env,
          auth.userId,
          out.usage.totalTokens - estimatedTokens
        );
        return jsonResponse(out, 200, originCheck.allowOrigin);
      }

      case '/v1/contextual-embeddings':
      case '/v1/embeddings/contextual': {
        const validated = ContextualEmbeddingRequestSchema.safeParse(parsedBody);
        if (!validated.success) {
          return jsonResponse(
            { error: 'Invalid contextual embedding schema.', details: validated.error.issues },
            400,
            originCheck.allowOrigin
          );
        }
        const quotaErr = await reserveOrReject();
        if (quotaErr) return quotaErr;

        const out = await createContextualEmbeddings(env, validated.data, fetchImpl);
        await adjustRecordedTokens(
          env,
          auth.userId,
          out.usage.totalTokens - estimatedTokens
        );
        return jsonResponse(out, 200, originCheck.allowOrigin);
      }

      case '/v1/rerank': {
        const validated = RerankRequestSchema.safeParse(parsedBody);
        if (!validated.success) {
          return jsonResponse(
            { error: 'Invalid rerank request schema.', details: validated.error.issues },
            400,
            originCheck.allowOrigin
          );
        }
        const quotaErr = await reserveOrReject();
        if (quotaErr) return quotaErr;

        const out = await rerankDocuments(env, validated.data, fetchImpl);
        await adjustRecordedTokens(
          env,
          auth.userId,
          out.usage.totalTokens - estimatedTokens
        );
        return jsonResponse(out, 200, originCheck.allowOrigin);
      }

      default:
        return jsonResponse(
          {
            error: `Endpoint "${url.pathname}" is not in the ThreadStack Worker allowlist. Generic AI proxy routes are forbidden.`,
          },
          404,
          originCheck.allowOrigin
        );
    }
  } catch (err) {
    return jsonResponse(
      { error: (err as Error).message || 'Upstream inference failed.' },
      502,
      originCheck.allowOrigin
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleWorkerRequest(request, env);
  },
};
