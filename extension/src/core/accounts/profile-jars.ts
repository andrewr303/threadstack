// The live copies of profile accounts' cookie jars, kept by the service worker while those
// accounts are shown in a workspace page, and saved (encrypted, through the account service)
// shortly after each change.
//
// A profile's cookies really live in the workspace page's credentialless partition, where only
// the browser can read them. This copy follows them from what the worker sees: the `Set-Cookie`
// headers of responses to the profile's frames and the assignments its pages make to
// document.cookie. It is what the next page load is seeded from, and what a profile page's
// scripts are shown when they read document.cookie.
//
// One chain of work per account, so a load, an update and a save never interleave.
import type { StoredCookie } from '../workspace/types.js';
import { documentCookieString } from '../embed/cookie-bridge.js';
import { isDeviceCookie } from './cookies.js';
import { applyScriptCookie, applySetCookies, cookiesForUrl, looksSignedIn, pruneExpired } from './set-cookie.js';

/** A change is saved this long after it happened; changes inside the window share one save. */
export const JAR_SAVE_DELAY_MS = 600;

export interface ProfileJarsDeps {
  /** The account's saved cookies, or null when it has none. */
  read(accountId: string): Promise<StoredCookie[] | null>;
  write(accountId: string, cookies: StoredCookie[]): Promise<void>;
  now(): number;
  /** Run `fn` after `ms`; returns a cancel function. */
  schedule(fn: () => void, ms: number): () => void;
  /** The jar began or stopped holding what looks like a sign-in, after it was saved. */
  onSignedInChange?(accountId: string, signedIn: boolean): void;
}

interface LiveJar {
  cookies: StoredCookie[];
  signedIn: boolean;
  cancelSave: (() => void) | null;
}

export class ProfileJars {
  private live = new Map<string, LiveJar>();
  private chains = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ProfileJarsDeps) {}

  private chain<T>(accountId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(accountId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.chains.set(accountId, tail);
    void tail.then(() => {
      if (this.chains.get(accountId) === tail) this.chains.delete(accountId);
    });
    return run;
  }

  private async open(accountId: string): Promise<LiveJar> {
    let jar = this.live.get(accountId);
    if (!jar) {
      const now = this.deps.now();
      const stored = (await this.deps.read(accountId).catch(() => null)) ?? [];
      const cookies = pruneExpired(stored.filter((c) => !isDeviceCookie(c)), now);
      jar = { cookies, signedIn: looksSignedIn(cookies, now, isDeviceCookie), cancelSave: null };
      this.live.set(accountId, jar);
    }
    return jar;
  }

  private changed(accountId: string, jar: LiveJar, cookies: StoredCookie[]): void {
    // The device's bot-check cookies belong to the browser, not to the account.
    jar.cookies = cookies.filter((c) => !isDeviceCookie(c));
    if (jar.cancelSave) return;
    jar.cancelSave = this.deps.schedule(() => {
      jar.cancelSave = null;
      void this.save(accountId);
    }, JAR_SAVE_DELAY_MS);
  }

  private save(accountId: string): Promise<void> {
    return this.chain(accountId, async () => {
      const jar = this.live.get(accountId);
      if (!jar) return;
      const now = this.deps.now();
      jar.cookies = pruneExpired(jar.cookies, now);
      try {
        await this.deps.write(accountId, jar.cookies);
      } catch {
        // The next change saves again.
        return;
      }
      const signedIn = looksSignedIn(jar.cookies, now, isDeviceCookie);
      if (signedIn !== jar.signedIn) {
        jar.signedIn = signedIn;
        this.deps.onSignedInChange?.(accountId, signedIn);
      }
    });
  }

  /** The account's cookies as this worker knows them (a copy). */
  cookies(accountId: string): Promise<StoredCookie[]> {
    return this.chain(accountId, async () => (await this.open(accountId)).cookies.slice());
  }

  /** The `Set-Cookie` headers of one response to a page of the account. True when the jar changed. */
  applyResponse(accountId: string, headers: readonly string[], url: string): Promise<boolean> {
    return this.chain(accountId, async () => {
      const jar = await this.open(accountId);
      const next = applySetCookies(jar.cookies, headers, url, this.deps.now());
      if (next === jar.cookies) return false;
      this.changed(accountId, jar, next);
      return true;
    });
  }

  /** One document.cookie assignment by a page of the account. */
  applyScript(accountId: string, text: unknown, url: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.chain(accountId, async () => {
      const jar = await this.open(accountId);
      const result = applyScriptCookie(jar.cookies, text, url, this.deps.now());
      if (!result.ok) return result;
      if (result.jar !== jar.cookies) this.changed(accountId, jar, result.jar);
      return { ok: true as const };
    });
  }

  /** What document.cookie returns to a page of the account at `url`. */
  scriptCookieString(accountId: string, url: string): Promise<string> {
    return this.chain(accountId, async () => {
      const jar = await this.open(accountId);
      return documentCookieString(cookiesForUrl(jar.cookies, url, this.deps.now(), { script: true }));
    });
  }

  /** Save now what is waiting to be saved (all accounts, or one). */
  async flush(accountId?: string): Promise<void> {
    const ids = accountId ? [accountId] : [...this.live.keys()];
    await Promise.all(
      ids.map((id) => {
        const jar = this.live.get(id);
        if (!jar?.cancelSave) return Promise.resolve();
        jar.cancelSave();
        jar.cancelSave = null;
        return this.save(id);
      })
    );
  }

  /**
   * Drop the live copy without saving it: the account was removed, or its saved jar was replaced
   * by something else (it became the browser's own sign-in, or signed in through the browser).
   */
  forget(accountId: string): void {
    const jar = this.live.get(accountId);
    jar?.cancelSave?.();
    this.live.delete(accountId);
  }
}
