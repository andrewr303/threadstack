import type { MutableRefObject } from 'react';
import { getDisplayTitle, type ConversationRecord, type WorkflowState } from '../../../core/schema.js';
import { deleteConversationCascade, updateManualThreadFields } from '../../../core/db.js';
import { normalizeTags } from '../../../core/organization.js';
import { requestThreadEnrichment } from '../../../core/cloud-client.js';
import { dockSyncNow } from '../dock.js';
import { sharedDb } from '../shared.js';

export interface ThreadActionsOptions {
  /** False while an overlay's handshake is not redeemed. */
  authorized: () => boolean;
  /** The open thread; every edit below applies to it. */
  selectedConversation: ConversationRecord | null;
  titleDraft: string;
  notesDraft: string;
  tagInputDraft: string;
  handshakeToken: string;
  selectedKeyRef: MutableRefObject<string | null>;
  reloadAll: (preserveSelectionKey?: string | null) => Promise<void>;
  onAnnounce: (message: string) => void;
  /** A project was created: the "+ New project" form closes. */
  onProjectCreated: () => void;
}

/** Edits to the open thread and library (overrides, project, status, delete, new project, enrichment) and opening the original. */
export function useThreadActions({
  authorized,
  selectedConversation,
  titleDraft,
  notesDraft,
  tagInputDraft,
  handshakeToken,
  selectedKeyRef,
  reloadAll,
  onAnnounce,
  onProjectCreated,
}: ThreadActionsOptions) {
  const saveManualEdits = async () => {
    if (!authorized() || !selectedConversation) return;
    const parsedTags = normalizeTags(tagInputDraft.split(',').map((s) => s.trim()).filter(Boolean));
    await updateManualThreadFields(sharedDb, selectedConversation.threadKey, {
      manualTitleOverride:
        titleDraft.trim() && titleDraft.trim() !== selectedConversation.title ? titleDraft.trim() : null,
      manualNotes: notesDraft,
      manualTags: parsedTags,
    });
    dockSyncNow([selectedConversation.threadKey]);
    await reloadAll(selectedConversation.threadKey);
    onAnnounce('Saved manual title, tags, and notes.');
  };

  const changeProject = async (nextProject: string) => {
    if (!authorized() || !selectedConversation) return;
    await updateManualThreadFields(sharedDb, selectedConversation.threadKey, { project: nextProject, categoryLocked: true });
    // The new project may be local-only.
    dockSyncNow([selectedConversation.threadKey], { privacy: true });
    await reloadAll(selectedConversation.threadKey);
    onAnnounce(`Filed under ${nextProject} (locked).`);
  };

  const toggleLock = async (locked: boolean) => {
    if (!authorized() || !selectedConversation) return;
    await updateManualThreadFields(sharedDb, selectedConversation.threadKey, { categoryLocked: locked });
    await reloadAll(selectedConversation.threadKey);
  };

  const changeWorkflowState = async (nextState: WorkflowState) => {
    if (!authorized() || !selectedConversation) return;
    await updateManualThreadFields(sharedDb, selectedConversation.threadKey, { workflowState: nextState });
    dockSyncNow([selectedConversation.threadKey]);
    await reloadAll(selectedConversation.threadKey);
    onAnnounce(`Updated status to ${nextState}.`);
  };

  const deleteSelected = async () => {
    if (!authorized() || !selectedConversation) return;
    const deletedTitle = getDisplayTitle(selectedConversation);
    await deleteConversationCascade(sharedDb, selectedConversation.threadKey);
    dockSyncNow([selectedConversation.threadKey], { privacy: true });
    await reloadAll(null);
    onAnnounce(`Deleted "${deletedTitle}" and recorded tombstone.`);
  };

  const createProject = async (name: string) => {
    const clean = name.trim();
    if (!clean || !authorized()) return;
    if (!(await sharedDb.collections.get(clean))) {
      await sharedDb.collections.put({
        name: clean,
        description: '',
        isStarterArea: false,
        cloudExcluded: false,
        createdAt: new Date().toISOString(),
        keywords: [clean.toLowerCase()],
        origin: 'user',
      });
    }
    onProjectCreated();
    await reloadAll(selectedKeyRef.current);
    onAnnounce(`Created project ${clean}. Threads that mention it are filed there automatically.`);
  };

  const openOriginal = () => {
    if (!selectedConversation) return;
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'OPEN_ORIGINAL_THREAD',
        canonicalUrl: selectedConversation.canonicalUrl,
        provider: selectedConversation.provider,
        expectedAccountId: selectedConversation.accountId,
        expectedWorkspaceId: selectedConversation.workspaceId,
        handshakeToken,
      });
    } else {
      window.open(selectedConversation.canonicalUrl, '_blank');
    }
  };

  const setCloudExcluded = (threadKey: string, excluded: boolean) => {
    void updateManualThreadFields(sharedDb, threadKey, { cloudExcluded: excluded }).then(() => {
      // Local-only on: Still must drop its copy now; off: it may sync again.
      dockSyncNow([threadKey], { privacy: true });
      return reloadAll(threadKey);
    });
  };

  const enrich = (threadKey: string) => {
    void requestThreadEnrichment(sharedDb, threadKey).then((res) => {
      onAnnounce(
        res.status === 'rejected' ? `Cloud enrichment skipped: ${res.reason}` : `Cloud enrichment ${res.status}.`
      );
      void reloadAll(threadKey);
    });
  };

  return {
    saveManualEdits,
    changeProject,
    toggleLock,
    changeWorkflowState,
    deleteSelected,
    createProject,
    openOriginal,
    setCloudExcluded,
    enrich,
  };
}
