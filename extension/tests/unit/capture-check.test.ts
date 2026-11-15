import { describe, expect, it } from 'vitest';
import { describeCaptureProbe, type CaptureProbeReport } from '../../src/core/diagnostics.js';

const base: CaptureProbeReport = {
  url: 'https://chatgpt.com/c/11111111-2222-4333-8444-555555555555?model=gpt-5',
  provider: 'chatgpt',
  conversationId: '11111111-2222-4333-8444-555555555555',
  domMessages: 6,
  domRoles: { user: 3, assistant: 3 },
  siteDataMessages: 6,
  lastCapture: { at: '2026-11-03T12:00:00.000Z', method: 'site_data', outcome: 'stored', messages: 6 },
  error: null,
};

describe('describeCaptureProbe', () => {
  it('says capture works when the site data is being read', () => {
    const r = describeCaptureProbe(base);
    expect(r.ok).toBe(true);
    expect(r.verdict).toMatch(/full conversation data \(6 messages\)/);
  });

  it('works from the page alone and points to a reload for the complete data', () => {
    const r = describeCaptureProbe({ ...base, siteDataMessages: null });
    expect(r.ok).toBe(true);
    expect(r.verdict).toMatch(/reading the page \(6 messages\)/);
    expect(r.lines.join('\n')).toMatch(/not received/);
  });

  it.each([
    ['no answer from the tab', null, /not running in that tab/],
    ['an unknown site', { ...base, provider: null }, /not a page Threadkeeper captures/],
    ['no open conversation', { ...base, conversationId: null }, /No conversation is open/],
    ['an empty page with no site data', { ...base, domMessages: 0, domRoles: {}, siteDataMessages: null }, /no messages on the page/],
    ['a refused capture', { ...base, lastCapture: { at: '2026-11-03T12:00:00.000Z', method: 'dom', outcome: 'skipped', detail: 'provider_not_authorized' } }, /switched off/],
    ['a capture that never arrived', { ...base, siteDataMessages: null, lastCapture: { at: '2026-11-03T12:00:00.000Z', method: 'dom', outcome: 'error', detail: 'No answer from the extension.' } }, /did not reach the library/],
    ['a reading error', { ...base, error: 'boom' }, /Reading the page failed/],
  ] as Array<[string, CaptureProbeReport | null, RegExp]>)('flags %s', (_name, report, verdict) => {
    const r = describeCaptureProbe(report);
    expect(r.ok).toBe(false);
    expect(r.verdict).toMatch(verdict);
  });

  it('keeps conversation ids, titles and message text out of the report', () => {
    const text = describeCaptureProbe({ ...base, domTitle: 'Secret plan', url: `${base.url}&q=secret` } as CaptureProbeReport).lines.join('\n');
    expect(text).not.toMatch(/11111111-2222|Secret plan|secret/);
    expect(text).toContain('chatgpt.com/c/<id>');
  });
});
