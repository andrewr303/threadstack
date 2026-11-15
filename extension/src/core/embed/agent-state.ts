// What a coding-agent page shows about its run, read from visible controls only.
//
// Ported from AI Account Navigator's page reader and page state (vendor/page-reader.js,
// page-state.js), narrowed to what a run state needs: it notes whether a stop button, a task
// status element, a permission or question dialog, a sign-in form or a browser check is on
// screen. It never reads input values, cookies, storage or message text, and keeps none of
// the dialog text it matches against. The original's message and link collection is dropped.
//
// The selectors come from Claude Code on the web and are unverified on other sites. A page
// that shows none of these controls yields 'unknown', never a guess.
import type { AgentState } from '../workspace/types.js';

/** Stable known controls still need a heartbeat; unknown controls never prove live run state. */
export function shouldReportAgentObservation(
  previous: { state: AgentState; url: string; at: number } | null,
  next: { state: AgentState; url: string },
  now: number,
  heartbeatMs = 10_000
): boolean {
  if (!previous) return next.state !== 'unknown';
  if (next.state !== previous.state || next.url !== previous.url) return true;
  return next.state !== 'unknown' && now - previous.at >= heartbeatMs;
}

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'paused', 'auth_expired', 'process_exit'] as const;
type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export interface AgentPageRead {
  /** A task status element shows a finished state. */
  terminal: TerminalStatus | null;
  /** A task status element shows the run working (running, executing, waiting for a tool). */
  waitingTool: boolean;
  /** A sign-in form or sign-in button is on screen. */
  login: boolean;
  /** The page title is a browser check ("Just a moment"). */
  challenge: boolean;
  /** A stop button is on screen. */
  stop: boolean;
  /** A dialog asks to allow or approve something. */
  permission: boolean;
  /** A dialog asks for typed input that is not a sign-in. */
  question: boolean;
}

function visible(el: Element | null | undefined): el is Element {
  return !!el && el.getClientRects().length > 0;
}

/** What the person sees as the element's text (innerText where the browser lays out the page). */
function shownText(el: Element): string {
  const inner = (el as HTMLElement).innerText;
  return typeof inner === 'string' ? inner : (el.textContent ?? '');
}

const STOP_LABEL = /^(stop|stop generating|stop response)$/i;
const SIGN_IN_LABEL = /^(log in|sign in|continue with google|continue with apple)$/i;
const WORKING_STATUS = /^(running|executing|waiting for tool|waiting for network)$/;
const CHALLENGE_TITLE = /just a moment|verify you are human|access denied/i;
const PERMISSION_TEXT = /allow|approve|permission/i;

export function readAgentPage(doc: Document): AgentPageRead {
  const buttons = Array.from(doc.querySelectorAll('button')).filter(visible);
  const dialog = Array.from(doc.querySelectorAll('[role=dialog]')).find(visible) ?? null;
  const taskStatus = Array.from(doc.querySelectorAll('[data-testid="task-status"], [data-session-status]')).find(visible) ?? null;
  const status = taskStatus
    ? (taskStatus.getAttribute('data-session-status') || taskStatus.getAttribute('data-state') || shownText(taskStatus)).trim().toLowerCase()
    : '';
  const terminal = (TERMINAL_STATUSES as readonly string[]).includes(status) ? (status as TerminalStatus) : null;
  const signInField = Array.from(doc.querySelectorAll('input[type=email],input[type=password]')).some(visible);
  return {
    terminal,
    waitingTool: taskStatus !== null && WORKING_STATUS.test(status),
    login: signInField || buttons.some((b) => SIGN_IN_LABEL.test(shownText(b).trim())),
    challenge: CHALLENGE_TITLE.test(doc.title),
    stop: buttons.some((b) => STOP_LABEL.test((b.getAttribute('aria-label') || shownText(b)).trim())),
    permission: dialog !== null && PERMISSION_TEXT.test(shownText(dialog)),
    question:
      dialog !== null &&
      dialog.querySelector('input,textarea') !== null &&
      dialog.querySelector('input[type=password],input[type=email]') === null,
  };
}

const TERMINAL_STATE: Record<TerminalStatus, AgentState> = {
  completed: 'turn_complete',
  failed: 'failed',
  cancelled: 'idle',
  paused: 'idle',
  // The site says the sign-in ran out: the same as a sign-in form for the person.
  auth_expired: 'signed_out',
  // The run's process ended without saying how; no state claims more than that.
  process_exit: 'unknown',
};

export function agentStateOf(read: AgentPageRead): AgentState {
  if (read.login) return 'signed_out';
  if (read.permission) return 'waiting_permission';
  if (read.question) return 'waiting_answer';
  if (read.terminal) return TERMINAL_STATE[read.terminal];
  if (read.stop || read.waitingTool) return 'running';
  // A browser check, or nothing recognisable: not observed.
  return 'unknown';
}
