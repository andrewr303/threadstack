// Guard: Threadkeeper must never act on ordinary sites it does not read (Outlook, Microsoft sign-in,
// Office). Every manifest content script, install-time host permission and runtime-registered
// provider script is built from these registry patterns, and the only network rule is the
// tab-scoped embed rule, so asserting on them covers what reaches those sites.
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_PROVIDER_IDS,
  PROVIDERS,
  captureMatchPatterns,
  detectProviderFromUrl,
  matchPatternCovers,
  optionalCaptureMatchPatterns,
  runtimeMatchPatterns,
} from '../../src/core/providers.js';
import { allNamedRealms } from '../../src/core/workspace/realms.js';
import { embedRule } from '../../src/core/embed/rules.js';
import { embeddedInExtensionPage, frameMode, type FrameWindow } from '../../src/core/embed/frame.js';

const UNRELATED_URLS = [
  'https://outlook.cloud.microsoft/mail/',
  'https://outlook.office.com/mail/',
  'https://outlook.office365.com/mail/',
  'https://outlook.live.com/mail/0/',
  'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  'https://login.live.com/login.srf',
  'https://www.office.com/',
  'https://m365.cloud.microsoft/',
  'https://res.cdn.office.net/owamail/scripts/boot.worker.js',
];

function everyPattern(): string[] {
  const all = new Set<string>([...captureMatchPatterns(), ...optionalCaptureMatchPatterns()]);
  for (const id of Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>) for (const p of PROVIDERS[id].matchPatterns) all.add(p);
  for (const id of CAPTURE_PROVIDER_IDS) for (const p of runtimeMatchPatterns(id)) all.add(p);
  for (const realm of allNamedRealms()) for (const p of realm.extraHostPatterns) all.add(p);
  return [...all];
}

describe('unrelated sites such as Outlook web', () => {
  it('the pattern matcher used here does match provider pages (sanity check)', () => {
    expect(everyPattern().some((p) => matchPatternCovers(p, 'https://copilot.microsoft.com/chats/abc'))).toBe(true);
  });

  it.each(UNRELATED_URLS)('no provider, realm or capture pattern covers %s', (url) => {
    expect(everyPattern().filter((p) => matchPatternCovers(p, url))).toEqual([]);
    expect(detectProviderFromUrl(url)).toBeNull();
  });

  it('the embed header rule is bound to one tab and to sub-frames, never to a site or all tabs', () => {
    const rule = embedRule(1000, 42);
    expect(rule.condition).toEqual({ tabIds: [42], resourceTypes: ['sub_frame'] });
  });

  it('a provider frame embedded by Outlook stays inert', () => {
    const top = {};
    const win: FrameWindow = { top, name: '', location: { ancestorOrigins: ['https://outlook.cloud.microsoft'] } };
    expect(frameMode(win)).toBe('other');
    expect(embeddedInExtensionPage(win)).toBe(false);
  });
});
