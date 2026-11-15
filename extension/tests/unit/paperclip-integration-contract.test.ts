import { describe, expect, it } from 'vitest';
import { parseHealth } from '../../src/core/paperclip/client.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/core/schema.js';
import { WORKSPACE_COMMAND_TYPES, WORKSPACE_VIEWS } from '../../src/core/workspace/types.js';
import { validateRuntimeMessageSender } from '../../src/core/messaging.js';
import { embedRule, installEmbedRule } from '../../src/core/embed/rules.js';

describe('Paperclip integration boundaries', () => {
  it('keeps authenticated readiness and bootstrap state from health', () => {
    expect(parseHealth({ status: 'ok', deploymentMode: 'authenticated', authReady: false, bootstrapStatus: 'bootstrap_pending' }))
      .toMatchObject({ authReady: false, bootstrapStatus: 'bootstrap_pending' });
  });

  it('supports the application view while unknown stored values still fall back', () => {
    expect(WORKSPACE_VIEWS).toContain('paperclip');
    expect(normalizeSettings({ activeView: 'paperclip' as never }).activeView).toBe('paperclip');
    expect(normalizeSettings({ activeView: 'unrecognized' as never }).activeView).toBe(DEFAULT_SETTINGS.activeView);
  });

  it.each(['PAPERCLIP_INTEGRATION', 'PAPERCLIP_SERVICE_STATUS', 'PAPERCLIP_SERVICE_START', 'PAPERCLIP_SERVICE_INSTALL'])
  ('keeps %s restricted to the top-level manager', (type) => {
    expect(WORKSPACE_COMMAND_TYPES.has(type)).toBe(true);
    expect(validateRuntimeMessageSender({ type }, { id: 'a'.repeat(32), url: 'https://claude.ai/code', frameId: 7, tab: { id: 2 } }, 'a'.repeat(32)).allowed).toBe(false);
    expect(validateRuntimeMessageSender({ type }, { id: 'a'.repeat(32), url: `chrome-extension://${'a'.repeat(32)}/sidepanel.html`, frameId: 0 }, 'a'.repeat(32)).allowed).toBe(false);
  });

  it('persists only bounded credential link metadata with transfer off by default', () => {
    expect(normalizeSettings({}).paperclipCredentials).toEqual({ companyId: '', linkedKeys: [], allowSecretTransfer: false, blockedKeys: [] });
    expect(normalizeSettings({ paperclipCredentials: { companyId: 'company', linkedKeys: ['voyageApiKey', 'voyageApiKey', 'notAKey'], allowSecretTransfer: true } }).paperclipCredentials)
      .toEqual({ companyId: 'company', linkedKeys: ['voyageApiKey'], allowSecretTransfer: true, blockedKeys: [] });
  });

  it('preserves Paperclip security headers and refreshes rules after changing origin', async () => {
    const existing = embedRule(1000, 42, ['localhost']);
    expect(existing.condition.excludedRequestDomains).toEqual(['localhost']);
    const updates: unknown[] = [];
    await installEmbedRule({ getSessionRules: async () => [existing], updateSessionRules: async (update) => { updates.push(update); } }, 42, new Map([[42, 1000]]), ['127.0.0.1']);
    expect(updates).toEqual([{ removeRuleIds: [1000], addRules: [embedRule(1000, 42, ['127.0.0.1'])] }]);
  });
});
