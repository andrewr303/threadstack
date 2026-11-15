import { useRef, useState, type MutableRefObject } from 'react';
import type { ConversationRecord, SettingsRecord } from '../../../core/schema.js';
import { analyzeThreadRemotely, enqueueLibraryAnalysis, runAnalysisJobs } from '../../../core/pipeline.js';
import { dockSyncNow } from '../dock.js';
import { sharedDb } from '../shared.js';

export interface AnalysisProgress {
  running: boolean;
  processed: number;
  analyzed: number;
  current: string | null;
  note: string | null;
}

export interface AnalysisRunnerOptions {
  /** False while an overlay's handshake is not redeemed. */
  authorized: () => boolean;
  settings: SettingsRecord | null;
  /** An Anthropic key is set. */
  aiReady: boolean;
  /** The open thread, for "Analyze this thread". */
  selectedConversation: ConversationRecord | null;
  selectedKeyRef: MutableRefObject<string | null>;
  reloadAll: (preserveSelectionKey?: string | null) => Promise<void>;
  persistSettingPatch: (patch: Partial<SettingsRecord>) => Promise<void>;
  onAnnounce: (message: string) => void;
  /** Hosted analysis needs a key or embedding provider; send the user to Settings. */
  onOpenSettings: () => void;
}

/** Claude analysis in this page: the queue runner with progress and cancel, and the single-thread analyze. */
export function useAnalysisRunner({
  authorized,
  settings,
  aiReady,
  selectedConversation,
  selectedKeyRef,
  reloadAll,
  persistSettingPatch,
  onAnnounce,
  onOpenSettings,
}: AnalysisRunnerOptions) {
  const [analysis, setAnalysis] = useState<AnalysisProgress>({ running: false, processed: 0, analyzed: 0, current: null, note: null });
  const [analyzingThread, setAnalyzingThread] = useState<string | null>(null);
  const analysisAbortRef = useRef<AbortController | null>(null);

  const startAnalysis = async (options: { enqueueAll?: boolean } = {}) => {
    if (!authorized() || analysis.running) return;
    if (!settings || (!aiReady && settings.embeddingProvider === 'local')) {
      onOpenSettings();
      return;
    }
    if (options.enqueueAll) await enqueueLibraryAnalysis(sharedDb, { onlyMissing: true });
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    setAnalysis({ running: true, processed: 0, analyzed: 0, current: null, note: null });
    let lastReload = Date.now();
    const analyzedKeys: string[] = [];
    const summary = await runAnalysisJobs(sharedDb, {
      maxJobs: 2000,
      signal: controller.signal,
      onJobDone: (threadKey, status) => {
        if (status !== 'skipped') analyzedKeys.push(threadKey);
      },
      onProgress: (s, current) => {
        setAnalysis({ running: true, processed: s.processed, analyzed: s.analyzed, current, note: null });
        if (Date.now() - lastReload > 4000) {
          lastReload = Date.now();
          void reloadAll(selectedKeyRef.current);
        }
      },
    });
    analysisAbortRef.current = null;
    dockSyncNow(analyzedKeys);
    setAnalysis({
      running: false,
      processed: summary.processed,
      analyzed: summary.analyzed,
      current: null,
      note: summary.stoppedReason,
    });
    onAnnounce(
      `Claude analyzed ${summary.analyzed} thread(s)${summary.stoppedReason ? ` — ${summary.stoppedReason}` : ''}.`
    );
    await reloadAll(selectedKeyRef.current);
  };

  const analyzeSelected = async () => {
    if (!selectedConversation || !authorized()) return;
    setAnalyzingThread(selectedConversation.threadKey);
    try {
      const res = await analyzeThreadRemotely(sharedDb, selectedConversation.threadKey, { ignoreDailyLimit: true });
      if (res.status !== 'skipped') dockSyncNow([selectedConversation.threadKey]);
      onAnnounce(res.status === 'skipped' ? `Skipped: ${res.reason}` : 'Thread analyzed by Claude.');
    } catch (err) {
      onAnnounce(`Analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      if (settings) await persistSettingPatch({ lastAiError: err instanceof Error ? err.message : String(err), lastAiErrorAt: new Date().toISOString() });
    } finally {
      setAnalyzingThread(null);
      await reloadAll(selectedConversation.threadKey);
    }
  };

  const stopAnalysis = () => analysisAbortRef.current?.abort();

  return { analysis, analyzingThread, startAnalysis, analyzeSelected, stopAnalysis };
}
