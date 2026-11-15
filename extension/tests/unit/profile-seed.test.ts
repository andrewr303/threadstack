import { describe, expect, it } from 'vitest';
import {
  PARTITION_SITE_BUDGET_BYTES,
  SEED_RULE_ID_MAX,
  SEED_RULE_ID_MIN,
  allocateSeedRuleIds,
  buildSeedPlan,
  isSeedRuleId,
  seedNonceOf,
  seedPriority,
  seedRule,
  seedUrl,
  siteOfHost,
} from '../../src/core/embed/profile-seed.js';
import { applySetCookies } from '../../src/core/accounts/set-cookie.js';
import type { StoredCookie } from '../../src/core/workspace/types.js';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const NONCE = 'abcdef0123456789abcdef01';

function jar(headers: string[], url = 'https://claude.ai/'): StoredCookie[] {
  return applySetCookies([], headers, url, NOW);
}

const allowAll = () => true;

describe('seeding addresses', () => {
  it('names one small address per host and reads its nonce back', () => {
    const url = seedUrl('claude.ai', NONCE);
    expect(url).toBe(`https://claude.ai/robots.txt?tk_profile_seed=${NONCE}`);
    expect(seedNonceOf(url)).toBe(NONCE);
  });

  it.each([
    ['another path', `https://claude.ai/robots2.txt?tk_profile_seed=${NONCE}`],
    ['plain http', `http://claude.ai/robots.txt?tk_profile_seed=${NONCE}`],
    ['no nonce', 'https://claude.ai/robots.txt'],
    ['a nonce that is not hex', 'https://claude.ai/robots.txt?tk_profile_seed=zzzzzzzzzz'],
    ['a short nonce', 'https://claude.ai/robots.txt?tk_profile_seed=abc'],
    ['not an address', 'robots.txt'],
  ])('reads no nonce from %s', (_label, url) => {
    expect(seedNonceOf(url)).toBeNull();
  });

  it('takes the last two labels of a host as its site', () => {
    expect(siteOfHost('a.claude.ai')).toBe('claude.ai');
    expect(siteOfHost('CLAUDE.AI')).toBe('claude.ai');
    expect(siteOfHost('auth.openai.com')).toBe('openai.com');
  });
});

describe('what matters most in a jar', () => {
  it('ranks analytics lowest, then script-visible cookies, the bot check, and sign-in cookies highest', () => {
    expect(seedPriority({ name: '_ga', httpOnly: false })).toBe(0);
    expect(seedPriority({ name: 'ajs_user_id', httpOnly: false })).toBe(0);
    expect(seedPriority({ name: 'lastActiveOrg', httpOnly: false })).toBe(1);
    expect(seedPriority({ name: 'cf_clearance', httpOnly: true })).toBe(2);
    expect(seedPriority({ name: 'sessionKey', httpOnly: true })).toBe(3);
    expect(seedPriority({ name: '__Host-session', httpOnly: false })).toBe(3);
  });
});

describe('buildSeedPlan', () => {
  it('writes one step per host, least important cookies first so the sign-in is written last', () => {
    const cookies = jar([
      'sessionKey=sk; Path=/; Secure; HttpOnly; SameSite=Lax',
      '_ga=1; Path=/; Secure',
      'lastActiveOrg=org; Path=/; Secure; SameSite=Lax',
    ]);
    const device = jar(['cf_clearance=dev; Path=/; Secure; HttpOnly; SameSite=None']);
    const plan = buildSeedPlan({ cookies, deviceCookies: device, hostAllowed: allowAll, nonce: NONCE, nowMs: NOW });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ host: 'claude.ai', url: seedUrl('claude.ai', NONCE) });
    expect(plan.steps[0].headers.map((h) => h.split('=')[0])).toEqual(['_ga', 'lastActiveOrg', 'cf_clearance', 'sessionKey']);
    expect(plan.steps[0].headers.at(-1)).toBe('sessionKey=sk; Path=/; Secure; HttpOnly; SameSite=Lax');
    expect(plan).toMatchObject({ skipped: 0, dropped: 0, truncated: false });
  });

  it("prefers the account's own cookie over the browser's bot-check in the same slot", () => {
    const cookies = jar(['cf_clearance=account; Path=/; Secure; HttpOnly; SameSite=None']);
    const device = jar(['cf_clearance=browser; Path=/; Secure; HttpOnly; SameSite=None']);
    const plan = buildSeedPlan({ cookies, deviceCookies: device, hostAllowed: allowAll, nonce: NONCE, nowMs: NOW });
    expect(plan.steps[0].headers).toEqual(['cf_clearance=account; Path=/; Secure; HttpOnly; SameSite=None']);
  });

  it('leaves out hosts it may not reach, and does not count cookies that have run out', () => {
    const cookies = [
      ...jar(['sessionKey=sk; Path=/; Secure; HttpOnly']),
      ...jar(['other=1; Path=/; Secure'], 'https://elsewhere.example/'),
      ...jar(['old=1; Path=/; Max-Age=10']),
    ];
    const plan = buildSeedPlan({ cookies, deviceCookies: [], hostAllowed: (h) => h === 'claude.ai', nonce: NONCE, nowMs: NOW + 60_000 });
    expect(plan.steps.map((s) => s.host)).toEqual(['claude.ai']);
    expect(plan.steps[0].headers.map((h) => h.split('=')[0])).toEqual(['sessionKey']);
    expect(plan.skipped).toBe(1);
  });

  it('keeps a domain cookie on the bare domain and a host-only cookie on its own host, in host order', () => {
    const cookies = [
      ...jar(['wide=1; Path=/; Domain=claude.ai; Secure']),
      ...jar(['auth=1; Path=/; Secure; HttpOnly'], 'https://a.claude.ai/'),
    ];
    const plan = buildSeedPlan({ cookies, deviceCookies: [], hostAllowed: allowAll, nonce: NONCE, nowMs: NOW });
    expect(plan.steps.map((s) => s.host)).toEqual(['a.claude.ai', 'claude.ai']);
    expect(plan.steps.find((s) => s.host === 'claude.ai')!.headers[0]).toBe('wide=1; Path=/; Domain=claude.ai; Secure');
  });

  it('fits a large jar into the browser’s share per site by leaving out the least important cookies first', () => {
    const big = (name: string, attrs: string) => `${name}=${'x'.repeat(1500)}; Path=/; Secure${attrs}`;
    const cookies = jar([
      ...Array.from({ length: 4 }, (_, i) => big(`_ga${i}`, '')),
      ...Array.from({ length: 4 }, (_, i) => big(`pref${i}`, '')),
      big('sessionKey', '; HttpOnly'),
      big('refresh', '; HttpOnly'),
    ]);
    const plan = buildSeedPlan({ cookies, deviceCookies: [], hostAllowed: allowAll, nonce: NONCE, nowMs: NOW });
    const kept = plan.steps.flatMap((s) => s.headers.map((h) => h.split('=')[0]));
    expect(kept).toContain('sessionKey');
    expect(kept).toContain('refresh');
    expect(kept.filter((n) => n.startsWith('_ga'))).toHaveLength(0);
    expect(plan.dropped).toBe(10 - kept.length);
    expect(plan.truncated).toBe(false);
    const bytes = plan.steps.flatMap((s) => s.headers).reduce((sum, h) => sum + h.split(';')[0].length - 1, 0);
    expect(bytes).toBeLessThanOrEqual(PARTITION_SITE_BUDGET_BYTES);
  });

  it('says so when even the sign-in cookies do not all fit', () => {
    const cookies = jar(Array.from({ length: 8 }, (_, i) => `s${i}=${'y'.repeat(1500)}; Path=/; Secure; HttpOnly`));
    const plan = buildSeedPlan({ cookies, deviceCookies: [], hostAllowed: allowAll, nonce: NONCE, nowMs: NOW });
    expect(plan.dropped).toBeGreaterThan(0);
    expect(plan.truncated).toBe(true);
  });

  it('counts one budget for every host of a site', () => {
    const cookies = [
      ...jar(Array.from({ length: 4 }, (_, i) => `a${i}=${'x'.repeat(1500)}; Path=/; Secure`)),
      ...jar(Array.from({ length: 4 }, (_, i) => `b${i}=${'x'.repeat(1500)}; Path=/; Secure`), 'https://a.claude.ai/'),
    ];
    const plan = buildSeedPlan({ cookies, deviceCookies: [], hostAllowed: allowAll, nonce: NONCE, nowMs: NOW });
    expect(plan.dropped).toBeGreaterThan(0);
  });

  it('plans nothing for an empty jar and no bot-check', () => {
    expect(buildSeedPlan({ cookies: [], deviceCookies: [], hostAllowed: allowAll, nonce: NONCE, nowMs: NOW })).toEqual({
      steps: [],
      skipped: 0,
      dropped: 0,
      truncated: false,
    });
  });
});

describe('seeding rules', () => {
  it('adds the cookies to the answer of one address in one tab, and lets that answer load in a frame', () => {
    const step = { host: 'claude.ai', url: seedUrl('claude.ai', NONCE), headers: ['a=1; Path=/; Secure', 'b=2; Path=/; Secure; HttpOnly'] };
    expect(seedRule(2001, 42, step)).toEqual({
      id: 2001,
      priority: 3,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'set-cookie', operation: 'append', value: 'a=1; Path=/; Secure' },
          { header: 'set-cookie', operation: 'append', value: 'b=2; Path=/; Secure; HttpOnly' },
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' },
          { header: 'content-security-policy-report-only', operation: 'remove' },
        ],
      },
      condition: { tabIds: [42], urlFilter: `|${step.url}|`, resourceTypes: ['sub_frame'] },
    });
  });

  it('uses only its own id range and refuses when the range cannot hold the steps', () => {
    expect(isSeedRuleId(SEED_RULE_ID_MIN)).toBe(true);
    expect(isSeedRuleId(SEED_RULE_ID_MAX)).toBe(true);
    expect(isSeedRuleId(1000)).toBe(false);
    expect(isSeedRuleId(3000)).toBe(false);
    expect(allocateSeedRuleIds([2000, 2002], 3)).toEqual([2001, 2003, 2004]);
    expect(allocateSeedRuleIds([], 0)).toEqual([]);
    const all = Array.from({ length: SEED_RULE_ID_MAX - SEED_RULE_ID_MIN }, (_, i) => SEED_RULE_ID_MIN + i);
    expect(allocateSeedRuleIds(all, 2)).toBeNull();
  });
});
