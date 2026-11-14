// Reads a Session Control backup (its "Export" file) and plans how its accounts and sessions
// become Threadkeeper accounts and threads. Pure: no storage, no chrome API. The caller applies
// the plan, so importing the same backup twice produces the same ids and never duplicates.
import { ACCOUNT_COLORS, type AccountColor, type AccountMode } from './workspace/types.js';
import { primaryAccountId } from './workspace/realms.js';
import { normalizeRepository } from './repository.js';
import { buildThreadKey, computeDeterministicHash, type WorkflowState } from './schema.js';
import type { UpsertThreadInput } from './db.js';

export const SESSION_CONTROL_VERSION = 1;
const SC_COLORS = ['peach', 'violet', 'sage', 'blue', 'gold'] as const;
const SC_STATUSES = ['saved', 'running', 'attention', 'done', 'paused'] as const;
type ScStatus = (typeof SC_STATUSES)[number];
const SC_ICONS = ['user', 'folder', 'book', 'code', 'gear'];
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionControlAccount {
  id: string;
  name: string;
  email: string;
  color: (typeof SC_COLORS)[number];
  mode: 'isolated' | 'current';
  profileId?: string;
}
export interface SessionControlWorkspace {
  id: string;
  name: string;
  icon: string;
}
export interface SessionControlSession {
  id: string;
  accountId: string;
  workspaceId: string;
  title: string;
  url: string;
  notes: string;
  repository: string;
  branch: string;
  status: ScStatus;
  pinned: boolean;
  archived: boolean;
  updatedAt: number;
  createdAt: number;
}
export interface SessionControlState {
  version: 1;
  accounts: SessionControlAccount[];
  workspaces: SessionControlWorkspace[];
  sessions: SessionControlSession[];
  activity: Array<{ id: string; text: string; at: number }>;
  settings: { compact: boolean };
}

const cleanText = (v: unknown, max = 160): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const idOK = (x: unknown): x is string => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(x);

function cloudUrl(value: unknown): string {
  let u: URL;
  try {
    u = new URL(String(value));
  } catch {
    throw new Error('Paste a complete https://claude.ai/code session URL.');
  }
  if (
    u.protocol !== 'https:' || u.hostname !== 'claude.ai' || u.port || u.username || u.password ||
    !/^\/code(?:\/[A-Za-z0-9_-]+)*\/?$/.test(u.pathname)
  ) {
    throw new Error('Use a Claude Code URL beginning with https://claude.ai/code.');
  }
  return `https://claude.ai${u.pathname.replace(/\/$/, '')}`;
}

/** Validate a decoded backup; throws with Session Control's own messages. */
export function validateSessionControlState(raw: any): SessionControlState {
  if (!raw || raw.version !== SESSION_CONTROL_VERSION || !Array.isArray(raw.accounts) || !Array.isArray(raw.sessions) || !Array.isArray(raw.workspaces)) {
    throw new Error('This is not a supported Session Control backup.');
  }
  if (raw.accounts.length > 100 || raw.sessions.length > 5000 || raw.workspaces.length > 100) {
    throw new Error('Backup exceeds the supported size.');
  }
  const ids = new Set<string>();
  const checkId = (id: unknown): string => {
    if (!idOK(id) || ids.has(id)) throw new Error('Backup has invalid or duplicate IDs.');
    ids.add(id);
    return id;
  };
  const accounts: SessionControlAccount[] = raw.accounts.map((a: any) => {
    if (!a || !['isolated', 'current'].includes(a.mode) || !(SC_COLORS as readonly string[]).includes(a.color) || !cleanText(a.name)) {
      throw new Error('Backup has an invalid account.');
    }
    if (a.mode === 'isolated' && !PROFILE_ID.test(a.profileId || '')) throw new Error('Backup has an invalid profile ID.');
    return { id: checkId(a.id), name: cleanText(a.name, 60), email: cleanText(a.email, 120), color: a.color, mode: a.mode, profileId: a.profileId };
  });
  if (accounts.filter((a) => a.mode === 'current').length > 1) throw new Error('Only one account can use the current Chrome profile.');
  const profileIds = accounts.filter((a) => a.mode === 'isolated').map((a) => a.profileId);
  if (new Set(profileIds).size !== profileIds.length) throw new Error('Isolated accounts must have different profile IDs.');
  const workspaces: SessionControlWorkspace[] = raw.workspaces.map((w: any) => {
    if (!w || !cleanText(w.name)) throw new Error('Invalid workspace.');
    return { id: checkId(w.id), name: cleanText(w.name, 40), icon: SC_ICONS.includes(w.icon) ? w.icon : 'folder' };
  });
  if (!workspaces.length) throw new Error('Keep at least one workspace.');
  const sessions: SessionControlSession[] = raw.sessions.map((s: any) => {
    if (
      !s || !accounts.some((a) => a.id === s.accountId) || !workspaces.some((w) => w.id === s.workspaceId) ||
      !Object.hasOwn(Object.fromEntries(SC_STATUSES.map((x) => [x, 1])), s.status) || !cleanText(s.title)
    ) {
      throw new Error('A session has invalid account, workspace, title or status.');
    }
    return {
      id: checkId(s.id), accountId: s.accountId, workspaceId: s.workspaceId, title: cleanText(s.title), url: cloudUrl(s.url),
      notes: cleanText(s.notes, 20000), repository: cleanText(s.repository, 120), branch: cleanText(s.branch, 120),
      status: s.status, pinned: !!s.pinned, archived: !!s.archived,
      updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : Date.now(),
      createdAt: Number.isFinite(s.createdAt) ? s.createdAt : Date.now(),
    };
  });
  return {
    version: SESSION_CONTROL_VERSION, accounts, workspaces, sessions,
    activity: Array.isArray(raw.activity)
      ? raw.activity.slice(0, 100).map((a: any) => ({ id: cleanText(a?.id), text: cleanText(a?.text, 300), at: Number.isFinite(a?.at) ? a.at : Date.now() }))
      : [],
    settings: { compact: !!raw.settings?.compact },
  };
}

/** Parse and validate the text of a Session Control backup file. */
export function parseSessionControlBackup(text: string): SessionControlState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This is not a supported Session Control backup.');
  }
  return validateSessionControlState(raw);
}

export interface PlannedAccount {
  sourceId: string;
  /** Account id written into thread keys: the bound id for the primary account, else acct_sc<hash>. */
  accountId: string;
  /** Id of the AccountRecord to create: primary~anthropic for the primary account, else accountId. */
  recordId: string;
  realm: 'anthropic';
  label: string;
  email: string;
  color: AccountColor;
  mode: AccountMode;
  profileId?: string;
  primary: boolean;
}
export interface SessionControlImportPlan {
  accounts: PlannedAccount[];
  projects: string[];
  threads: UpsertThreadInput[];
  skipped: Array<{ title: string; reason: string }>;
}

const WORKFLOW: Record<ScStatus, WorkflowState> = {
  saved: 'active',
  running: 'active',
  attention: 'needs_review',
  done: 'done',
  paused: 'paused',
};

function iso(ms: number): string | null {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function planSessionControlImport(
  state: SessionControlState,
  opts: { boundClaudeCodeAccountId: string; workspaceId: string }
): SessionControlImportPlan {
  const accounts: PlannedAccount[] = state.accounts.map((a) => {
    const primary = a.mode === 'current';
    const accountId = primary ? opts.boundClaudeCodeAccountId : `acct_sc${computeDeterministicHash(a.profileId ?? a.id).slice(0, 10)}`;
    const color = (ACCOUNT_COLORS as readonly string[]).includes(a.color) ? (a.color as AccountColor) : 'teal';
    return {
      sourceId: a.id,
      accountId,
      recordId: primary ? primaryAccountId('anthropic') : accountId,
      realm: 'anthropic',
      label: a.name,
      email: a.email,
      color,
      mode: primary ? 'embedded' : 'isolated',
      ...(primary ? {} : { profileId: a.profileId }),
      primary,
    };
  });
  const byAccount = new Map(accounts.map((a) => [a.sourceId, a]));
  // The built-in Personal workspace is the starter area of the same name.
  const projectOf = (w: SessionControlWorkspace) => (w.id === 'personal' ? 'Personal' : w.name);
  const byWorkspace = new Map(state.workspaces.map((w) => [w.id, projectOf(w)]));
  const projects = [...new Set(state.workspaces.map(projectOf))].filter((n) => n !== 'Personal');

  const threads: UpsertThreadInput[] = [];
  const skipped: SessionControlImportPlan['skipped'] = [];
  for (const s of state.sessions) {
    const path = new URL(s.url).pathname;
    const id = path.split('/')[2] ?? '';
    if (!id) {
      skipped.push({ title: s.title, reason: 'The address is the Claude Code home page, not a session.' });
      continue;
    }
    if (id.startsWith('sample-')) {
      skipped.push({ title: s.title, reason: 'Sample data from Session Control.' });
      continue;
    }
    const account = byAccount.get(s.accountId)!;
    const repository = normalizeRepository(s.repository);
    threads.push({
      threadKey: buildThreadKey({ provider: 'claude_code', accountId: account.accountId, workspaceId: opts.workspaceId, sourceConversationId: id, branchId: 'main' }),
      provider: 'claude_code',
      accountId: account.accountId,
      workspaceId: opts.workspaceId,
      sourceConversationId: id,
      branchId: 'main',
      canonicalUrl: s.url,
      title: s.title,
      createdAt: iso(s.createdAt),
      updatedAt: iso(s.updatedAt),
      coverage: 'metadata_only',
      captureSource: 'manual',
      project: byWorkspace.get(s.workspaceId) ?? 'Personal',
      workflowState: s.archived ? 'archived' : WORKFLOW[s.status],
      manualNotes: s.notes,
      pinned: s.pinned,
      repository,
      providerProjectName: !repository && s.repository ? s.repository : null,
      gitBranch: s.branch || null,
      messages: [],
    });
  }
  return { accounts, projects, threads, skipped };
}
