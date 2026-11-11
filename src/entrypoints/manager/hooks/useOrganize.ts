import { useState, type MutableRefObject } from 'react';
import type { ChangeLogEntry, CollectionRecord, ConversationRecord, SettingsRecord, ThreadInsight } from '../../../core/schema.js';
import {
  applyOrganizeProposals,
  previewNaturalLanguageOrganize,
  undoChangeLog,
  type OrganizeProposalItem,
} from '../../../core/organization.js';
import { planLibraryOrganization } from '../../../core/library-organize.js';
import { processThreadsLocally } from '../../../core/pipeline.js';
import { dockSyncNow } from '../dock.js';
import { openModal, sharedDb } from '../shared.js';

export interface OrganizeOptions {
  dialogRef: MutableRefObject<HTMLDialogElement | null>;
  /** False while an overlay's handshake is not redeemed. */
  authorized: () => boolean;
  settings: SettingsRecord | null;
  conversations: ConversationRecord[];
  collections: CollectionRecord[];
  insightsByThread: Map<string, ThreadInsight>;
  changeLogs: ChangeLogEntry[];
  /** An Anthropic key is set. */
  aiReady: boolean;
  selectedKeyRef: MutableRefObject<string | null>;
  reloadAll: (preserveSelectionKey?: string | null) => Promise<void>;
  startAnalysis: (options?: { enqueueAll?: boolean }) => Promise<void>;
  onAnnounce: (message: string) => void;
}

/** Organize: a keyword preview or a planned set of proposals to review, apply and undo, and the one-click auto-organize. */
export function useOrganize({
  dialogRef,
  authorized,
  settings,
  conversations,
  collections,
  insightsByThread,
  changeLogs,
  aiReady,
  selectedKeyRef,
  reloadAll,
  startAnalysis,
  onAnnounce,
}: OrganizeOptions) {
  const [instruction, setInstruction] = useState('');
  const [proposals, setProposals] = useState<OrganizeProposalItem[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [deselected, setDeselected] = useState<Set<string>>(new Set());

  const localPreview = (instruction: string) => {
    const extraText = new Map<string, string>();
    for (const [k, i] of insightsByThread) extraText.set(k, `${i.gist} ${i.summary} ${i.topics.join(' ')}`);
    return previewNaturalLanguageOrganize(instruction, conversations, { collections, extraText });
  };

  const openOrganize = () => {
    setProposals(instruction.trim() ? localPreview(instruction) : []);
    setNotes([]);
    setDeselected(new Set());
    openModal(dialogRef);
  };

  const planOrganize = async (preferAi: boolean) => {
    setBusy(preferAi ? 'Claude is planning…' : 'Planning…');
    try {
      const plan = await planLibraryOrganization(sharedDb, { instruction: instruction, preferAi });
      setProposals(plan.proposals);
      setNotes(plan.notes);
      setDeselected(new Set());
    } catch (err) {
      setNotes([`Planning failed: ${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      setBusy(null);
    }
  };

  const changeInstruction = (value: string) => {
    setInstruction(value);
    setProposals(value.trim() ? localPreview(value) : []);
    setNotes([]);
  };

  const previewKeywords = () => {
    setProposals(instruction.trim() ? localPreview(instruction) : []);
    setNotes(['Keyword preview.']);
  };

  const toggleProposal = (threadKey: string, included: boolean) =>
    setDeselected((prev) => {
      const next = new Set(prev);
      if (included) next.delete(threadKey);
      else next.add(threadKey);
      return next;
    });

  const autoOrganize = async () => {
    if (!authorized()) return;
    setInstruction('');
    setProposals([]);
    setNotes([]);
    setDeselected(new Set());
    openModal(dialogRef);
    setBusy('Analyzing every thread on-device…');
    const keys = conversations.filter((c) => !c.isSyntheticBenchmark).map((c) => c.threadKey);
    const local = await processThreadsLocally(sharedDb, keys, {
      aiDelaySeconds: 0,
      onProgress: (done, total) => setBusy(`Analyzing ${done}/${total} threads on-device…`),
    });
    // Automatic filing can move threads into local-only projects.
    dockSyncNow(keys, { privacy: true });
    await reloadAll(selectedKeyRef.current);
    setBusy(aiReady ? 'Claude is planning projects for your library…' : 'Grouping similar threads…');
    try {
      const plan = await planLibraryOrganization(sharedDb, { preferAi: aiReady });
      setProposals(plan.proposals);
      setNotes([
        `Filed ${local.filed} thread(s) automatically while analyzing${local.createdProjects.length ? `; created ${local.createdProjects.join(', ')}` : ''}.`,
        ...plan.notes,
      ]);
    } catch (err) {
      setNotes([`Planning failed: ${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      setBusy(null);
    }
    if (aiReady && settings?.autoOrganize.aiAnalysis) void startAnalysis({ enqueueAll: true });
  };

  const applyProposals = async () => {
    if (!authorized()) return;
    const chosen = proposals.filter((p) => p.excludedByInstruction || !deselected.has(p.threadKey));
    const entry = await applyOrganizeProposals(
      sharedDb,
      instruction.trim() || 'Auto-organize library',
      chosen
    );
    dialogRef.current?.close();
    dockSyncNow(
      entry.snapshots.map((snap) => snap.threadKey),
      { privacy: true }
    );
    await reloadAll(selectedKeyRef.current);
    onAnnounce(`Applied organization to ${entry.snapshots.length} conversations.`);
  };

  const undoLast = async () => {
    if (!authorized()) return;
    const latestActive = changeLogs.find((c) => !c.undone);
    if (!latestActive) return;
    const res = await undoChangeLog(sharedDb, latestActive.changeId);
    if (res.restoredCount > 0) dockSyncNow(latestActive.snapshots.map((snap) => snap.threadKey), { privacy: true });
    await reloadAll(selectedKeyRef.current);
    onAnnounce(`Undid changes across ${res.restoredCount} threads.`);
  };

  return {
    instruction,
    proposals,
    notes,
    busy,
    deselected,
    openOrganize,
    planOrganize,
    changeInstruction,
    previewKeywords,
    toggleProposal,
    autoOrganize,
    applyProposals,
    undoLast,
  };
}
