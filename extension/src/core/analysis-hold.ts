import type { ThreadStackDB } from './db.js';

/** pipeline.ts's job type for thread analysis (not imported: pipeline imports this module). */
const ANALYZE_JOB = 'analyze_thread';

/**
 * While an online import runs, hosted (Claude) analysis waits. Each imported thread is still
 * organized on-device at once and its analysis job is queued as usual; only the leasing of jobs
 * is held back, so the import does not compete with analysis for the worker and the daily limit,
 * and a thread is not billed while more of the run is still arriving.
 *
 * The hold is a row in the database, not worker memory, so it holds for the manager page's own
 * analysis runner too, and across a worker restart. It cannot hold forever: the run renews it
 * while it is alive, a hold not renewed for HOLD_STALE_MS no longer counts, and a worker that
 * starts and finds the run it belonged to dead releases it (sync-orchestrator.ts recover).
 */

export const ANALYSIS_HOLD_KEY = 'analysis.importHold';
/** A run renews its hold at least every 30 s while alive; this is far past any gap between renewals. */
export const HOLD_STALE_MS = 10 * 60_000;
/** What an analysis runner reports when it stopped because of the hold. */
export const ANALYSIS_HELD_REASON = 'Waiting for the online import to finish.';

export interface AnalysisHold {
  runId: string;
  /** When the run began: analysis queued or re-queued from then on was waiting for it. */
  since: string;
  heartbeatAt: string;
}

function readHold(value: unknown): AnalysisHold | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.runId !== 'string' || typeof v.since !== 'string' || typeof v.heartbeatAt !== 'string') return null;
  return { runId: v.runId, since: v.since, heartbeatAt: v.heartbeatAt };
}

export async function holdAnalysis(db: ThreadStackDB, runId: string, nowMs: number): Promise<void> {
  const at = new Date(nowMs).toISOString();
  await db.kv.put({ key: ANALYSIS_HOLD_KEY, value: { runId, since: at, heartbeatAt: at } satisfies AnalysisHold, updatedAt: at });
}

/** Renew the run's hold; a hold that belongs to another run is left alone. */
export async function touchAnalysisHold(db: ThreadStackDB, runId: string, nowMs: number): Promise<void> {
  await db.transaction('rw', db.kv, async () => {
    const hold = readHold((await db.kv.get(ANALYSIS_HOLD_KEY))?.value);
    if (!hold || hold.runId !== runId) return;
    const at = new Date(nowMs).toISOString();
    await db.kv.put({ key: ANALYSIS_HOLD_KEY, value: { ...hold, heartbeatAt: at } satisfies AnalysisHold, updatedAt: at });
  });
}

/** The hold in force now, or null when there is none or it went stale. */
export async function activeAnalysisHold(db: ThreadStackDB, nowMs: number): Promise<AnalysisHold | null> {
  const hold = readHold((await db.kv.get(ANALYSIS_HOLD_KEY))?.value);
  if (!hold) return null;
  const beat = Date.parse(hold.heartbeatAt);
  return Number.isFinite(beat) && nowMs - beat < HOLD_STALE_MS ? hold : null;
}

/**
 * End the hold of `runId` (or whatever hold there is, for null) and make every analysis job that
 * waited for it due now, so the threads the run imported or changed are analysed first thing.
 * Returns how many threads that is. Jobs queued before the run keep their own time.
 */
export async function releaseAnalysisHold(db: ThreadStackDB, runId: string | null, nowMs: number): Promise<number> {
  return db.transaction('rw', db.kv, db.jobs, async () => {
    const hold = readHold((await db.kv.get(ANALYSIS_HOLD_KEY))?.value);
    if (hold && runId !== null && hold.runId !== runId) return 0;
    if (hold) await db.kv.delete(ANALYSIS_HOLD_KEY);
    if (!hold) return 0;
    const nowIso = new Date(nowMs).toISOString();
    const jobs = await db.jobs.where('jobType').equals(ANALYZE_JOB).toArray();
    let queued = 0;
    for (const job of jobs) {
      if (job.status !== 'pending' || job.updatedAt < hold.since) continue;
      queued += 1;
      if ((job.notBefore ?? '') > nowIso) await db.jobs.put({ ...job, notBefore: nowIso, updatedAt: nowIso });
    }
    return queued;
  });
}
