import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AWS_SETTINGS,
  awsCredentialsReady,
  awsHostOrigins,
  bedrockMantleBaseUrl,
  bedrockRuntimeUrl,
  createAwsFetch,
  describeAwsStatus,
  type AwsSettings,
  type AwsSigningService,
} from '../../src/core/aws.js';

function recorder() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const baseFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, baseFetch };
}

const IAM: AwsSettings = {
  ...DEFAULT_AWS_SETTINGS,
  auth: 'iam',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

describe('createAwsFetch', () => {
  it('matches the AWS SigV4 test suite "get-vanilla" vector', async () => {
    const { calls, baseFetch } = recorder();
    const signed = createAwsFetch(IAM, {
      service: 'service' as AwsSigningService,
      baseFetch,
      now: () => new Date('2015-08-30T12:36:00Z'),
    });
    await signed('https://example.amazonaws.com/', { method: 'GET' });
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get('authorization')).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
    );
    expect(headers.get('x-amz-date')).toBe('20150830T123600Z');
  });

  it('signs Mantle requests as bedrock-mantle and drops the SDK placeholder key', async () => {
    const { calls, baseFetch } = recorder();
    const signed = createAwsFetch(
      { ...IAM, region: 'us-west-2', sessionToken: 'SESSION' },
      { service: 'bedrock-mantle', baseFetch }
    );
    const controller = new AbortController();
    await signed(`${bedrockMantleBaseUrl('us-west-2')}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'sigv4', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'anthropic.claude-opus-5-5', max_tokens: 16, messages: [] }),
      signal: controller.signal,
    });
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('authorization')).toMatch(/Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/bedrock-mantle\/aws4_request/);
    expect(headers.get('x-amz-security-token')).toBe('SESSION');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(calls[0].init.signal).toBe(controller.signal);
    expect(typeof calls[0].init.body).toBe('string');
  });

  it('puts a Bedrock API key in Authorization: Bearer for bedrock-runtime and x-api-key for Mantle', async () => {
    const { calls, baseFetch } = recorder();
    const key: AwsSettings = { ...DEFAULT_AWS_SETTINGS, bedrockApiKey: ' bedrock-api-key-abc ' };
    await createAwsFetch(key, { service: 'bedrock', baseFetch })(bedrockRuntimeUrl('us-east-1', '/model/x/invoke'), {
      method: 'POST',
      body: '{}',
    });
    await createAwsFetch(key, { service: 'bedrock-mantle', bearerHeader: 'x-api-key', baseFetch })(
      `${bedrockMantleBaseUrl('us-east-1')}/v1/messages`,
      { method: 'POST', body: '{}' }
    );
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer bedrock-api-key-abc');
    expect(new Headers(calls[1].init.headers).get('x-api-key')).toBe('bedrock-api-key-abc');
    expect(new Headers(calls[1].init.headers).get('authorization')).toBeNull();
  });
});

describe('AWS settings helpers', () => {
  it('requires a valid region and complete credentials', () => {
    expect(awsCredentialsReady(DEFAULT_AWS_SETTINGS)).toBe(false);
    expect(awsCredentialsReady({ ...DEFAULT_AWS_SETTINGS, bedrockApiKey: 'k' })).toBe(true);
    expect(awsCredentialsReady({ ...DEFAULT_AWS_SETTINGS, bedrockApiKey: 'k', region: 'useast1' })).toBe(false);
    expect(awsCredentialsReady({ ...IAM, secretAccessKey: '' })).toBe(false);
    expect(awsCredentialsReady(IAM)).toBe(true);
  });

  it('builds narrow per-region host patterns', () => {
    expect(awsHostOrigins('eu-central-1', ['mantle', 'runtime', 'runtime'])).toEqual([
      'https://bedrock-mantle.eu-central-1.api.aws/*',
      'https://bedrock-runtime.eu-central-1.amazonaws.com/*',
    ]);
  });

  it('explains auth failures', () => {
    expect(describeAwsStatus(403, 'bedrock-runtime.us-east-1.amazonaws.com', 'expired')).toContain('rejected the credentials');
  });
});
