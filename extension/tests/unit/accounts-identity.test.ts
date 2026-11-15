import { describe, expect, it } from 'vitest';
import {
  IDENTITY_BODY_LIMIT_BYTES,
  matchIdentityRequest,
  parseIdentity,
  parseIdentityBody,
  providerForIdentitySource,
  withinIdentityBodyLimit,
} from '../../src/core/accounts/identity.js';
import { computeDeterministicHash } from '../../src/core/schema.js';

// Fixtures follow the commonly described shapes of these endpoints. They are not captures of
// the live sites (unverified), which is why the parsers are tested as much for what they refuse.

const chatgptSession = {
  user: {
    id: 'user-AbCdEf123456',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    image: 'https://example.com/a.png',
    picture: 'https://example.com/a.png',
    idp: 'auth0',
    iat: 1730000000,
    mfa: false,
    groups: [],
  },
  expires: '2026-12-01T00:00:00.000Z',
  account: { id: 'acc-1', planType: 'plus', structure: 'personal' },
  accessToken: 'eyJ.SECRET.TOKEN',
  authProvider: 'auth0',
};

const claudeAccount = {
  uuid: '6f1c1d2e-0000-4000-8000-000000000001',
  email_address: 'grace@example.com',
  full_name: 'Grace Hopper',
  display_name: 'Grace',
  memberships: [{ organization: { uuid: '9a9a9a9a-0000-4000-8000-000000000009', name: 'Personal' }, role: 'admin' }],
};

const cursorMe = { sub: 'auth0|abc123', email: 'linus@example.com', name: 'Linus', email_verified: true };

describe('matchIdentityRequest', () => {
  it('recognises the identity endpoints', () => {
    expect(matchIdentityRequest('chatgpt.com', 'https://chatgpt.com/api/auth/session')).toBe('chatgpt_session');
    expect(matchIdentityRequest('chatgpt.com', '/api/auth/session?x=1')).toBe('chatgpt_session');
    expect(matchIdentityRequest('chat.openai.com', '/api/auth/session')).toBe('chatgpt_session');
    expect(matchIdentityRequest('claude.ai', '/api/account')).toBe('claude_account');
    expect(matchIdentityRequest('claude.ai', 'https://claude.ai/api/bootstrap')).toBe('claude_account');
    expect(matchIdentityRequest('claude.ai', '/api/bootstrap/9a9a/app_start?statsig_hashing_algorithm=djb2')).toBe('claude_account');
    expect(matchIdentityRequest('cursor.com', '/api/auth/me')).toBe('cursor_me');
  });

  it('ignores other paths, hosts and schemes', () => {
    expect(matchIdentityRequest('chatgpt.com', '/api/auth/session/extra')).toBeNull();
    expect(matchIdentityRequest('chatgpt.com', '/backend-api/me')).toBeNull();
    expect(matchIdentityRequest('claude.ai', '/api/organizations')).toBeNull();
    expect(matchIdentityRequest('claude.ai', '/api/accounts')).toBeNull();
    expect(matchIdentityRequest('evil.test', '/api/auth/session')).toBeNull();
    expect(matchIdentityRequest('chatgpt.com', 'https://evil.test/api/auth/session')).toBeNull();
    expect(matchIdentityRequest('chatgpt.com', 'http://chatgpt.com/api/auth/session')).toBeNull();
    expect(matchIdentityRequest('cursor.com', '/api/auth/me2')).toBeNull();
  });

  it('maps sources to providers', () => {
    expect(providerForIdentitySource('chatgpt_session')).toBe('chatgpt');
    expect(providerForIdentitySource('claude_account')).toBe('claude');
    expect(providerForIdentitySource('cursor_me')).toBe('cursor_agents');
  });
});

describe('parseIdentity', () => {
  it('reads a ChatGPT session and keeps only a hash of the user id', () => {
    const identity = parseIdentity('chatgpt_session', chatgptSession);
    expect(identity).toEqual({
      key: `chatgpt:${computeDeterministicHash('user-AbCdEf123456')}`,
      display: 'ada@example.com',
      detail: 'plus',
      source: 'network',
    });
    const text = JSON.stringify(identity);
    expect(text).not.toContain('user-AbCdEf123456');
    expect(text).not.toContain('SECRET');
  });

  it('reads a Claude account object, bare or inside bootstrap', () => {
    const key = `claude:${computeDeterministicHash(claudeAccount.uuid)}`;
    expect(parseIdentity('claude_account', claudeAccount)).toEqual({ key, display: 'grace@example.com', detail: null, source: 'network' });
    expect(parseIdentity('claude_account', { account: claudeAccount, statsig: {} })?.key).toBe(key);
    expect(parseIdentity('claude_account', { id: 42, email: 'x@example.com' })?.key).toBe(`claude:${computeDeterministicHash('42')}`);
  });

  it('reads a Cursor user', () => {
    expect(parseIdentity('cursor_me', cursorMe)).toEqual({
      key: `cursor:${computeDeterministicHash('auth0|abc123')}`,
      display: 'linus@example.com',
      detail: null,
      source: 'network',
    });
  });

  it('falls back to the name when ChatGPT gives no email', () => {
    expect(parseIdentity('chatgpt_session', { user: { id: 'user-1', name: 'Ada' } })?.display).toBe('Ada');
    expect(parseIdentity('chatgpt_session', { user: { id: 'user-1' } })?.display).toBeNull();
  });

  it('rejects bodies that are not plainly the signed-in account', () => {
    // Signed out.
    expect(parseIdentity('chatgpt_session', {})).toBeNull();
    expect(parseIdentity('chatgpt_session', { user: null })).toBeNull();
    expect(parseIdentity('chatgpt_session', { user: { email: 'ada@example.com' } })).toBeNull();
    expect(parseIdentity('chatgpt_session', { user: { id: '' } })).toBeNull();
    expect(parseIdentity('chatgpt_session', { user: { id: { nested: true } } })).toBeNull();
    // A list of organizations is membership, not a person.
    expect(parseIdentity('claude_account', [claudeAccount.memberships[0].organization])).toBeNull();
    expect(parseIdentity('claude_account', { uuid: '9a9a', name: 'Personal', capabilities: ['chat'] })).toBeNull();
    expect(parseIdentity('claude_account', { account: null })).toBeNull();
    expect(parseIdentity('claude_account', { uuid: 'u-1', email_address: 'not an email' })).toBeNull();
    expect(parseIdentity('cursor_me', { email: 'linus@example.com' })).toBeNull();
    expect(parseIdentity('cursor_me', { sub: 'auth0|abc' })).toBeNull();
    for (const junk of [null, undefined, 'text', 42, true]) {
      expect(parseIdentity('chatgpt_session', junk)).toBeNull();
      expect(parseIdentity('claude_account', junk)).toBeNull();
      expect(parseIdentity('cursor_me', junk)).toBeNull();
    }
  });

  it('gives different people different keys and one person the same key', () => {
    const a = parseIdentity('chatgpt_session', { user: { id: 'user-a' } });
    const b = parseIdentity('chatgpt_session', { user: { id: 'user-b' } });
    expect(a?.key).not.toBe(b?.key);
    expect(parseIdentity('chatgpt_session', { user: { id: 'user-a', email: 'new@example.com' } })?.key).toBe(a?.key);
  });
});

describe('identity body size guard', () => {
  it('accepts small bodies and refuses ones over 64 KB', () => {
    expect(IDENTITY_BODY_LIMIT_BYTES).toBe(65536);
    expect(withinIdentityBodyLimit(JSON.stringify(chatgptSession))).toBe(true);
    expect(withinIdentityBodyLimit('a'.repeat(65536))).toBe(true);
    expect(withinIdentityBodyLimit('a'.repeat(65537))).toBe(false);
    // Multi-byte text is measured in UTF-8 bytes, not characters.
    expect(withinIdentityBodyLimit('é'.repeat(32768))).toBe(true);
    expect(withinIdentityBodyLimit('é'.repeat(32769))).toBe(false);
  });

  it('parses a body in one step and refuses oversized or broken ones', () => {
    expect(parseIdentityBody('cursor_me', JSON.stringify(cursorMe))?.display).toBe('linus@example.com');
    expect(parseIdentityBody('cursor_me', '{not json')).toBeNull();
    const padded = JSON.stringify({ ...cursorMe, pad: 'x'.repeat(IDENTITY_BODY_LIMIT_BYTES) });
    expect(parseIdentityBody('cursor_me', padded)).toBeNull();
  });
});
