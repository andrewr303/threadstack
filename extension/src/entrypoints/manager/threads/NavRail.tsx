import React, { useMemo } from 'react';
import type { CollectionRecord, ConversationRecord, ResurfaceQueue, StructuredSummaryRecord } from '../../../core/schema.js';
import type { LibraryReconciledCounts } from '../../../core/db.js';
import { computeResurfacingQueueItems } from '../../../core/organization.js';
import { repositoryEntries } from './grouping.js';

const RESURFACE_QUEUE_LABELS: Record<ResurfaceQueue, string> = {
  continue_working: 'Continue working',
  needs_review: 'Needs review',
  waiting: 'Waiting',
  recently_changed: 'Recently changed',
  unfiled: 'Unfiled',
  worth_revisiting: 'Worth revisiting',
};

export interface NavRailProps {
  /** Icon-only rail: just "All". */
  collapsed: boolean;
  /** Mobile drawer state; the rail slides over the list when true. */
  drawerOpen: boolean;
  activeArea: string;
  activeQueue: ResurfaceQueue | 'all';
  counts: LibraryReconciledCounts | null;
  projectNames: string[];
  collectionByName: Map<string, CollectionRecord>;
  conversations: ConversationRecord[];
  summariesByThread: Map<string, StructuredSummaryRecord>;
  /** The "+ New project" draft: null while the form is closed. */
  newProjectDraft: string | null;
  onNewProjectDraftChange: (draft: string | null) => void;
  onCreateProject: (name: string) => void | Promise<void>;
  onAreaSelect: (area: string) => void;
  onQueueSelect: (queue: ResurfaceQueue) => void;
  /** Repository the list is narrowed to (normalized "owner/name"), or null. Full page only. */
  repositoryFilter?: string | null;
  onRepositorySelect?: (repository: string | null) => void;
}

/** Projects and resurfacing queues. */
export function NavRail({
  collapsed,
  drawerOpen,
  activeArea,
  activeQueue,
  counts,
  projectNames,
  collectionByName,
  conversations,
  summariesByThread,
  newProjectDraft,
  onNewProjectDraftChange,
  onCreateProject,
  onAreaSelect,
  onQueueSelect,
  repositoryFilter = null,
  onRepositorySelect,
}: NavRailProps) {
  // Full page only: one entry per repository the open coding sessions worked in.
  const repositories = useMemo(
    () => (onRepositorySelect ? repositoryEntries(conversations) : []),
    [onRepositorySelect, conversations]
  );
  return (
    <nav className="tk-nav" aria-label="Projects and resurfacing queues" data-drawer-open={drawerOpen}>
      {!collapsed ? (
        <>
          <div>
            <div className="tk-eyebrow">Projects</div>
            <div className="tk-nav-list">
              <button
                type="button"
                className="tk-nav-item"
                aria-current={activeQueue === 'all' && activeArea === 'All threads'}
                onClick={() => onAreaSelect('All threads')}
              >
                <span>All threads</span>
                <span className="tk-nav-count">{counts?.totalThreads ?? 0}</span>
              </button>
              {projectNames.map((area) => {
                const col = collectionByName.get(area);
                return (
                  <button
                    key={area}
                    type="button"
                    className="tk-nav-item"
                    aria-current={activeQueue === 'all' && activeArea === area}
                    onClick={() => onAreaSelect(area)}
                    title={col?.description || area}
                  >
                    <span className="tk-ellipsis">
                      {area}
                      {col && (col.origin === 'auto' || col.origin === 'provider') ? <span className="tk-auto-mark"> auto</span> : null}
                    </span>
                    <span className="tk-nav-count">{counts?.projectCounts[area] ?? 0}</span>
                  </button>
                );
              })}
              {newProjectDraft === null ? (
                <button type="button" className="tk-nav-item tk-nav-add" onClick={() => onNewProjectDraftChange('')}>
                  + New project
                </button>
              ) : (
                <form
                  className="tk-nav-new"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void onCreateProject(newProjectDraft);
                  }}
                >
                  <input
                    autoFocus
                    className="tk-input"
                    aria-label="New project name"
                    placeholder="Project name"
                    value={newProjectDraft}
                    onChange={(e) => onNewProjectDraftChange(e.target.value)}
                    onBlur={() => !newProjectDraft.trim() && onNewProjectDraftChange(null)}
                  />
                </form>
              )}
            </div>
          </div>

          {onRepositorySelect && repositories.length > 0 && (
            <div className="tk-thr-nav-repos">
              <div className="tk-eyebrow" id="tk-thr-repos-label">
                Repositories
              </div>
              <div className="tk-nav-list" role="group" aria-labelledby="tk-thr-repos-label">
                {repositories.map(({ repository, count }) => {
                  const active = repositoryFilter === repository;
                  return (
                    <button
                      key={repository}
                      type="button"
                      className="tk-nav-item"
                      aria-current={active}
                      title={active ? `Showing ${repository}. Select again to show every repository.` : repository}
                      onClick={() => onRepositorySelect(active ? null : repository)}
                    >
                      <span className="tk-thr-mono tk-ellipsis">{repository}</span>
                      <span className="tk-nav-count">{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <div className="tk-eyebrow">Resurfacing</div>
            <div className="tk-nav-list">
              {(Object.keys(RESURFACE_QUEUE_LABELS) as ResurfaceQueue[]).map((q) => {
                const qCount = computeResurfacingQueueItems(conversations, summariesByThread, q).length;
                return (
                  <button
                    key={q}
                    type="button"
                    className="tk-nav-item"
                    aria-current={activeQueue === q}
                    onClick={() => onQueueSelect(q)}
                  >
                    <span>{RESURFACE_QUEUE_LABELS[q]}</span>
                    <span className="tk-nav-count">{qCount}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      ) : (
        <div className="tk-nav-list">
          <button
            type="button"
            className="tk-nav-item"
            title="All threads"
            aria-current={activeArea === 'All threads'}
            onClick={() => onAreaSelect('All threads')}
          >
            All
          </button>
        </div>
      )}
    </nav>
  );
}
