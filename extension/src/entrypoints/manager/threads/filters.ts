// Filters of the Threads list that come from the workspace: the repository a session worked in,
// the account it was captured under, and what its coding-agent run was last seen doing.
import { agentStateNeedsYou, type AgentState } from '../../../core/workspace/types.js';

/** `needs_you`: waiting for approval, an answer, or failed. */
export type RunFilter = 'all' | 'needs_you' | 'running' | 'finished';

export const RUN_FILTER_LABELS: Record<RunFilter, string> = {
  all: 'Any run state',
  needs_you: 'Needs you',
  running: 'Running',
  finished: 'Finished',
};

export function matchesRunFilter(state: AgentState | null | undefined, filter: RunFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'needs_you') return agentStateNeedsYou(state);
  if (filter === 'running') return state === 'running';
  return state === 'turn_complete';
}
