import { BUILD_INFO, type BuildInfo } from './build-info.js';

/**
 * Self-diagnosis for the "<id> is blocked · ERR_BLOCKED_BY_CLIENT" failure.
 *
 * Verified in Microsoft Edge 155: a manifest whose web_accessible_resources use
 * `use_dynamic_url` makes Edge refuse the static-ID manager URL, including the
 * full-page library the extension opens itself. Edge reads manifest.json only
 * when an unpacked extension is (re)loaded, so rebuilding without pressing
 * Reload keeps the broken manifest live while the new JS and HTML on disk are
 * served. Pages and the service worker compare the running manifest with the
 * build they were compiled from and repair or explain the mismatch.
 */

export type ManifestIssueCode =
  | 'stale_manifest'
  | 'dynamic_url_war'
  | 'manager_not_web_accessible'
  | 'side_panel_unavailable';

export interface ManifestIssue {
  code: ManifestIssueCode;
  severity: 'error' | 'warning';
  message: string;
  fix: string;
}

export interface ManifestHealth {
  ok: boolean;
  runningVersionName: string;
  expectedVersionName: string;
  issues: ManifestIssue[];
}

type WarEntry = string | { resources?: string[]; matches?: string[]; use_dynamic_url?: boolean };

export interface ManifestLike {
  version?: string;
  version_name?: string;
  web_accessible_resources?: WarEntry[];
  side_panel?: unknown;
}

export type BrowserName = 'Microsoft Edge' | 'Google Chrome' | 'Chromium' | 'Other';

export function detectBrowser(
  userAgent: string,
  brands: Array<{ brand: string }> = []
): BrowserName {
  const names = brands.map((b) => b.brand);
  if (names.includes('Microsoft Edge') || /\bEdg\//.test(userAgent)) return 'Microsoft Edge';
  if (names.includes('Google Chrome')) return 'Google Chrome';
  if (names.includes('Chromium') || /\bChrome\//.test(userAgent)) return 'Chromium';
  return 'Other';
}

export function extensionsPageUrl(browser: BrowserName, extensionId?: string): string {
  const base = browser === 'Microsoft Edge' ? 'edge://extensions' : 'chrome://extensions';
  return extensionId ? `${base}/?id=${extensionId}` : base;
}

function warResources(entry: WarEntry): string[] {
  return typeof entry === 'string' ? [entry] : entry.resources ?? [];
}

function coversManager(resources: string[]): boolean {
  return resources.some((r) => r === 'manager.html' || r === '*' || r === '/*' || r === '*.html');
}

export function assessManifest(
  manifest: ManifestLike,
  build: BuildInfo = BUILD_INFO,
  env: { hasSidePanelApi?: boolean; browser?: BrowserName } = {}
): ManifestHealth {
  const issues: ManifestIssue[] = [];
  const running = manifest.version_name ?? manifest.version ?? '';
  const reloadHint =
    env.browser === 'Microsoft Edge'
      ? 'Open edge://extensions and click Reload under Threadkeeper (or use the Reload button here).'
      : 'Open chrome://extensions and click Reload under Threadkeeper (or use the Reload button here).';

  if (build.buildId !== 'unbundled' && running !== build.versionName) {
    issues.push({
      code: 'stale_manifest',
      severity: 'error',
      message: `The browser is still running Threadkeeper ${running || '(unknown build)'}, but the files on disk are ${build.versionName}. The browser reads manifest.json only when the extension is reloaded.`,
      fix: reloadHint,
    });
  }

  const entries = manifest.web_accessible_resources ?? [];
  if (entries.some((e) => typeof e === 'object' && e.use_dynamic_url === true)) {
    issues.push({
      code: 'dynamic_url_war',
      severity: 'error',
      message:
        'This manifest makes the library pages web-accessible only through a dynamic URL. Microsoft Edge blocks the static URL, which shows "<id> is blocked · ERR_BLOCKED_BY_CLIENT".',
      fix: reloadHint,
    });
  }

  if (!entries.some((e) => coversManager(warResources(e)))) {
    issues.push({
      code: 'manager_not_web_accessible',
      severity: 'warning',
      message: 'manager.html is not web-accessible, so the in-page overlay cannot load. The side panel and full-page library still work.',
      fix: reloadHint,
    });
  }

  if (manifest.side_panel && env.hasSidePanelApi === false) {
    issues.push({
      code: 'side_panel_unavailable',
      severity: 'warning',
      message: 'This browser build does not expose the side panel API. The toolbar button opens the full-page library instead.',
      fix: 'Update the browser, or choose "Full tab" under Settings → General → Toolbar button.',
    });
  }

  return {
    ok: !issues.some((i) => i.severity === 'error'),
    runningVersionName: running,
    expectedVersionName: build.versionName,
    issues,
  };
}

/** Issues that reloading the extension can fix. */
export function reloadWouldHelp(health: ManifestHealth): boolean {
  return health.issues.some((i) => i.code === 'stale_manifest' || i.code === 'dynamic_url_war');
}

export const AUTO_RELOAD_KEY = 'tk_auto_reload_build';
export const AUTO_RELOAD_LOG_KEY = 'tk_auto_reload_log';

export interface AutoReloadLogEntry {
  at: string;
  buildId: string;
  from: string;
  outcome: 'reloading' | 'skipped_already_attempted';
}

interface KeyValueStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface AutoHealDeps {
  manifest: ManifestLike;
  storage: KeyValueStore;
  reload: () => void;
  build?: BuildInfo;
  now?: () => Date;
}

/**
 * Service worker: when this code is newer than the running manifest, reload the
 * extension once so the browser re-reads manifest.json from disk. The attempt
 * is recorded per build id before reloading, so a folder that really contains
 * a mismatched manifest cannot cause a reload loop.
 */
export async function autoHealStaleManifest(
  deps: AutoHealDeps
): Promise<'ok' | 'reloading' | 'already_attempted'> {
  const build = deps.build ?? BUILD_INFO;
  const health = assessManifest(deps.manifest, build);
  if (!reloadWouldHelp(health)) return 'ok';

  const stored = await deps.storage.get(AUTO_RELOAD_KEY);
  const logRaw = await deps.storage.get(AUTO_RELOAD_LOG_KEY);
  const log = Array.isArray(logRaw[AUTO_RELOAD_LOG_KEY])
    ? (logRaw[AUTO_RELOAD_LOG_KEY] as AutoReloadLogEntry[])
    : [];
  const at = (deps.now ?? (() => new Date()))().toISOString();

  if (stored[AUTO_RELOAD_KEY] === build.buildId) {
    await deps.storage.set({
      [AUTO_RELOAD_LOG_KEY]: [
        ...log,
        { at, buildId: build.buildId, from: health.runningVersionName, outcome: 'skipped_already_attempted' },
      ].slice(-10),
    });
    return 'already_attempted';
  }

  await deps.storage.set({
    [AUTO_RELOAD_KEY]: build.buildId,
    [AUTO_RELOAD_LOG_KEY]: [
      ...log,
      { at, buildId: build.buildId, from: health.runningVersionName, outcome: 'reloading' },
    ].slice(-10),
  });
  deps.reload();
  return 'reloading';
}

export interface DiagnosticsSnapshot {
  build: BuildInfo;
  extensionId: string;
  browser: BrowserName;
  userAgent: string;
  health: ManifestHealth;
  sidePanelApi: boolean;
  autoReloadLog: AutoReloadLogEntry[];
  recentEvents: Array<{ timestamp: string; reason: string }>;
}

/** Plain-text report the user can paste into an issue. Contains no keys or thread content. */
export function formatDiagnosticsReport(s: DiagnosticsSnapshot): string {
  const lines = [
    'Threadkeeper diagnostics',
    `Files on disk:     ${s.build.versionName} (built ${s.build.builtAt})`,
    `Running manifest:  ${s.health.runningVersionName || 'unknown'}`,
    `Extension ID:      ${s.extensionId}`,
    `Browser:           ${s.browser}`,
    `User agent:        ${s.userAgent}`,
    `Side panel API:    ${s.sidePanelApi ? 'available' : 'missing'}`,
    `Status:            ${s.health.ok ? 'OK' : 'needs attention'}`,
    ...s.health.issues.map((i) => `  [${i.severity}] ${i.code}: ${i.message}`),
    ...(s.autoReloadLog.length
      ? ['Automatic reloads:', ...s.autoReloadLog.map((e) => `  ${e.at} ${e.outcome} (was ${e.from || 'unknown'})`)]
      : []),
    ...(s.recentEvents.length
      ? ['Recent events:', ...s.recentEvents.map((e) => `  ${e.timestamp} ${e.reason}`)]
      : []),
  ];
  return lines.join('\n');
}
