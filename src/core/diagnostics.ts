import { BUILD_INFO, type BuildInfo } from './build-info.js';

/**
 * Self-diagnosis for the "<id> is blocked · ERR_BLOCKED_BY_CLIENT" failure.
 *
 * Verified in Microsoft Edge 155: a manifest whose web_accessible_resources use
 * `use_dynamic_url` makes Edge refuse the static-ID manager URL, including the
 * full-page library the extension opens itself. Edge reads manifest.json only
 * when an unpacked extension is (re)loaded, so rebuilding without pressing
 * Reload keeps the broken manifest live while the new JS and HTML on disk are
 * served. Pages compare the running manifest with the build they were compiled
 * from; the service worker, whose script is cached until reload, compares it
 * with build-info.json read from disk. Either repairs or explains the mismatch.
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

/**
 * The build whose files are on disk now. A service worker that started before
 * a rebuild keeps running its cached script (with the old BUILD_INFO), but a
 * no-store fetch of the packaged build-info.json returns the new file, so
 * comparing that with the running manifest catches a rebuild without Reload.
 */
export async function readDiskBuildInfo(
  url: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init)
): Promise<BuildInfo | null> {
  try {
    const res = await fetchImpl(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object') return null;
    const { version, versionName, buildId, builtAt } = data as Record<string, unknown>;
    if (typeof version !== 'string' || typeof versionName !== 'string' || typeof buildId !== 'string' || typeof builtAt !== 'string') {
      return null;
    }
    return { version, versionName, buildId, builtAt };
  } catch {
    return null;
  }
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

// ---------------------------------------------------------------------------
// Capture check
// ---------------------------------------------------------------------------

/** What the reader in a tab reports when asked what a capture would see (content.ts, TK_CAPTURE_PROBE). */
export interface CaptureProbeReport {
  url: string;
  provider: string | null;
  conversationId: string | null;
  domMessages: number;
  domRoles: Record<string, number>;
  siteDataMessages: number | null;
  lastCapture: { at: string; method: string; outcome: string; detail?: string; messages?: number } | null;
  error: string | null;
}

export interface CaptureCheckResult {
  ok: boolean;
  /** One plain sentence: what is wrong, or that capture works. */
  verdict: string;
  /** Facts for a copyable report. Counts and names only: no titles, no message text. */
  lines: string[];
}

/** The page's address with anything that identifies a conversation or account masked. */
function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{16,}/gi, '<id>')}`;
  } catch {
    return 'unknown page';
  }
}

/** Turn a probe into a verdict a person can act on, and the facts behind it. */
export function describeCaptureProbe(report: CaptureProbeReport | null): CaptureCheckResult {
  if (!report) {
    return {
      ok: false,
      verdict: 'Threadkeeper is not running in that tab. Reload the tab (the extension may have been reloaded after the page opened).',
      lines: ['Reader: no answer from the tab'],
    };
  }
  const last = report.lastCapture;
  const lines = [
    `Page: ${maskUrl(report.url)}`,
    `Site: ${report.provider ?? 'not an AI site Threadkeeper knows'}`,
    `Conversation open: ${report.conversationId ? 'yes' : 'no'}`,
    `Messages found in the page: ${report.domMessages}${report.domMessages ? ` (${Object.entries(report.domRoles).map(([r, n]) => `${n} ${r}`).join(', ')})` : ''}`,
    `Messages in the site's own data: ${report.siteDataMessages === null ? 'not received (it arrives when the page loads a conversation; reload the tab to capture it)' : report.siteDataMessages}`,
    `Last capture: ${last ? `${last.outcome} by ${last.method === 'site_data' ? 'site data' : 'page reading'}${last.messages !== undefined ? `, ${last.messages} messages` : ''}${last.detail ? ` (${last.detail})` : ''} at ${last.at.replace('T', ' ').slice(0, 19)}` : 'none yet'}`,
    ...(report.error ? [`Error while reading the page: ${report.error}`] : []),
  ];
  if (report.error) return { ok: false, verdict: 'Reading the page failed. Copy this report; the site may have changed its layout.', lines };
  if (!report.provider) return { ok: false, verdict: 'That tab is not a page Threadkeeper captures.', lines };
  if (!report.conversationId) return { ok: false, verdict: 'No conversation is open in that tab, so there is nothing to capture. Open one and check again.', lines };
  if (last?.outcome === 'skipped') {
    return { ok: false, verdict: `Capture is switched off for this site, or was refused (${last.detail ?? 'skipped'}). Check Settings → Capture.`, lines };
  }
  if (report.domMessages === 0 && !report.siteDataMessages) {
    return { ok: false, verdict: 'Threadkeeper found no messages on the page and received no conversation data from the site. Reload the tab and check again; if it stays empty, copy this report.', lines };
  }
  if (last?.outcome === 'error') return { ok: false, verdict: `The last capture did not reach the library (${last.detail ?? 'no detail'}).`, lines };
  if (report.siteDataMessages) return { ok: true, verdict: `Capture is working: the site's full conversation data (${report.siteDataMessages} messages) is being read.`, lines };
  return { ok: true, verdict: `Capture is reading the page (${report.domMessages} messages). For ChatGPT and Claude a reload also brings in the site's complete data.`, lines };
}
