import React from 'react';
import { isFinishedStatus, type SyncProviderState, type SyncState } from '../../core/history-sync.js';

/**
 * Live progress of an online import: one row per site with the step it is on, what it found and
 * imported, and a bar that is exact when the total is known and indeterminate when it is not.
 *
 * Accessibility: each bar is role="progressbar" with its numbers in aria-valuetext (and no
 * aria-valuenow while the total is unknown, which is how an indeterminate bar is announced). The
 * counts change several times a second, so they are not in a live region; a separate polite
 * status region announces only step changes and the end of the run.
 */

const STEPS: Partial<Record<SyncProviderState['status'], { n: number; label: string }>> = {
  opening: { n: 1, label: 'Opening the site' },
  account: { n: 2, label: 'Checking which account is signed in' },
  listing: { n: 3, label: 'Finding conversations' },
  fetching: { n: 4, label: 'Importing' },
};
const STEP_COUNT = 4;

export interface ProviderProgress {
  /** Short words for the step, e.g. "Step 4 of 4: Importing". */
  step: string;
  /** Counts in words, or the reason it stopped. */
  detail: string;
  /** Null while the total is unknown (indeterminate). */
  value: number | null;
  max: number | null;
  /** What a screen reader hears for the bar. */
  valueText: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function processedOf(p: SyncProviderState): number {
  return p.stored + p.skipped + p.failed;
}

function countsText(p: SyncProviderState): string {
  const parts = [`${p.stored} imported`];
  if (p.skipped) parts.push(`${p.skipped} already up to date`);
  if (p.failed) parts.push(`${p.failed} could not be read`);
  return parts.join(', ');
}

export function describeProviderProgress(p: SyncProviderState): ProviderProgress {
  const step = STEPS[p.status];
  if (step) {
    const stepText = `Step ${step.n} of ${STEP_COUNT}: ${step.label}`;
    if (p.status === 'fetching' && p.listed > 0) {
      const done = Math.min(processedOf(p), p.listed);
      return {
        step: stepText,
        detail: `${done} of ${p.listed} read. ${countsText(p)}.`,
        value: done,
        max: p.listed,
        valueText: `${done} of ${p.listed} threads read, ${p.stored} imported`,
      };
    }
    const found = p.listed > 0 ? `${plural(p.listed, 'conversation')} found so far.` : p.status === 'listing' ? 'Counting conversations.' : '';
    const so = processedOf(p) > 0 ? ` ${countsText(p)}.` : '';
    return {
      step: stepText,
      detail: `${found}${so}`.trim(),
      value: null,
      max: null,
      valueText: `${step.label}${p.listed > 0 ? `, ${plural(p.listed, 'conversation')} found` : ''}`,
    };
  }
  switch (p.status) {
    case 'queued':
      return { step: 'Waiting for the sites before it', detail: '', value: 0, max: 1, valueText: 'Waiting' };
    case 'done': {
      const total = Math.max(processedOf(p), p.listed, 1);
      return {
        step: 'Done',
        detail: `${countsText(p)}.${p.message ? ` ${p.message}` : ''}`,
        value: total,
        max: total,
        valueText: `Done, ${p.stored} imported`,
      };
    }
    case 'cancelled':
      return { step: 'Cancelled', detail: `${p.stored} imported so far.`, value: processedOf(p), max: Math.max(p.listed, processedOf(p), 1), valueText: `Cancelled, ${p.stored} imported` };
    case 'error':
    default:
      return {
        step: 'Stopped',
        detail: `${p.message ?? 'Something went wrong.'}${processedOf(p) > 0 ? ` ${countsText(p)}.` : ''}`,
        value: processedOf(p),
        max: Math.max(p.listed, processedOf(p), 1),
        valueText: `Stopped, ${p.stored} imported`,
      };
  }
}

/** What the status region says: the step of each site, then the outcome. Counts are left out. */
export function importAnnouncement(state: SyncState): string {
  if (state.providers.length === 0) return '';
  if (state.running) {
    const current = state.providers.find((p) => !isFinishedStatus(p.status) && p.status !== 'queued');
    if (!current) return 'Import starting.';
    return `Importing from ${current.label}: ${STEPS[current.status]?.label ?? 'working'}.`;
  }
  const stored = state.providers.reduce((n, p) => n + p.stored, 0);
  const stopped = state.providers.filter((p) => p.status === 'error').map((p) => p.label);
  return `Import finished: ${plural(stored, 'thread')} imported.${stopped.length ? ` Stopped early: ${stopped.join(', ')}.` : ''}`;
}

/** Totals across sites for the heading line. */
export function importTotals(state: SyncState): { found: number; imported: number; read: number; totalKnown: boolean } {
  let found = 0;
  let imported = 0;
  let read = 0;
  let totalKnown = true;
  for (const p of state.providers) {
    found += p.listed;
    imported += p.stored;
    read += processedOf(p);
    if (!isFinishedStatus(p.status) && p.status !== 'fetching') totalKnown = false;
  }
  return { found, imported, read, totalKnown };
}

function Bar({ progress, label }: { progress: ProviderProgress; label: string }) {
  const indeterminate = progress.value === null || progress.max === null;
  const pct = indeterminate ? 0 : Math.round((Math.min(progress.value!, progress.max!) / Math.max(progress.max!, 1)) * 100);
  return (
    <div
      className="tk-progress"
      role="progressbar"
      aria-label={`${label} progress`}
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : progress.max!}
      aria-valuenow={indeterminate ? undefined : progress.value!}
      aria-valuetext={progress.valueText}
      data-indeterminate={indeterminate ? 'true' : undefined}
    >
      <span className="tk-progress-fill" style={indeterminate ? undefined : { transform: `scaleX(${pct / 100})` }} />
    </div>
  );
}

export function ImportProgress({ state, analysisLeft }: { state: SyncState; analysisLeft: number | null }) {
  if (state.providers.length === 0) return null;
  const totals = importTotals(state);
  const analysis = state.analysis && state.analysis.queued > 0 ? state.analysis : null;
  const analysing = analysis !== null && (analysisLeft === null || analysisLeft > 0);
  const analysedDone = analysis ? Math.max(0, analysis.queued - Math.min(analysisLeft ?? analysis.queued, analysis.queued)) : 0;
  return (
    <div className="tk-import-progress" data-testid="import-progress">
      <p className="tk-import-total">
        {state.running
          ? totals.totalKnown && totals.found > 0
            ? `Importing: ${totals.read} of ${totals.found} threads read, ${totals.imported} imported.`
            : `Importing: ${plural(totals.found, 'thread')} found so far, ${totals.imported} imported.`
          : `Import finished: ${plural(totals.imported, 'thread')} imported.`}
      </p>
      <ul className="tk-sync-list" aria-label="Import progress by site">
        {state.providers.map((p) => {
          const progress = describeProviderProgress(p);
          return (
            <li key={p.provider} data-status={p.status}>
              <span className="tk-sync-name">{p.label}</span>
              <span className="tk-sync-status">
                <span className="tk-sync-step">{progress.step}</span>
                {progress.detail && <span className="tk-sync-detail">{progress.detail}</span>}
                {p.account && <span className="tk-sync-account">Filed under {p.account}</span>}
              </span>
              <Bar progress={progress} label={p.label} />
            </li>
          );
        })}
        {analysis && (
          <li data-status={analysing ? 'fetching' : 'done'} data-testid="import-analysis">
            <span className="tk-sync-name">Analysis</span>
            <span className="tk-sync-status">
              <span className="tk-sync-step">
                {analysing ? `Analyzing ${plural(analysis.queued, 'thread')}` : `Analyzed ${plural(analysis.queued, 'thread')}`}
              </span>
              <span className="tk-sync-detail">
                {analysing ? 'Runs after the import, a few at a time, up to your daily limit.' : 'Summaries and filing are up to date.'}
              </span>
            </span>
            <Bar
              label="Analysis"
              progress={{
                step: '',
                detail: '',
                value: analysisLeft === null ? null : analysedDone,
                max: analysisLeft === null ? null : analysis.queued,
                valueText: analysisLeft === null ? `Analyzing ${plural(analysis.queued, 'thread')}` : `${analysedDone} of ${analysis.queued} analyzed`,
              }}
            />
          </li>
        )}
      </ul>
      <p className="tk-visually-hidden" role="status" aria-live="polite">
        {importAnnouncement(state)}
        {analysis && !state.running ? ` Analyzing ${plural(analysis.queued, 'thread')} next.` : ''}
      </p>
    </div>
  );
}
