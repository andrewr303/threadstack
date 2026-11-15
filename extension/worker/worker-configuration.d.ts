export interface Env {
  AUTH_TOKEN_HASHES_JSON?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_AI_API_TOKEN?: string;
  MONGODB_MODEL_API_KEY?: string;
  MONGODB_AI_GEOGRAPHY?: 'unscoped' | 'us' | 'eu';
  ALLOWED_ORIGINS?: string;
  MAX_DAILY_REQUESTS_PER_USER?: string;
  MAX_DAILY_TOKENS_PER_USER?: string;
  ENABLE_CLEF?: string;
  ENVIRONMENT?: string;
  REQUIRE_DURABLE_QUOTA?: string;
  AI?: {
    run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
  };
  USAGE_QUOTA?: DurableObjectNamespace;
}
