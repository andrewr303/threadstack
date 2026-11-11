// What every workspace view can reach without prop threading: the controller, the library data
// the views draw sessions from, and the few actions that cross views (open a session, add an
// account, open Settings). App.tsx provides it; on the side panel and the in-page overlay the
// workspace inside it is simply not enabled.
import React, { createContext, useContext } from 'react';
import type {
  ConversationRecord,
  DetailMode,
  SettingsRecord,
  StructuredSummaryRecord,
  ThreadInsight,
} from '../../../core/schema.js';
import type { RealmInfo } from '../../../core/workspace/realms.js';
import type { AccountRecord, WorkspaceView } from '../../../core/workspace/types.js';
import type { SectionId } from '../SettingsDialog.js';
import type { WorkspaceController } from './useWorkspace.js';

export interface ThreadAccount {
  realm: RealmInfo | null;
  /** The account the thread was captured under; null when it was removed or the provider has none. */
  account: AccountRecord | null;
  /** Whether that account is the one signed in to its realm right now. */
  active: boolean;
  /** Whether Threadkeeper can switch this realm's accounts at all. */
  switchable: boolean;
}

export interface WorkspaceContextValue {
  surface: 'overlay' | 'page' | 'sidepanel';
  workspace: WorkspaceController;
  settings: SettingsRecord | null;
  patchSettings: (patch: Partial<SettingsRecord>) => Promise<void>;
  view: WorkspaceView;
  setView: (view: WorkspaceView) => void;
  detailMode: DetailMode;
  setDetailMode: (mode: DetailMode) => void;
  conversations: readonly ConversationRecord[];
  conversationByKey: ReadonlyMap<string, ConversationRecord>;
  insightsByThread: ReadonlyMap<string, ThreadInsight>;
  summariesByThread: ReadonlyMap<string, StructuredSummaryRecord>;
  /** Thread open in the Threads view. */
  selectedThreadKey: string | null;
  accountOfThread: (conv: Pick<ConversationRecord, 'provider' | 'accountId'>) => ThreadAccount;
  /**
   * Show a session where the person is working: a tab in Browse, the selection in Threads, the
   * focused pane in Dashboard. `where` forces a view (and switches to it).
   */
  openSession: (conv: ConversationRecord, where?: WorkspaceView) => void;
  /** Pin to or unpin from the Dashboard. */
  togglePinned: (conv: ConversationRecord) => Promise<void>;
  openInChromeTab: (url: string) => void;
  /** Open the "Add account" dialog, optionally for one sign-in. */
  requestAddAccount: (realmId?: string) => void;
  openSettings: (section?: SectionId) => void;
  /** Say something through the page's polite live region. */
  announce: (message: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ value, children }: { value: WorkspaceContextValue; children: React.ReactNode }) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspaceContext(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspaceContext must be used inside WorkspaceProvider');
  return value;
}

/** For components that also render outside the workspace (tests of a single component). */
export function useOptionalWorkspaceContext(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext);
}
