import React from 'react';
import type { ChangeLogEntry, SettingsRecord } from '../../../core/schema.js';
import type { LibraryReconciledCounts } from '../../../core/db.js';
import type { AnalysisProgress } from '../hooks/useAnalysisRunner.js';

export interface HeaderBarProps {
  surface: 'overlay' | 'page' | 'sidepanel';
  /** Side panel: secondary actions fold into a "more" menu and the status chip drops below. */
  isCompact: boolean;
  settings: SettingsRecord | null;
  effectiveTheme: 'light' | 'dark';
  counts: LibraryReconciledCounts | null;
  /** Progress text for work running in this page; wins over the analysis states. */
  busy: string | null;
  analysis: AnalysisProgress;
  pendingAnalysis: number;
  aiReady: boolean;
  /** The latest organize change that can still be undone. */
  undoable: ChangeLogEntry | undefined;
  onToggleNav: () => void;
  onUndo: () => void | Promise<void>;
  onAutoOrganize: () => void | Promise<void>;
  onOpenOrganize: () => void;
  onOpenImport: () => void;
  onOpenSettings: () => void;
  onPatchSettings: (patch: Partial<SettingsRecord>) => Promise<void>;
  onOpenFullPage: () => void;
  onCloseOverlay: () => void;
  onRunAnalysis: () => void | Promise<void>;
  onStopAnalysis: () => void;
}

/** Title, library counts, background-work chip and the page-level actions. */
export function HeaderBar({
  surface,
  isCompact,
  settings,
  effectiveTheme,
  counts,
  busy,
  analysis,
  pendingAnalysis,
  aiReady,
  undoable,
  onToggleNav,
  onUndo,
  onAutoOrganize,
  onOpenOrganize,
  onOpenImport,
  onOpenSettings,
  onPatchSettings,
  onOpenFullPage,
  onCloseOverlay,
  onRunAnalysis,
  onStopAnalysis,
}: HeaderBarProps) {
  const isPage = surface === 'page';
  const analysisChip = (() => {
    if (busy) return <span className="tk-status-chip" data-tone="busy">{busy}</span>;
    if (analysis.running) {
      return (
        <span className="tk-status-chip" data-tone="busy">
          Claude analyzing… {analysis.analyzed} done{pendingAnalysis ? ` · ${pendingAnalysis} queued` : ''}
          <button type="button" className="tk-linklike" onClick={onStopAnalysis}>
            Stop
          </button>
        </span>
      );
    }
    if (settings?.lastAiError && pendingAnalysis > 0) {
      return (
        <button type="button" className="tk-status-chip" data-tone="warn" onClick={onOpenSettings} title={settings.lastAiError}>
          AI paused: {settings.lastAiError.slice(0, 60)}
        </button>
      );
    }
    if (pendingAnalysis > 0 && (aiReady || settings?.embeddingProvider !== 'local')) {
      return (
        <button type="button" className="tk-status-chip" onClick={() => void onRunAnalysis()}>
          {pendingAnalysis} queued for analysis · Run now
        </button>
      );
    }
    if (settings && !aiReady) {
      return (
        <button type="button" className="tk-status-chip" data-tone="quiet" onClick={onOpenSettings}>
          On-device analysis · Add Claude for deeper summaries
        </button>
      );
    }
    return null;
  })();

  const secondaryActions = (
    <>
      <button type="button" className="tk-btn" onClick={onOpenOrganize}>
        Organize…
      </button>
      <button type="button" className="tk-btn" onClick={onOpenImport}>
        Import / Export
      </button>
      {/* On the full page Settings and the theme are in the rail, and density is in Settings:
          repeating them here pushed the bar onto two rows. They stay in the markup. */}
      <button type="button" className="tk-btn" data-page-hidden={isPage ? 'true' : undefined} onClick={onOpenSettings}>
        Settings
      </button>
      <button
        type="button"
        className="tk-btn"
        data-page-hidden={isPage ? 'true' : undefined}
        aria-label="Toggle density"
        onClick={() => void onPatchSettings({ density: settings?.density === 'compact' ? 'comfortable' : 'compact' })}
      >
        {settings?.density === 'compact' ? 'Compact' : 'Comfortable'}
      </button>
      <button
        type="button"
        className="tk-btn"
        data-page-hidden={isPage ? 'true' : undefined}
        aria-label="Toggle color theme"
        onClick={() => void onPatchSettings({ theme: effectiveTheme === 'dark' ? 'light' : 'dark' })}
      >
        {effectiveTheme === 'dark' ? 'Dark' : 'Light'}
      </button>
    </>
  );

  return (
    // On the full page the header is the Threads view's glass bar: the brand and the collapse
    // button live in the rail, so the heading is only visually hidden and the toggle is hidden
    // (both stay in the markup). The side panel and the overlay render exactly as before.
    <header
      className={isPage ? 'tk-header tk-glass' : 'tk-header'}
      data-surface={isPage ? 'page' : undefined}
    >
      <div className="tk-header-left">
        <button
          type="button"
          className="tk-btn"
          aria-label="Toggle navigation rail"
          data-page-hidden={isPage ? 'true' : undefined}
          onClick={onToggleNav}
        >
          ☰
        </button>
        <h1 className="tk-h1" data-page-hidden={isPage ? 'visually' : undefined}>
          ThreadStack
        </h1>
        {counts && (
          <details className="tk-counts-details">
            <summary className="tk-counts-summary">
              {counts.totalThreads} threads · {counts.filedCount} filed · {counts.unfiledCount} unfiled
            </summary>
            <div className="tk-counts-popover">
              <strong>How these are counted</strong>
              <p style={{ margin: '6px 0 0' }}>
                Total ({counts.totalThreads}) equals filed ({counts.filedCount}) + unfiled ({counts.unfiledCount}).{' '}
                {counts.partialOrTitleOnlyCount} threads have partial or title-only DOM coverage;{' '}
                {counts.coverageCounts.full} have full export coverage.
                {counts.syntheticBenchmarkCount > 0
                  ? ` (${counts.syntheticBenchmarkCount} synthetic benchmark records isolated from user totals.)`
                  : ''}
              </p>
            </div>
          </details>
        )}
        {!isCompact && analysisChip}
      </div>

      <div className="tk-header-actions">
        {undoable && (
          <button type="button" className="tk-btn" onClick={() => void onUndo()}>
            Undo last change ({undoable.snapshots.length})
          </button>
        )}
        <button type="button" className="tk-btn tk-btn-primary" onClick={() => void onAutoOrganize()}>
          Auto-organize
        </button>
        {isCompact ? (
          <details className="tk-more-menu">
            <summary className="tk-btn" aria-label="More actions">
              ⋯
            </summary>
            <div className="tk-more-popover">
              {secondaryActions}
              <button type="button" className="tk-btn" onClick={onOpenFullPage}>
                Open full page ↗
              </button>
            </div>
          </details>
        ) : (
          secondaryActions
        )}
        {surface === 'overlay' && (
          <>
            <button type="button" className="tk-btn" onClick={onOpenFullPage}>
              Open full page ↗
            </button>
            <button type="button" className="tk-btn tk-btn-primary" aria-label="Close ThreadStack overlay" onClick={onCloseOverlay}>
              Close
            </button>
          </>
        )}
      </div>
      {isCompact && analysisChip && <div className="tk-header-status">{analysisChip}</div>}
    </header>
  );
}
