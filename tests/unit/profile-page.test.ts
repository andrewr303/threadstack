import { describe, expect, it } from 'vitest';
import {
  PROFILE_MARK,
  asCrossSiteAssignment,
  consumeMark,
  presentAsTopLevel,
  refuseBackgroundWorkers,
} from '../../src/core/embed/profile-page.js';

describe('PROFILE_MARK and consumeMark', () => {
  it('reads a mark the isolated world left and removes it so a page script cannot see it', () => {
    const root = document.createElement('html');
    root.setAttribute(PROFILE_MARK, '');
    expect(consumeMark({ documentElement: root }, PROFILE_MARK)).toBe(true);
    expect(root.hasAttribute(PROFILE_MARK)).toBe(false);
  });

  it('cannot be used twice', () => {
    const root = document.createElement('html');
    root.setAttribute(PROFILE_MARK, '');
    const doc = { documentElement: root };
    expect(consumeMark(doc, PROFILE_MARK)).toBe(true);
    expect(consumeMark(doc, PROFILE_MARK)).toBe(false);
  });

  it('is false, and touches nothing, when the mark is absent', () => {
    const root = document.createElement('html');
    root.setAttribute('data-other', 'x');
    expect(consumeMark({ documentElement: root }, PROFILE_MARK)).toBe(false);
    expect(root.getAttribute('data-other')).toBe('x');
  });

  it('only removes the mark it was asked about', () => {
    const root = document.createElement('html');
    root.setAttribute(PROFILE_MARK, '');
    root.setAttribute('data-tk-top-level', '');
    consumeMark({ documentElement: root }, PROFILE_MARK);
    expect(root.hasAttribute('data-tk-top-level')).toBe(true);
  });

  it('is false without a document element or when the document throws', () => {
    expect(consumeMark({ documentElement: null }, PROFILE_MARK)).toBe(false);
    const hostile = {
      get documentElement(): never {
        throw new Error('boom');
      },
    };
    expect(consumeMark(hostile, PROFILE_MARK)).toBe(false);
  });
});

describe('asCrossSiteAssignment', () => {
  it('ends every assignment with SameSite=None and Secure', () => {
    expect(asCrossSiteAssignment('a=1; path=/')).toBe('a=1; path=/; SameSite=None; Secure');
  });

  it('replaces the page\'s own SameSite and Secure, whatever their case', () => {
    const out = asCrossSiteAssignment('a=1; SameSite=Strict; path=/; secure; SAMESITE = lax');
    expect(out).toBe('a=1; path=/; SameSite=None; Secure');
  });

  it('keeps the other attributes and the value', () => {
    expect(asCrossSiteAssignment('a=b=c; Max-Age=60; domain=claude.ai')).toBe('a=b=c; Max-Age=60; domain=claude.ai; SameSite=None; Secure');
  });

  it('works for a bare pair', () => {
    expect(asCrossSiteAssignment('a=1')).toBe('a=1; SameSite=None; Secure');
  });

  it('does not strip a cookie whose name or value merely contains those words', () => {
    expect(asCrossSiteAssignment('secure=1; path=/')).toBe('secure=1; path=/; SameSite=None; Secure');
  });
});

describe('presentAsTopLevel', () => {
  function fakePage(scriptRuns: boolean) {
    const attrs = new Set<string>();
    const root = {
      hasAttribute: (n: string) => attrs.has(n),
      removeAttribute: (n: string) => void attrs.delete(n),
      setAttribute: (n: string) => void attrs.add(n),
    };
    const injected: string[] = [];
    const doc = {
      documentElement: root,
      head: {
        appendChild: (script: { textContent: string }) => {
          injected.push(script.textContent);
          // Stand in for the browser running the inline script: it sets the probe attribute.
          if (scriptRuns) root.setAttribute('data-tk-self');
        },
      },
      createElement: () => ({ textContent: '', remove: () => undefined }),
    };
    const top = { name: 'top' };
    const win = { top } as unknown as Window;
    return { doc: doc as unknown as Document, win, top, attrs, injected };
  }

  it('injects a global `let self = window` and makes window.self answer window.top', () => {
    const { doc, win, top, injected } = fakePage(true);
    expect(presentAsTopLevel(win, doc)).toBe(true);
    expect(injected[0]).toContain('let self = window');
    expect(win.self).toBe(top);
  });

  it('ignores assignments to window.self and leaves no probe behind', () => {
    const { doc, win, top, attrs } = fakePage(true);
    presentAsTopLevel(win, doc);
    (win as unknown as { self: unknown }).self = {};
    expect(win.self).toBe(top);
    expect(attrs.size).toBe(0);
  });

  it('changes nothing when the inline script did not run (content security policy)', () => {
    const { doc, win } = fakePage(false);
    expect(presentAsTopLevel(win, doc)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(win, 'self')).toBeUndefined();
  });

  it('does nothing and does not throw without a document element', () => {
    const { win } = fakePage(true);
    expect(presentAsTopLevel(win, { documentElement: null } as unknown as Document)).toBe(false);
  });

  it('does not throw into the page when the document misbehaves', () => {
    const { win } = fakePage(true);
    const doc = {
      documentElement: {},
      createElement: () => {
        throw new Error('no');
      },
    } as unknown as Document;
    expect(presentAsTopLevel(win, doc)).toBe(false);
  });
});

describe('refuseBackgroundWorkers', () => {
  class FakeContainer {}
  class FakeDomException extends Error {
    constructor(message: string, public readonly kind: string) {
      super(message);
      this.name = kind;
    }
  }

  function fakeWindow(withDomException = true) {
    const win: Record<string, unknown> = {
      navigator: { serviceWorker: new FakeContainer() },
      SharedWorker: class {},
    };
    if (withDomException) win.DOMException = FakeDomException;
    return win as unknown as Window & { navigator: { serviceWorker: Record<string, (...a: unknown[]) => Promise<unknown>> } };
  }

  it('makes register reject with a SecurityError from the page\'s own exception type', async () => {
    const win = fakeWindow();
    refuseBackgroundWorkers(win);
    const rejection = await win.navigator.serviceWorker.register('/sw.js').catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(FakeDomException);
    expect((rejection as Error).name).toBe('SecurityError');
  });

  it('rejects with a plain Error where the page has no DOMException', async () => {
    const win = fakeWindow(false);
    refuseBackgroundWorkers(win);
    await expect(win.navigator.serviceWorker.register('/sw.js')).rejects.toBeInstanceOf(Error);
  });

  it('lists no registrations', async () => {
    const win = fakeWindow();
    refuseBackgroundWorkers(win);
    await expect(win.navigator.serviceWorker.getRegistrations()).resolves.toEqual([]);
    await expect(win.navigator.serviceWorker.getRegistration()).resolves.toBeUndefined();
  });

  it('removes SharedWorker', () => {
    const win = fakeWindow();
    refuseBackgroundWorkers(win);
    expect((win as unknown as { SharedWorker: unknown }).SharedWorker).toBeUndefined();
  });

  it('still removes SharedWorker where there is no service worker container', () => {
    const win = { navigator: {}, SharedWorker: class {} } as unknown as Window;
    refuseBackgroundWorkers(win);
    expect((win as unknown as { SharedWorker: unknown }).SharedWorker).toBeUndefined();
  });

  it('never throws into the page, even for a hostile window', () => {
    const hostile = {
      get navigator(): never {
        throw new Error('no');
      },
    } as unknown as Window;
    expect(() => refuseBackgroundWorkers(hostile)).not.toThrow();
  });
});
