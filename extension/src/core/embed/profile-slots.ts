// Profile slots: which profile account each workspace tab shows for each login realm, which of
// the tab's frames are profile frames, and the seeding rules in force.
//
// A workspace page has two places a realm's account can load. Ordinary frames use the browser's
// own cookies (the realm's browser account). Credentialless frames use the page's separate,
// throwaway cookie partition, which starts empty with every page load; ThreadStack fills it
// with one profile account's saved cookies per realm (profile-seed.ts) and from then on the
// browser handles cookies there itself. All credentialless frames of a page share that one
// partition, so a page shows one profile per realm; another profile needs a new page load, which
// also gives it clean site storage. The slot is therefore claimed once per page load and never
// re-pointed.
//
// The service worker cannot read that partition, so it keeps each profile's jar current from the
// `Set-Cookie` headers of the responses profile frames receive. Whether a response belongs to a
// profile frame is decided only from what the frame's own content script reported about itself
// (credentialless or not), or from its parent frame; responses of frames not yet known are held
// briefly and dropped if the frame turns out to be an ordinary one. A response is never filed
// under an account on a guess: that would put one account's sign-in into another's jar.
//
// Everything takes its chrome APIs as arguments so it can be tested with fakes.
import type { WorkspaceFailure } from '../workspace/types.js';
import { allocateSeedRuleIds, isSeedRuleId, seedNonceOf, seedRule, type SeedPlan, type SeedRule } from './profile-seed.js';

/** chrome.storage.session key. */
export const PROFILE_SLOTS_KEY = 'tk_profile_slots';

/** How long a response of a frame not yet known is held for that frame to say what it is. */
export const HOLD_MS = 20_000;
const MAX_HELD = 300;
const MAX_FRAMES_PER_TAB = 600;

export interface SeedRulesApi {
  getSessionRules(): Promise<Array<{ id: number }>>;
  updateSessionRules(options: { removeRuleIds?: number[]; addRules?: SeedRule[] }): Promise<void>;
}

export interface SlotStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface ProfileSlotsEnv {
  store: SlotStore | null;
  rules: SeedRulesApi | null;
  now(): number;
  /**
   * Whether the worker sees the responses of the workspace tab's requests (the webRequest
   * permission). Without it, a slot is ready once the page has loaded its seeding addresses,
   * since nothing can confirm more than that.
   */
  observesResponses?: () => boolean;
  /**
   * Whether a tab is still a workspace page. A slot left behind by a page that went away (its tab
   * went elsewhere) must not keep the account from another workspace tab.
   */
  isWorkspaceTab?: (tabId: number) => boolean;
}

export type FrameKind = 'profile' | 'plain';

export interface SlotRecord {
  accountId: string;
  /**
   * `stale`: the account's saved sign-in was replaced after this page's partition was seeded
   * (retire). The partition holds the old cookies, so nothing of it is filed any more and the
   * page has to reload to show the account again.
   */
  status: 'seeding' | 'ready' | 'stale';
  nonce: string;
  ruleIds: number[];
  /** Seeding addresses the worker has not seen a response for yet. */
  pending: string[];
  readyAt: number | null;
}

export interface HeldResponse {
  frameId: number;
  url: string;
  headers: string[];
  at: number;
}

interface TabState {
  slots: Map<string, SlotRecord>;
  frames: Map<number, FrameKind>;
  held: HeldResponse[];
}

const BUSY: WorkspaceFailure = { ok: false, error: 'ThreadStack could not prepare this account here. Reload the page and try again.' };

export class ProfileSlots {
  private tabs = new Map<number, TabState>();
  private loaded: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly env: ProfileSlotsEnv) {}

  /** Load what an earlier worker remembered. Safe to await on every message. */
  ready(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          const raw = (await this.env.store?.get(PROFILE_SLOTS_KEY))?.[PROFILE_SLOTS_KEY];
          if (!raw || typeof raw !== 'object') return;
          for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            const tabId = Number(key);
            if (!Number.isInteger(tabId) || tabId < 0 || this.tabs.has(tabId)) continue;
            const state = reviveTab(value);
            if (state) this.tabs.set(tabId, state);
          }
        } catch {
          // session storage unavailable: start empty
        }
      })();
    }
    return this.loaded;
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private tab(tabId: number): TabState {
    let state = this.tabs.get(tabId);
    if (!state) {
      state = { slots: new Map(), frames: new Map(), held: [] };
      this.tabs.set(tabId, state);
    }
    return state;
  }

  private async persist(): Promise<void> {
    if (!this.env.store) return;
    const value: Record<string, unknown> = {};
    for (const [tabId, state] of this.tabs) {
      value[String(tabId)] = {
        slots: Object.fromEntries(state.slots),
        frames: Object.fromEntries(state.frames),
      };
    }
    try {
      await this.env.store.set({ [PROFILE_SLOTS_KEY]: value });
    } catch {
      // the in-memory copy still answers for this worker's lifetime
    }
  }

  private async removeRules(ids: number[]): Promise<void> {
    const owned = ids.filter(isSeedRuleId);
    if (owned.length === 0 || !this.env.rules) return;
    await this.env.rules.updateSessionRules({ removeRuleIds: owned }).catch(() => undefined);
  }

  /** The tab loaded a new workspace page (or closed): its partition is gone, and so are its slots. */
  resetTab(tabId: number): Promise<void> {
    return this.serial(async () => {
      await this.ready();
      const state = this.tabs.get(tabId);
      if (!state) return;
      this.tabs.delete(tabId);
      await this.removeRules([...state.slots.values()].flatMap((s) => s.ruleIds));
      await this.persist();
    });
  }

  /** Forget tabs the caller no longer knows as workspace tabs, and seed rules nobody owns. */
  prune(isWorkspaceTab: (tabId: number) => boolean): Promise<void> {
    return this.serial(async () => {
      await this.ready();
      let changed = false;
      for (const [tabId, state] of [...this.tabs]) {
        if (isWorkspaceTab(tabId)) continue;
        this.tabs.delete(tabId);
        await this.removeRules([...state.slots.values()].flatMap((s) => s.ruleIds));
        changed = true;
      }
      if (this.env.rules) {
        try {
          const kept = new Set([...this.tabs.values()].flatMap((t) => [...t.slots.values()].flatMap((s) => s.ruleIds)));
          const orphans = (await this.env.rules.getSessionRules()).map((r) => r.id).filter((id) => isSeedRuleId(id) && !kept.has(id));
          await this.removeRules(orphans);
        } catch {
          // rules API unavailable; nothing to clean
        }
      }
      if (changed) await this.persist();
    });
  }

  slot(tabId: number, realmId: string): SlotRecord | null {
    return this.tabs.get(tabId)?.slots.get(realmId) ?? null;
  }

  /** The profile account whose pages this tab shows for a realm, once its cookies are in place. */
  accountFor(tabId: number | undefined, realmId: string): string | null {
    if (typeof tabId !== 'number') return null;
    const slot = this.slot(tabId, realmId);
    return slot && slot.status === 'ready' ? slot.accountId : null;
  }

  /** Tabs that show `accountId` in a slot right now (seeding or ready). */
  tabsShowing(accountId: string): number[] {
    const out: number[] = [];
    for (const [tabId, state] of this.tabs) {
      if ([...state.slots.values()].some((s) => s.accountId === accountId && s.status !== 'stale')) out.push(tabId);
    }
    return out;
  }

  /**
   * The account's saved sign-in was replaced behind every partition seeded from it: mark each
   * slot that shows it stale, remove its seeding rules, and answer where that happened.
   */
  retire(accountId: string): Promise<Array<{ tabId: number; realmId: string }>> {
    return this.serial(async () => {
      await this.ready();
      const retired: Array<{ tabId: number; realmId: string }> = [];
      for (const [tabId, state] of this.tabs) {
        for (const [realmId, slot] of state.slots) {
          if (slot.accountId !== accountId || slot.status === 'stale') continue;
          await this.removeRules(slot.ruleIds);
          slot.status = 'stale';
          slot.ruleIds = [];
          slot.pending = [];
          retired.push({ tabId, realmId });
        }
      }
      if (retired.length > 0) await this.persist();
      return retired;
    });
  }

  /**
   * Claim the tab's slot of `realmId` for `accountId` and install the seeding rules of `plan`.
   * Answers the addresses the page must load. A slot already showing another account refuses:
   * the page has to be reloaded for that.
   */
  claim(
    tabId: number,
    realmId: string,
    accountId: string,
    prepare: SeedPlan | (() => Promise<SeedPlan>),
    move = false
  ): Promise<{ ok: true; steps: string[]; movedFrom?: number[] } | WorkspaceFailure> {
    return this.serial(async () => {
      await this.ready();
      const state = this.tab(tabId);
      const existing = state.slots.get(realmId);
      if (existing && existing.accountId !== accountId) {
        return { ok: false, error: 'This page already shows another account of this sign-in.', code: 'needs_reload' };
      }
      if (existing && existing.status === 'stale') {
        return { ok: false, error: 'This account’s sign-in changed since this page loaded it. Reload to show it.', code: 'needs_reload' };
      }
      // Two partitions would each change the one saved sign-in behind the other's back.
      const others = this.tabsShowing(accountId).filter((other) => other !== tabId);
      const live = this.env.isWorkspaceTab ?? (() => true);
      const movedFrom = others.filter(live);
      if (!move && movedFrom.length) {
        return {
          ok: false,
          error: 'This account is open in another ThreadStack tab.',
          code: 'profile_in_use',
        };
      }
      // Freeze the old partition before reading the live jar. Previous writes have entered the
      // jar queue, and responses arriving during the move cannot change the transferred sign-in.
      const retired: Array<{ slot: SlotRecord; status: SlotRecord['status'] }> = [];
      for (const other of others) {
        for (const slot of this.tabs.get(other)?.slots.values() ?? []) {
          if (slot.accountId !== accountId || slot.status === 'stale') continue;
          retired.push({ slot, status: slot.status });
          slot.status = 'stale';
        }
      }
      let steps: string[] = [];
      try {
        const plan = typeof prepare === 'function' ? await prepare() : prepare;
        if (existing?.status !== 'ready') {
          const nonce = plan.steps[0] ? seedNonceOf(plan.steps[0].url) : null;
          const ruleIds = nonce ? await this.installSeedRules(tabId, plan) : [];
          steps = nonce ? plan.steps.map((s) => s.url) : [];
          state.slots.set(realmId, {
            accountId, status: nonce ? 'seeding' : 'ready', nonce: nonce ?? '', ruleIds,
            pending: steps.slice(), readyAt: nonce ? null : this.env.now(),
          });
          if (existing) await this.removeRules(existing.ruleIds);
        }
      } catch {
        for (const { slot, status } of retired) slot.status = status;
        return BUSY;
      }
      for (const { slot } of retired) {
        await this.removeRules(slot.ruleIds);
        slot.ruleIds = [];
        slot.pending = [];
      }
      await this.persist();
      return { ok: true, steps, ...(movedFrom.length ? { movedFrom } : {}) };
    });
  }

  private async installSeedRules(tabId: number, plan: SeedPlan): Promise<number[]> {
    const rules = this.env.rules;
    if (!rules) throw new Error('Session rules unavailable');
    const taken = [
      ...(await rules.getSessionRules()).map((r) => r.id),
      ...[...this.tabs.values()].flatMap((t) => [...t.slots.values()].flatMap((s) => s.ruleIds)),
    ];
    const ids = allocateSeedRuleIds(taken, plan.steps.length);
    if (!ids) throw new Error('No seed rule IDs available');
    await rules.updateSessionRules({ addRules: plan.steps.map((step, i) => seedRule(ids[i], tabId, step)) });
    return ids;
  }

  /** A response arrived for a seeding address of this tab. True when it was one. */
  noteSeedResponse(tabId: number, url: string): boolean {
    const nonce = seedNonceOf(url);
    const state = this.tabs.get(tabId);
    if (!nonce || !state) return false;
    for (const slot of state.slots.values()) {
      if (slot.nonce !== nonce) continue;
      slot.pending = slot.pending.filter((u) => u !== url);
      return true;
    }
    // A seeding address of an earlier claim: still not a page response.
    return true;
  }

  /**
   * The page loaded every seeding address. The rules are removed whatever happened; the slot is
   * ready only if the worker saw a response for each address (a host that did not answer means
   * the account's cookies for it are missing). A worker that cannot see responses takes the
   * page's word for it.
   */
  markReady(tabId: number, realmId: string): Promise<{ ok: true } | WorkspaceFailure> {
    return this.serial(async () => {
      await this.ready();
      const state = this.tabs.get(tabId);
      const slot = state?.slots.get(realmId);
      if (!state || !slot) return { ok: false, error: 'This account is not being prepared here.', code: 'not_allowed' };
      if (slot.status === 'stale') {
        return { ok: false, error: 'This account’s sign-in changed since this page loaded it. Reload to show it.', code: 'needs_reload' };
      }
      if (slot.status === 'ready') return { ok: true };
      await this.removeRules(slot.ruleIds);
      const observing = this.env.observesResponses ? this.env.observesResponses() : true;
      if (slot.pending.length > 0 && observing) {
        // Not ready: the page may claim again, which loads the addresses once more.
        state.slots.delete(realmId);
        await this.persist();
        return { ok: false, error: 'The site did not answer, so this account could not be loaded. Check your connection and try again.' };
      }
      slot.status = 'ready';
      slot.ruleIds = [];
      slot.readyAt = this.env.now();
      await this.persist();
      return { ok: true };
    });
  }

  /**
   * A frame's own content script said whether it is credentialless. Returns the responses held
   * for it when it is a profile frame (an ordinary frame's are dropped).
   */
  frameSeen(tabId: number, frameId: number, profile: boolean): HeldResponse[] {
    const state = this.tab(tabId);
    const kind: FrameKind = profile ? 'profile' : 'plain';
    const before = state.frames.get(frameId);
    state.frames.set(frameId, kind);
    if (state.frames.size > MAX_FRAMES_PER_TAB) state.frames.delete(state.frames.keys().next().value as number);
    // A response held longer than HOLD_MS is stale even when nothing else was held since.
    const now = this.env.now();
    const mine = state.held.filter((h) => h.frameId === frameId && now - h.at < HOLD_MS);
    state.held = state.held.filter((h) => h.frameId !== frameId && now - h.at < HOLD_MS);
    if (before !== kind) void this.serial(() => this.persist());
    return profile ? mine : [];
  }

  /** What a frame is, as far as it has been told; a frame inside a known frame is what its parent is. */
  kindOf(tabId: number, frameId: number, parentFrameId?: number): FrameKind | 'unknown' {
    const state = this.tabs.get(tabId);
    if (!state) return 'unknown';
    const own = state.frames.get(frameId);
    if (own) return own;
    if (typeof parentFrameId === 'number' && parentFrameId > 0) {
      const parent = state.frames.get(parentFrameId);
      if (parent) {
        state.frames.set(frameId, parent);
        return parent;
      }
    }
    return 'unknown';
  }

  /** Keep a response of a frame not yet known, for a short while. */
  hold(tabId: number, response: Omit<HeldResponse, 'at'>): void {
    const state = this.tab(tabId);
    const now = this.env.now();
    state.held = state.held.filter((h) => now - h.at < HOLD_MS);
    state.held.push({ ...response, at: now });
    if (state.held.length > MAX_HELD) state.held = state.held.slice(-MAX_HELD);
  }
}

function reviveTab(value: unknown): TabState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { slots?: unknown; frames?: unknown };
  const slots = new Map<string, SlotRecord>();
  if (raw.slots && typeof raw.slots === 'object') {
    for (const [realm, entry] of Object.entries(raw.slots as Record<string, unknown>)) {
      const e = entry as Partial<SlotRecord> | null;
      if (!e || typeof e.accountId !== 'string' || (e.status !== 'seeding' && e.status !== 'ready' && e.status !== 'stale')) continue;
      slots.set(realm, {
        accountId: e.accountId,
        status: e.status,
        nonce: typeof e.nonce === 'string' ? e.nonce : '',
        ruleIds: Array.isArray(e.ruleIds) ? e.ruleIds.filter((id): id is number => typeof id === 'number') : [],
        pending: Array.isArray(e.pending) ? e.pending.filter((u): u is string => typeof u === 'string') : [],
        readyAt: typeof e.readyAt === 'number' ? e.readyAt : null,
      });
    }
  }
  const frames = new Map<number, FrameKind>();
  if (raw.frames && typeof raw.frames === 'object') {
    for (const [id, kind] of Object.entries(raw.frames as Record<string, unknown>)) {
      const frameId = Number(id);
      if (Number.isInteger(frameId) && frameId > 0 && (kind === 'profile' || kind === 'plain')) frames.set(frameId, kind);
    }
  }
  return { slots, frames, held: [] };
}
