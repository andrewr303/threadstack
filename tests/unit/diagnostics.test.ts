import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_RELOAD_KEY,
  AUTO_RELOAD_LOG_KEY,
  assessManifest,
  autoHealStaleManifest,
  detectBrowser,
  extensionsPageUrl,
  formatDiagnosticsReport,
  readDiskBuildInfo,
  reloadWouldHelp,
  type ManifestLike,
} from '../../src/core/diagnostics.js';
import type { BuildInfo } from '../../src/core/build-info.js';

const BUILD: BuildInfo = {
  version: '0.3.0',
  versionName: '0.3.0 (build 20261103.010000-abc1234)',
  buildId: '20261103.010000-abc1234',
  builtAt: '2026-11-03T01:00:00.000Z',
};

const GOOD: ManifestLike = {
  version: '0.3.0',
  version_name: BUILD.versionName,
  side_panel: { default_path: 'sidepanel.html' },
  web_accessible_resources: [{ resources: ['manager.html', 'assets/*'], matches: ['https://claude.ai/*'] }],
};

// The manifest the 0.1 build shipped and Edge kept running after a rebuild.
const EDGE_BLOCKED: ManifestLike = {
  version: '0.1.0',
  web_accessible_resources: [
    { resources: ['manager.html', 'assets/*'], matches: ['https://claude.ai/*'], use_dynamic_url: true },
  ],
};

function memoryStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    },
  };
}

describe('assessManifest', () => {
  it('accepts a manifest written by the same build', () => {
    const health = assessManifest(GOOD, BUILD, { hasSidePanelApi: true });
    expect(health.ok).toBe(true);
    expect(health.issues).toEqual([]);
  });

  it('flags the stale use_dynamic_url manifest that Edge blocks', () => {
    const health = assessManifest(EDGE_BLOCKED, BUILD, { browser: 'Microsoft Edge' });
    expect(health.ok).toBe(false);
    expect(health.issues.map((i) => i.code)).toEqual(['stale_manifest', 'dynamic_url_war']);
    expect(health.issues[0].fix).toContain('edge://extensions');
    expect(reloadWouldHelp(health)).toBe(true);
  });

  it('flags a different build id even when the version number matches', () => {
    const health = assessManifest({ ...GOOD, version_name: '0.3.0 (build 20261101.000000-0000000)' }, BUILD);
    expect(health.issues.map((i) => i.code)).toEqual(['stale_manifest']);
  });

  it('skips the build comparison for unbundled code (tests, dev servers)', () => {
    const health = assessManifest({ version: '9.9.9', web_accessible_resources: GOOD.web_accessible_resources }, {
      ...BUILD,
      buildId: 'unbundled',
    });
    expect(health.ok).toBe(true);
  });

  it('warns when the overlay page is not web-accessible or the side panel API is missing', () => {
    const health = assessManifest({ ...GOOD, web_accessible_resources: [] }, BUILD, { hasSidePanelApi: false });
    expect(health.ok).toBe(true);
    expect(health.issues.map((i) => i.code)).toEqual(['manager_not_web_accessible', 'side_panel_unavailable']);
    expect(reloadWouldHelp(health)).toBe(false);
  });
});

describe('autoHealStaleManifest', () => {
  it('does nothing when the manifest matches', async () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(await autoHealStaleManifest({ manifest: GOOD, storage, reload, build: BUILD })).toBe('ok');
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads once per build, then stops (no reload loop)', async () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    const now = () => new Date('2026-11-03T02:00:00.000Z');
    expect(await autoHealStaleManifest({ manifest: EDGE_BLOCKED, storage, reload, build: BUILD, now })).toBe('reloading');
    expect(storage.data[AUTO_RELOAD_KEY]).toBe(BUILD.buildId);
    expect(reload).toHaveBeenCalledTimes(1);

    // After the reload the folder still holds the old manifest: no second reload.
    expect(await autoHealStaleManifest({ manifest: EDGE_BLOCKED, storage, reload, build: BUILD, now })).toBe('already_attempted');
    expect(reload).toHaveBeenCalledTimes(1);
    const log = storage.data[AUTO_RELOAD_LOG_KEY] as Array<{ outcome: string }>;
    expect(log.map((e) => e.outcome)).toEqual(['reloading', 'skipped_already_attempted']);
  });

  it('tries again for a newer build', async () => {
    const storage = memoryStorage({ [AUTO_RELOAD_KEY]: 'older-build' });
    const reload = vi.fn();
    expect(await autoHealStaleManifest({ manifest: EDGE_BLOCKED, storage, reload, build: BUILD })).toBe('reloading');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('browser helpers', () => {
  it('detects Edge from client hints or the user agent', () => {
    expect(detectBrowser('Mozilla/5.0 Chrome/155.0 Safari/537.36 Edg/155.0.4283.62')).toBe('Microsoft Edge');
    expect(detectBrowser('', [{ brand: 'Microsoft Edge' }, { brand: 'Chromium' }])).toBe('Microsoft Edge');
    expect(detectBrowser('', [{ brand: 'Google Chrome' }, { brand: 'Chromium' }])).toBe('Google Chrome');
    expect(detectBrowser('Mozilla/5.0 Chrome/155.0 Safari/537.36')).toBe('Chromium');
    expect(extensionsPageUrl('Microsoft Edge', 'abc')).toBe('edge://extensions/?id=abc');
    expect(extensionsPageUrl('Google Chrome')).toBe('chrome://extensions');
  });

  it('formats a report without secrets', () => {
    const report = formatDiagnosticsReport({
      build: BUILD,
      extensionId: 'mgcmbjjpjbnfabciehdgoilpoeecbcii',
      browser: 'Microsoft Edge',
      userAgent: 'UA',
      health: assessManifest(EDGE_BLOCKED, BUILD),
      sidePanelApi: true,
      autoReloadLog: [],
      recentEvents: [{ timestamp: '2026-11-03T01:00:00.000Z', reason: 'Overlay frame did not load' }],
    });
    expect(report).toContain('Running manifest:  0.1.0');
    expect(report).toContain('dynamic_url_war');
    expect(report).toContain('Overlay frame did not load');
  });
});

describe('rebuild without Reload: the worker compares the build on disk', () => {
  const OLD: BuildInfo = { version: '0.3.0', versionName: '0.3.0 (build A)', buildId: 'A', builtAt: '2026-11-03T01:00:00.000Z' };
  const NEW: BuildInfo = { version: '0.3.0', versionName: '0.3.0 (build B)', buildId: 'B', builtAt: '2026-11-03T02:00:00.000Z' };
  const fileFetch = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('reads a valid build-info.json and rejects anything else', async () => {
    expect(await readDiskBuildInfo('build-info.json', fileFetch(NEW))).toEqual(NEW);
    expect(await readDiskBuildInfo('build-info.json', fileFetch({ buildId: 'B' }))).toBeNull();
    expect(await readDiskBuildInfo('build-info.json', fileFetch(NEW, 404))).toBeNull();
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await readDiskBuildInfo('build-info.json', failing)).toBeNull();
  });

  it('reloads when the files on disk are newer than both the running manifest and the cached worker', async () => {
    // The cached worker still carries build A and so does the manifest; only build-info.json moved to B.
    const runningManifest: ManifestLike = { ...GOOD, version_name: OLD.versionName };
    expect(assessManifest(runningManifest, OLD).ok).toBe(true);
    const disk = await readDiskBuildInfo('build-info.json', fileFetch(NEW));
    const reload = vi.fn();
    const outcome = await autoHealStaleManifest({ manifest: runningManifest, storage: memoryStorage(), reload, build: disk ?? OLD });
    expect(outcome).toBe('reloading');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
