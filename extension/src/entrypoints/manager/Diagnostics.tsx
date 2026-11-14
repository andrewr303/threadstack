import React, { useCallback, useEffect, useState } from 'react';
import { BUILD_INFO } from '../../core/build-info.js';
import { captureMatchPatterns } from '../../core/providers.js';
import {
  AUTO_RELOAD_LOG_KEY,
  assessManifest,
  describeCaptureProbe,
  detectBrowser,
  extensionsPageUrl,
  formatDiagnosticsReport,
  reloadWouldHelp,
  type AutoReloadLogEntry,
  type CaptureCheckResult,
  type CaptureProbeReport,
  type DiagnosticsSnapshot,
} from '../../core/diagnostics.js';

function hasRuntime(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.getManifest);
}

function currentBrowser() {
  const uaData = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } }).userAgentData;
  return detectBrowser(navigator.userAgent, uaData?.brands ?? []);
}

/** Snapshot of build vs running manifest, plus recent service-worker events. */
export function useDiagnostics(): { snapshot: DiagnosticsSnapshot | null; refresh: () => void } {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);

  const refresh = useCallback(() => {
    if (!hasRuntime()) return;
    void (async () => {
      const browser = currentBrowser();
      const sidePanelApi = Boolean(chrome.sidePanel?.open);
      const health = assessManifest(chrome.runtime.getManifest(), BUILD_INFO, { hasSidePanelApi: sidePanelApi, browser });
      let autoReloadLog: AutoReloadLogEntry[] = [];
      try {
        const stored = await chrome.storage.local.get(AUTO_RELOAD_LOG_KEY);
        const raw = stored?.[AUTO_RELOAD_LOG_KEY];
        if (Array.isArray(raw)) autoReloadLog = raw as AutoReloadLogEntry[];
      } catch {
        // storage unavailable in this context
      }
      let recentEvents: DiagnosticsSnapshot['recentEvents'] = [];
      try {
        const resp = (await chrome.runtime.sendMessage({ type: 'GET_DIAGNOSTICS' })) as
          | { ok?: boolean; recentEvents?: DiagnosticsSnapshot['recentEvents'] }
          | undefined;
        if (resp?.ok && Array.isArray(resp.recentEvents)) recentEvents = resp.recentEvents;
      } catch {
        // service worker not reachable (e.g. mid-reload)
      }
      setSnapshot({
        build: BUILD_INFO,
        extensionId: chrome.runtime.id,
        browser,
        userAgent: navigator.userAgent,
        health,
        sidePanelApi,
        autoReloadLog,
        recentEvents,
      });
    })();
  }, []);

  useEffect(refresh, [refresh]);
  return { snapshot, refresh };
}

function reloadExtension(): void {
  try {
    chrome.runtime.reload();
  } catch {
    // reload unavailable (tests); nothing else to do
  }
}

function openExtensionsPage(snapshot: DiagnosticsSnapshot): void {
  const url = extensionsPageUrl(snapshot.browser, snapshot.extensionId);
  try {
    void chrome.tabs.create({ url });
  } catch {
    // tabs API unavailable in this context
  }
}

/** Shown above the library when the browser runs an older manifest than the code on disk. */
export function StaleBuildBanner({ snapshot }: { snapshot: DiagnosticsSnapshot | null }) {
  if (!snapshot || !reloadWouldHelp(snapshot.health)) return null;
  const issue = snapshot.health.issues.find((i) => i.code === 'stale_manifest') ?? snapshot.health.issues[0];
  return (
    <div className="tk-banner" data-tone="danger" role="alert" data-testid="stale-build-banner">
      <div className="tk-banner-body">
        <strong>Threadkeeper needs a reload</strong>
        <span>{issue.message}</span>
      </div>
      <button type="button" className="tk-btn tk-btn-primary" onClick={reloadExtension}>
        Reload extension
      </button>
    </div>
  );
}

/** Ask the reader in the most recently used AI tab what a capture would see, without storing anything. */
async function probeAiTab(): Promise<CaptureProbeReport | null> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query) return null;
  const tabs = (await chrome.tabs.query({ url: captureMatchPatterns() })).filter((t) => typeof t.id === 'number');
  tabs.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const tab = tabs[0];
  if (!tab || typeof tab.id !== 'number') return null;
  try {
    const reply = (await chrome.tabs.sendMessage(tab.id, { type: 'TK_CAPTURE_PROBE' })) as { ok?: boolean; report?: CaptureProbeReport } | undefined;
    return reply?.ok && reply.report ? reply.report : null;
  } catch {
    return null;
  }
}

/** "Check capture": what Threadkeeper sees in the AI tab you used last, with a verdict and a copyable report. */
export function CaptureCheck() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CaptureCheckResult | null>(null);
  const [copied, setCopied] = useState(false);

  const run = async () => {
    setBusy(true);
    setCopied(false);
    try {
      setResult(describeCaptureProbe(await probeAiTab()));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(['Threadkeeper capture check', result.verdict, ...result.lines].join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="tk-diag-capture">
      <p className="tk-settings-note">
        Open a conversation on an AI site, then check what Threadkeeper can read from the tab you used last. The report has
        counts only, never titles or message text.
      </p>
      <div className="tk-diag-actions">
        <button type="button" className="tk-btn" disabled={busy} onClick={() => void run()}>
          {busy ? 'Checking…' : 'Check capture in my AI tab'}
        </button>
        {result && (
          <button type="button" className="tk-btn" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy report'}
          </button>
        )}
      </div>
      {result && (
        <>
          <div className="tk-diag-status" data-ok={result.ok ? 'true' : 'false'} role="status">
            {result.verdict}
          </div>
          <ul className="tk-diag-issues">
            {result.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function DiagnosticsPanel({ snapshot, onRefresh }: { snapshot: DiagnosticsSnapshot | null; onRefresh: () => void }) {
  const [copied, setCopied] = useState(false);
  if (!snapshot) {
    return <p className="tk-settings-note">Diagnostics are available when Threadkeeper runs as an installed extension.</p>;
  }
  const { health } = snapshot;
  const rows: Array<[string, React.ReactNode]> = [
    ['Files on disk', <code key="disk">{snapshot.build.versionName}</code>],
    [
      'Running manifest',
      <code key="run" data-mismatch={health.runningVersionName !== health.expectedVersionName ? 'true' : undefined}>
        {health.runningVersionName || 'unknown'}
      </code>,
    ],
    ['Extension ID', <code key="id">{snapshot.extensionId}</code>],
    ['Browser', snapshot.browser],
    ['Side panel', snapshot.sidePanelApi ? 'Available' : 'Not supported by this browser build'],
  ];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatDiagnosticsReport(snapshot));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="tk-diag" data-testid="diagnostics-panel">
      <div className="tk-diag-status" data-ok={health.ok ? 'true' : 'false'} role="status">
        {health.ok
          ? 'Everything checks out. The running manifest matches the files on disk.'
          : 'Threadkeeper found a problem that can block its pages. Details below.'}
      </div>
      <dl className="tk-diag-grid">
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {health.issues.length > 0 && (
        <ul className="tk-diag-issues">
          {health.issues.map((issue) => (
            <li key={issue.code} data-severity={issue.severity}>
              <strong>{issue.severity === 'error' ? 'Problem' : 'Note'}:</strong> {issue.message}
              <span className="tk-diag-fix">{issue.fix}</span>
            </li>
          ))}
        </ul>
      )}
      {snapshot.autoReloadLog.length > 0 && (
        <details className="tk-diag-log">
          <summary>Automatic reloads ({snapshot.autoReloadLog.length})</summary>
          <ul>
            {snapshot.autoReloadLog.map((e) => (
              <li key={`${e.at}-${e.outcome}`}>
                <span className="tk-tabular">{e.at.replace('T', ' ').slice(0, 19)}</span> ·{' '}
                {e.outcome === 'reloading' ? 'reloaded to pick up the new manifest' : 'skipped (already tried for this build)'}
              </li>
            ))}
          </ul>
        </details>
      )}
      {snapshot.recentEvents.length > 0 && (
        <details className="tk-diag-log">
          <summary>Recent events ({snapshot.recentEvents.length})</summary>
          <ul>
            {snapshot.recentEvents.map((e, i) => (
              <li key={`${e.timestamp}-${i}`}>
                <span className="tk-tabular">{e.timestamp.replace('T', ' ').slice(0, 19)}</span> · {e.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="tk-diag-actions">
        <button type="button" className={`tk-btn${reloadWouldHelp(health) ? ' tk-btn-primary' : ''}`} onClick={reloadExtension}>
          Reload extension
        </button>
        <button type="button" className="tk-btn" onClick={() => openExtensionsPage(snapshot)}>
          Open extensions page
        </button>
        <button type="button" className="tk-btn" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy report'}
        </button>
        <button type="button" className="tk-btn" onClick={onRefresh}>
          Check again
        </button>
      </div>
      <p className="tk-settings-note">
        The report lists versions, the browser and recent events only. It never includes API keys or thread content.
      </p>
      <h4 className="tk-brief-ws-h">Capture check</h4>
      <CaptureCheck />
    </div>
  );
}
