// Settings → Capture: which AI products are captured, host access for the ones Threadkeeper does
// not hold from install, "Capture this tab", and "Any AI site" (origins the user adds).
//
// Host access must be requested inside the click (chrome.permissions.request needs the user
// gesture), so every request below is the first thing its handler does, before any await.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { SettingsRecord } from '../../core/schema.js';
import {
  CAPTURE_PROVIDER_IDS,
  CATEGORY_LABELS,
  PROVIDER_CATEGORIES,
  PROVIDERS,
  runtimeMatchPatterns,
  runtimePermissionOrigins,
  type CaptureProviderId,
  type ProviderCategory,
} from '../../core/providers.js';
import {
  CUSTOM_SITES_KEY,
  EMPTY_CUSTOM_SITES,
  addCustomSite,
  normalizeCustomSites,
  normalizeSiteOrigin,
  originMatchPattern,
  readCustomSites,
  removeCustomSite,
  writeCustomSites,
  type CustomSitesState,
} from '../../core/custom-sites.js';

interface Props {
  settings: SettingsRecord;
  onPatch: (patch: Partial<SettingsRecord>) => Promise<void>;
}

type Result = { ok: boolean; text: string } | null;

const hasChrome = () => typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);

function sendToBackground<T>(message: Record<string, unknown>): Promise<T | undefined> {
  if (!hasChrome()) return Promise.resolve(undefined);
  return chrome.runtime.sendMessage(message).catch(() => undefined) as Promise<T | undefined>;
}

/** Ask for host access; resolves false when declined or unavailable. Call first thing in a click. */
function requestOrigins(origins: string[]): Promise<boolean> {
  if (origins.length === 0) return Promise.resolve(true);
  if (!hasChrome() || !chrome.permissions?.request) return Promise.resolve(true);
  return chrome.permissions.request({ origins }).catch(() => false);
}

async function containsOrigins(origins: string[]): Promise<boolean> {
  if (origins.length === 0) return true;
  if (!hasChrome() || !chrome.permissions?.contains) return true;
  return chrome.permissions.contains({ origins }).catch(() => false);
}

async function removeOrigins(origins: string[]): Promise<void> {
  if (origins.length === 0 || !hasChrome() || !chrome.permissions?.remove) return;
  await chrome.permissions.remove({ origins }).catch(() => false);
}

const storage = () => (hasChrome() ? chrome.storage?.local : undefined);

export function CaptureSettings({ settings, onPatch }: Props) {
  const [granted, setGranted] = useState<Partial<Record<CaptureProviderId, boolean>>>({});
  const [sites, setSites] = useState<CustomSitesState>(EMPTY_CUSTOM_SITES);
  const [siteAccess, setSiteAccess] = useState<Record<string, boolean>>({});
  const [siteInput, setSiteInput] = useState('');
  const [tabOrigin, setTabOrigin] = useState<string | null>(null);
  const [result, setResult] = useState<Result>(null);
  const [capturing, setCapturing] = useState(false);

  const refreshAccess = useCallback(async () => {
    const next: Partial<Record<CaptureProviderId, boolean>> = {};
    for (const id of CAPTURE_PROVIDER_IDS) {
      const origins = runtimePermissionOrigins(id);
      if (origins.length > 0) next[id] = await containsOrigins(origins);
    }
    setGranted(next);
    const current = await readCustomSites(storage());
    setSites(current);
    const access: Record<string, boolean> = {};
    for (const site of current.sites) access[site.origin] = await containsOrigins([originMatchPattern(site.origin)]);
    setSiteAccess(access);
  }, []);

  // The address of the tab Threadkeeper was opened on, read ahead of time so "Add this site" can ask
  // for access synchronously in its click. Available only where the browser lets us see the tab.
  const refreshTab = useCallback(async () => {
    if (!hasChrome() || !chrome.tabs?.query) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const url = tab?.url ?? '';
      const checked = /^https?:\/\//.test(url) ? normalizeSiteOrigin(url) : null;
      setTabOrigin(checked?.ok ? checked.origin : null);
    } catch {
      setTabOrigin(null);
    }
  }, []);

  useEffect(() => {
    void refreshAccess();
    void refreshTab();
    if (!hasChrome()) return;
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && CUSTOM_SITES_KEY in changes) setSites(normalizeCustomSites(changes[CUSTOM_SITES_KEY].newValue));
    };
    // The permissions events cannot be unsubscribed in the typings; ignore calls after unmount.
    let live = true;
    const onPermissions = () => {
      if (live) void refreshAccess();
    };
    const onFocus = () => void refreshTab();
    chrome.storage?.onChanged?.addListener(onStorage);
    chrome.permissions?.onAdded?.addListener(onPermissions);
    chrome.permissions?.onRemoved?.addListener(onPermissions);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      live = false;
      chrome.storage?.onChanged?.removeListener(onStorage);
      (chrome.permissions?.onAdded as unknown as { removeListener?: (fn: () => void) => void })?.removeListener?.(onPermissions);
      (chrome.permissions?.onRemoved as unknown as { removeListener?: (fn: () => void) => void })?.removeListener?.(onPermissions);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refreshAccess, refreshTab]);

  const byCategory = useMemo(() => {
    const groups = new Map<ProviderCategory, CaptureProviderId[]>();
    for (const id of CAPTURE_PROVIDER_IDS) {
      if (PROVIDERS[id].hostAccess === 'custom') continue;
      const list = groups.get(PROVIDERS[id].category) ?? [];
      list.push(id);
      groups.set(PROVIDERS[id].category, list);
    }
    return PROVIDER_CATEGORIES.filter((c) => groups.has(c)).map((c) => [c, groups.get(c)!] as const);
  }, []);

  const setEnabled = (id: CaptureProviderId, on: boolean) => {
    const origins = runtimePermissionOrigins(id);
    const info = PROVIDERS[id];
    // Optional providers: ask for their pages in the click itself, then turn capture on.
    const access = on && info.hostAccess === 'optional' ? requestOrigins(origins) : Promise.resolve(true);
    void (async () => {
      if (!(await access)) {
        setResult({ ok: false, text: `Access to ${info.label} was not granted, so it stays off.` });
        return;
      }
      await onPatch({ authorizedHosts: { ...settings.authorizedHosts, [id]: on } });
      if (!on && info.hostAccess === 'optional') await removeOrigins(origins);
      await sendToBackground({ type: 'CAPTURE_SITES_CHANGED', patterns: on ? runtimeMatchPatterns(id) : [] });
      setResult(null);
      await refreshAccess();
    })();
  };

  const allowMissing = (id: CaptureProviderId) => {
    const origins = runtimePermissionOrigins(id);
    const access = requestOrigins(origins);
    void (async () => {
      const ok = await access;
      if (ok) await sendToBackground({ type: 'CAPTURE_SITES_CHANGED', patterns: runtimeMatchPatterns(id) });
      setResult(ok ? null : { ok: false, text: `Access to ${PROVIDERS[id].label} was not granted.` });
      await refreshAccess();
    })();
  };

  const captureThisTab = () => {
    setCapturing(true);
    setResult(null);
    void sendToBackground<{ ok?: boolean; error?: string; status?: string; title?: string; messages?: number }>({ type: 'CAPTURE_TAB_NOW' })
      .then((resp) => {
        if (!resp) setResult({ ok: false, text: 'Capture this tab works when Threadkeeper runs as an extension.' });
        else if (!resp.ok) setResult({ ok: false, text: resp.error ?? 'Nothing was captured.' });
        else {
          const what = resp.title ? `“${resp.title}”` : 'The conversation';
          const count = typeof resp.messages === 'number' ? ` (${resp.messages} message${resp.messages === 1 ? '' : 's'})` : '';
          setResult({ ok: true, text: resp.status === 'unchanged' ? `${what} is already up to date${count}.` : `Saved ${what}${count}.` });
        }
      })
      .finally(() => setCapturing(false));
  };

  const addSite = (raw: string) => {
    const checked = normalizeSiteOrigin(raw);
    if (!checked.ok) {
      setResult({ ok: false, text: checked.error });
      return;
    }
    const pattern = originMatchPattern(checked.origin);
    const access = requestOrigins([pattern]);
    void (async () => {
      if (!(await access)) {
        setResult({ ok: false, text: `Access to ${checked.host} was not granted, so it was not added.` });
        return;
      }
      try {
        const next = addCustomSite(await readCustomSites(storage()), checked.origin, new Date().toISOString());
        const area = storage();
        if (area) await writeCustomSites(area, next);
        setSites(next);
        await sendToBackground({ type: 'CAPTURE_SITES_CHANGED', patterns: [pattern] });
        setSiteInput('');
        setResult({ ok: true, text: `Added ${checked.host}. Open a chat there and it is captured as you read it.` });
      } catch (err) {
        setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
      }
      await refreshAccess();
    })();
  };

  const removeSite = (origin: string) => {
    void (async () => {
      const current = await readCustomSites(storage());
      const next = removeCustomSite(current, origin);
      const area = storage();
      if (area) await writeCustomSites(area, next);
      setSites(next);
      const pattern = originMatchPattern(origin);
      // Another added site on the same host (a different port) still needs the access.
      if (!next.sites.some((s) => originMatchPattern(s.origin) === pattern)) await removeOrigins([pattern]);
      await sendToBackground({ type: 'CAPTURE_SITES_CHANGED', patterns: [] });
      setResult({ ok: true, text: `Removed ${new URL(origin).host}. Threads already captured from it stay in the library.` });
      await refreshAccess();
    })();
  };

  const tabAlreadyAdded = tabOrigin !== null && sites.sites.some((s) => s.origin === tabOrigin);
  const enabledCount = CAPTURE_PROVIDER_IDS.filter((id) => PROVIDERS[id].hostAccess !== 'custom' && settings.authorizedHosts[id]).length;

  return (
    <>
      <section className="tk-settings-section">
        <h3 className="tk-settings-h3">AI products</h3>
        <p className="tk-settings-note">
          Conversations you open on these sites are captured as you read them and stay in this browser. Sites marked
          “Asks for access” need your permission for that site when you turn them on. Turning a site off stops new
          captures; threads already saved stay in the library. {enabledCount} on.
        </p>
        {result && (
          <p className="tk-settings-result" data-ok={result.ok ? 'true' : 'false'} role="status">
            {result.text}
          </p>
        )}
        {byCategory.map(([category, ids]) => (
          <fieldset key={category} className="tk-fieldset tk-capture-group">
            <legend className="tk-capture-legend">{CATEGORY_LABELS[category]}</legend>
            <div className="tk-capture-grid">
              {ids.map((id) => {
                const info = PROVIDERS[id];
                const on = Boolean(settings.authorizedHosts[id]);
                const needsAccess = runtimePermissionOrigins(id).length > 0 && granted[id] === false;
                return (
                  <div key={id} className="tk-capture-item">
                    <label className="tk-toggle">
                      <input type="checkbox" checked={on} onChange={(e) => setEnabled(id, e.target.checked)} />
                      <span>
                        {info.label}
                        {info.hostAccess === 'optional' && <span className="tk-chip tk-chip-small tk-chip-quiet tk-capture-badge">Asks for access</span>}
                        {info.captureMode === 'explicit' && <span className="tk-chip tk-chip-small tk-capture-badge">Only when you ask</span>}
                        {info.selectorConfidence === 'low' && <span className="tk-chip tk-chip-small tk-chip-quiet tk-capture-badge">Early support</span>}
                        <span className="tk-toggle-hint">{info.captureNote}</span>
                      </span>
                    </label>
                    {on && needsAccess && (
                      <button type="button" className="tk-btn tk-capture-allow" onClick={() => allowMissing(id)}>
                        {info.hostAccess === 'optional' ? `Allow access to ${info.label}` : `Also allow ${runtimePermissionOrigins(id).map((o) => o.replace(/^https?:\/\/|\/\*$/g, '')).join(', ')}`}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}
        <p className="tk-settings-note">
          Claude Code and Codex sessions on your computer, and ChatGPT or Claude data exports, come in through Import / Export.
          Products marked “Early support” are read with best-effort selectors; if a chat looks incomplete, use Diagnostics → Check this tab.
        </p>
      </section>

      <section className="tk-settings-section">
        <h3 className="tk-settings-h3">Capture this tab</h3>
        <p className="tk-settings-note">
          Saves the conversation open in the current tab right now. This is the only way a Grok Bot chat on X Chat is saved.
        </p>
        <div className="tk-field-row">
          <button type="button" className="tk-btn" onClick={captureThisTab} disabled={capturing}>
            {capturing ? 'Capturing…' : 'Capture this tab'}
          </button>
        </div>
      </section>

      <section className="tk-settings-section">
        <h3 className="tk-settings-h3">Any AI site</h3>
        <p className="tk-settings-note">
          Add a chat site Threadkeeper does not list, such as your own Open WebUI, LibreChat, LobeChat or AnythingLLM. Threadkeeper
          asks for access to that one site, recognises these apps by their pages, and otherwise finds messages by their roles.
          Plain http is allowed only for sites on this computer or your network.
        </p>
        {sites.sites.length > 0 && (
          <ul className="tk-capture-sites">
            {sites.sites.map((site) => (
              <li key={site.origin} className="tk-capture-site">
                <span className="tk-capture-site-origin">{site.origin}</span>
                {siteAccess[site.origin] === false && <span className="tk-chip tk-chip-small tk-chip-quiet">Access removed</span>}
                <button type="button" className="tk-btn" onClick={() => (siteAccess[site.origin] === false ? addSite(site.origin) : removeSite(site.origin))}>
                  {siteAccess[site.origin] === false ? 'Allow again' : 'Remove'}
                </button>
                {siteAccess[site.origin] === false && (
                  <button type="button" className="tk-btn" onClick={() => removeSite(site.origin)}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <form
          className="tk-field-row"
          onSubmit={(e) => {
            e.preventDefault();
            addSite(siteInput);
          }}
        >
          <label className="tk-field">
            <span className="tk-visually-hidden">Site address</span>
            <input
              className="tk-input"
              type="text"
              inputMode="url"
              placeholder="https://chat.example.com"
              value={siteInput}
              onChange={(e) => setSiteInput(e.target.value)}
            />
          </label>
          <button type="submit" className="tk-btn" disabled={!siteInput.trim()}>
            Add site
          </button>
          {tabOrigin && !tabAlreadyAdded && (
            <button type="button" className="tk-btn" onClick={() => addSite(tabOrigin)}>
              Add {new URL(tabOrigin).host}
            </button>
          )}
        </form>
      </section>
    </>
  );
}
