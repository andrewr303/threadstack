// Applies a planned Session Control import: reuses or creates the isolated accounts, creates the
// projects, and files each session under the account id that really exists. The plan itself is
// pure (core/session-control-import.ts); this is the part that touches storage and the account
// service. Importing the same file twice adds nothing: an account is matched by its Chrome
// profile id, and a session that already has a thread is left as it is.
import { upsertThread, type ThreadkeeperDB } from '../../../core/db.js';
import { buildThreadKey } from '../../../core/schema.js';
import type { PlannedAccount, SessionControlImportPlan } from '../../../core/session-control-import.js';
import type {
  AccountColor,
  AccountMode,
  AccountRecord,
  AccountsChangeResult,
  RealmAccounts,
  WorkspaceFailure,
} from '../../../core/workspace/types.js';

export type AddAccountFn = (input: {
  realm: string;
  mode: AccountMode;
  label?: string;
  color?: AccountColor;
  profileId?: string;
}) => Promise<AccountsChangeResult | WorkspaceFailure>;

const REALM = 'anthropic';

function sameProfile(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

/** The isolated account of the Claude sign-in that already uses this Chrome profile, if any. */
export function findAccountByProfile(realms: readonly RealmAccounts[], profileId: string | undefined): AccountRecord | null {
  const entry = realms.find((r) => r.realm.id === REALM);
  return entry?.accounts.find((a) => a.mode === 'isolated' && sameProfile(a.profileId, profileId)) ?? null;
}

export interface PlanPreview {
  accounts: Array<{ label: string; email: string; where: string; status: string }>;
  projects: string[];
  sessions: number;
  skipped: Array<{ title: string; reason: string }>;
}

/** What importing the plan would do, in words, without changing anything. */
export function previewSessionControlImport(plan: SessionControlImportPlan, realms: readonly RealmAccounts[]): PlanPreview {
  return {
    accounts: plan.accounts.map((a) => ({
      label: a.label,
      email: a.email,
      where: a.mode === 'isolated' ? 'In its own Chrome window' : 'In the workspace (this browser’s Claude sign-in)',
      status: a.primary ? 'Uses the account already here' : findAccountByProfile(realms, a.profileId) ? 'Already added' : 'Will be added',
    })),
    projects: plan.projects,
    sessions: plan.threads.length,
    skipped: plan.skipped,
  };
}

export interface ImportOutcome {
  sessionsImported: number;
  accountsCreated: number;
  projectsCreated: number;
  /** Sessions that already had a thread. */
  alreadyThere: number;
  skipped: Array<{ title: string; reason: string }>;
  /** Accounts that could not be created, with the reason. */
  failures: string[];
  message: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function describeImportOutcome(o: Omit<ImportOutcome, 'message'>): string {
  const skippedTotal = o.skipped.length + o.alreadyThere;
  const head =
    `Imported ${plural(o.sessionsImported, 'session')}` +
    (o.accountsCreated ? ` and ${plural(o.accountsCreated, 'account')}` : '') +
    ' from Session Control.';
  const tail = skippedTotal
    ? ` ${skippedTotal} skipped${o.alreadyThere ? `, ${o.alreadyThere} of them already in the library` : ''}.`
    : '';
  const problems = o.failures.length ? ` ${o.failures.join(' ')}` : '';
  return `${head}${tail}${problems}`;
}

export async function applySessionControlImport(
  plan: SessionControlImportPlan,
  deps: { db: ThreadkeeperDB; realms: readonly RealmAccounts[]; addAccount: AddAccountFn }
): Promise<ImportOutcome> {
  const { db, addAccount } = deps;
  let realms = deps.realms;
  const skipped = [...plan.skipped];
  const failures: string[] = [];
  let accountsCreated = 0;

  // 1. Accounts: planned id -> the id the thread keys must carry, or null when it cannot exist.
  const realId = new Map<string, string | null>();
  for (const planned of plan.accounts) {
    realId.set(planned.accountId, await resolveAccount(planned));
  }

  async function resolveAccount(planned: PlannedAccount): Promise<string | null> {
    // The browser's own sign-in already exists; its threads keep the id they were stored under.
    if (planned.primary) return planned.accountId;
    const existing = findAccountByProfile(realms, planned.profileId);
    if (existing) return existing.id;
    const result = await addAccount({
      realm: REALM,
      mode: 'isolated',
      label: planned.label,
      color: planned.color,
      profileId: planned.profileId,
    });
    if (!result.ok) {
      failures.push(`Could not add ${planned.label}: ${result.error}`);
      return null;
    }
    realms = result.realms;
    accountsCreated += 1;
    return result.account?.id ?? findAccountByProfile(result.realms, planned.profileId)?.id ?? null;
  }

  // 2. Projects, the way the app creates one: a collection of origin "user".
  let projectsCreated = 0;
  for (const name of plan.projects) {
    if (await db.collections.get(name)) continue;
    await db.collections.put({
      name,
      description: '',
      isStarterArea: false,
      cloudExcluded: false,
      createdAt: new Date().toISOString(),
      keywords: [name.toLowerCase()],
      origin: 'user',
    });
    projectsCreated += 1;
  }

  // 3. Sessions, rebuilt for the real account id.
  let sessionsImported = 0;
  let alreadyThere = 0;
  for (const thread of plan.threads) {
    const accountId = realId.get(thread.accountId);
    if (!accountId) {
      skipped.push({ title: thread.title, reason: 'Its account could not be added.' });
      continue;
    }
    const threadKey = buildThreadKey({
      provider: thread.provider,
      accountId,
      workspaceId: thread.workspaceId,
      sourceConversationId: thread.sourceConversationId,
      branchId: thread.branchId,
    });
    // A thread already here may have been captured in full or edited by hand; leave it alone.
    if (await db.conversations.get(threadKey)) {
      alreadyThere += 1;
      continue;
    }
    const stored = await upsertThread(db, { ...thread, accountId, threadKey });
    if (stored.status === 'stored') sessionsImported += 1;
    else skipped.push({ title: thread.title, reason: 'You deleted this thread earlier.' });
  }

  const outcome = { sessionsImported, accountsCreated, projectsCreated, alreadyThere, skipped, failures };
  return { ...outcome, message: describeImportOutcome(outcome) };
}
