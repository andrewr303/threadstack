// @vitest-environment-options {"url": "https://claude.ai/code/session_011CUabc"}
// The content script inside a Claude Code page embedded directly in ThreadStack's workspace,
// and the frame test every content script starts with.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { embeddedInExtensionPage, frameMode, paneName, type FrameWindow } from '../../src/core/embed/frame.js';

// The identity matchers and parsers are another module's placeholders; these stand-ins make
// the plumbing testable without depending on any site's real response shape.
vi.mock('../../src/core/accounts/identity.js', () => ({
  matchIdentityRequest: (_host: string, url: string) => (url.endsWith('/api/account') ? 'claude_account' : null),
  providerForIdentitySource: (source: string) =>
    source === 'chatgpt_session' ? 'chatgpt' : source === 'claude_account' ? 'claude' : 'cursor_agents',
  parseIdentity: (_source: string, json: { id?: unknown }) =>
    typeof json?.id === 'string' ? { key: `k-${json.id}`, display: null, source: 'network' } : null,
}));

const EXT = 'chrome-extension://tk-test-id';

describe('frameMode and paneName', () => {
  const fake = (top: unknown, ancestors: string[] | undefined, name = ''): FrameWindow => {
    const win = { top, name, location: { ancestorOrigins: ancestors } } as FrameWindow;
    if (top === 'self') win.top = win;
    return win;
  };

  beforeAll(() => {
    vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `${EXT}/${p}` } });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('is top in a tab of its own', () => {
    expect(frameMode(fake('self', []))).toBe('top');
    expect(embeddedInExtensionPage(fake('self', []))).toBe(false);
  });

  it('is workspace only directly inside ThreadStack\'s own page', () => {
    expect(frameMode(fake({}, [EXT]))).toBe('workspace');
    expect(embeddedInExtensionPage(fake({}, [EXT]))).toBe(true);
  });

  it('is other inside another extension, a website, or deeper inside an embedded page', () => {
    expect(frameMode(fake({}, ['chrome-extension://someone-else']))).toBe('other');
    expect(embeddedInExtensionPage(fake({}, ['chrome-extension://someone-else']))).toBe(true); // the MAIN world cannot tell; it stays inert
    expect(frameMode(fake({}, ['https://evil.example']))).toBe('other');
    expect(frameMode(fake({}, ['https://claude.ai', EXT]))).toBe('other');
    expect(embeddedInExtensionPage(fake({}, ['https://claude.ai', EXT]))).toBe(false);
    expect(frameMode(fake({}, undefined))).toBe('other');
  });

  it('is other when the extension context is gone', () => {
    vi.stubGlobal('chrome', { runtime: {} });
    expect(frameMode(fake({}, [EXT]))).toBe('other');
    vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `${EXT}/${p}` } });
  });

  it('reads the pane id from the frame name', () => {
    expect(paneName({ name: 'tk-pane~tab_1a2b' })).toBe('tab_1a2b');
    expect(paneName({ name: 'tk-pane~thread~claude::abc' })).toBe('thread~claude::abc');
    expect(paneName({ name: 'tk-pane~' })).toBeNull();
    expect(paneName({ name: 'some-site-window' })).toBeNull();
    expect(paneName({ name: '' })).toBeNull();
  });
});

type Sent = { type?: string; payload?: Record<string, unknown>; [k: string]: unknown };
type Listener = (m: unknown, s: unknown, r: (x: unknown) => void) => unknown;

describe('content script in a workspace frame', () => {
  const sent: Sent[] = [];
  const listeners: Listener[] = [];
  const navigation = Object.assign(new EventTarget(), {
    canGoBack: true,
    canGoForward: false,
    back: vi.fn(() => ({ committed: Promise.resolve(), finished: Promise.resolve() })),
    forward: vi.fn(() => ({ committed: Promise.resolve(), finished: Promise.resolve() })),
  });
  const originalRects = Element.prototype.getClientRects;

  beforeAll(async () => {
    vi.useFakeTimers();
    // jsdom lays nothing out; treat everything outside [hidden] as on screen.
    Element.prototype.getClientRects = function (this: Element) {
      return (this.closest('[hidden]') ? [] : [{}]) as unknown as DOMRectList;
    };
    Object.defineProperty(window, 'top', { configurable: true, value: {} });
    Object.defineProperty(window.location, 'ancestorOrigins', { configurable: true, value: [EXT] });
    Object.defineProperty(window, 'navigation', { configurable: true, value: navigation });
    window.name = 'tk-pane~tab_77aa';
    document.head.innerHTML = '<title>Fix flaky test - Claude Code</title>';
    document.body.innerHTML = `<main>
      <a href="https://github.com/acme/billing-service">acme/billing-service</a>
      <div data-testid="user-message">Fix the flaky invoice test</div>
      <div class="font-claude-response">I found a race in the clock mock.</div>
      <button aria-label="Stop">Stop</button></main>`;
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'tk-test-id',
        getURL: (p: string) => `${EXT}/${p}`,
        lastError: undefined,
        sendMessage: (message: Sent, cb?: (r: unknown) => void) => {
          sent.push(message);
          if (message.type === 'EMBED_HELLO') cb?.({ ok: true, frameId: 7, tabId: 3 });
          else cb?.({ ok: true });
        },
        onMessage: { addListener: (fn: Listener) => listeners.push(fn) },
      },
    });
    await import('../../src/entrypoints/content.js');
  });

  afterAll(() => {
    Element.prototype.getClientRects = originalRects;
    vi.useRealTimers();
  });

  const ofType = (type: string) => sent.filter((m) => m.type === type);
  /** What the content script answers, or 'ignored' when no listener took the message. */
  const ask = (message: Record<string, unknown>): unknown => {
    let answer: unknown = 'ignored';
    for (const fn of listeners) {
      const took = fn(message, {}, (r) => (answer = r));
      if (took === true) break;
    }
    return answer;
  };

  it('says hello with its pane, address and title, then reports the history state', () => {
    expect(sent[0]).toEqual({
      type: 'EMBED_HELLO',
      pane: 'tab_77aa',
      url: 'https://claude.ai/code/session_011CUabc',
      title: 'Fix flaky test - Claude Code',
      // An ordinary frame: it loads with the browser's own sign-in.
      profile: false,
    });
    expect(ofType('EMBED_NAV')[0]).toEqual({
      type: 'EMBED_NAV',
      pane: 'tab_77aa',
      url: 'https://claude.ai/code/session_011CUabc',
      title: 'Fix flaky test - Claude Code',
      canGoBack: true,
      canGoForward: false,
    });
  });

  it('still captures the conversation, with the run state and repository the page shows', async () => {
    await vi.advanceTimersByTimeAsync(8000);
    const captures = ofType('PASSIVE_DOM_CAPTURE');
    expect(captures.length).toBeGreaterThan(0);
    expect(captures.at(-1)!.payload).toMatchObject({
      provider: 'claude_code',
      sourceConversationId: 'session_011CUabc',
      captureSource: 'dom_observer',
      agentState: 'running',
      repository: 'acme/billing-service',
    });
  });

  it('never builds the in-page overlay', () => {
    expect(ask({ type: 'TOGGLE_THREADKEEPER_OVERLAY', handshakeToken: 'x'.repeat(32) })).toBe('ignored');
    expect(document.getElementById('threadkeeper-overlay-root')).toBeNull();
  });

  it('ignores commands for top frames unless the worker addressed this frame', () => {
    expect(ask({ type: 'TK_CAPTURE_PROBE' })).toBe('ignored');
    expect(ask({ type: 'TK_CAPTURE_PROBE', frameId: 9 })).toBe('ignored');
    expect(ask({ type: 'TK_HISTORY_SYNC_CANCEL' })).toBe('ignored');
    expect(ask({ type: 'TK_CAPTURE_PROBE', frameId: 7 })).toMatchObject({ ok: true, report: { provider: 'claude_code' } });
    expect(ask({ type: 'TK_PING' })).toEqual({ ok: true });
  });

  it('reports a title change', async () => {
    const before = ofType('EMBED_NAV').length;
    document.title = 'Fix flaky test (done) - Claude Code';
    await vi.advanceTimersByTimeAsync(200);
    expect(ofType('EMBED_NAV').slice(before)).toEqual([
      expect.objectContaining({ title: 'Fix flaky test (done) - Claude Code', canGoBack: true }),
    ]);
  });

  it('runs back and forward through the Navigation API and refuses what it cannot do', () => {
    expect(ask({ type: 'TK_EMBED_COMMAND', command: 'back' })).toEqual({ ok: true });
    expect(navigation.back).toHaveBeenCalledTimes(1);
    expect(ask({ type: 'TK_EMBED_COMMAND', command: 'forward' })).toEqual({ ok: false, error: 'no_history' });
    expect(navigation.forward).not.toHaveBeenCalled();
    expect(ask({ type: 'TK_EMBED_COMMAND', command: 'self-destruct' })).toEqual({ ok: false, error: 'unknown_command' });
  });

  it('navigates to https addresses only', async () => {
    expect(ask({ type: 'TK_EMBED_COMMAND', command: 'navigate', url: 'http://claude.ai/code' })).toEqual({ ok: false, error: 'bad_url' });
    expect(ask({ type: 'TK_EMBED_COMMAND', command: 'navigate', url: 'javascript:alert(1)' })).toEqual({ ok: false, error: 'bad_url' });
    expect(ask({ type: 'TK_EMBED_COMMAND', command: 'navigate', url: 'not a url' })).toEqual({ ok: false, error: 'bad_url' });
    // A same-document address is one jsdom can follow.
    expect(ask({ type: 'TK_EMBED_COMMAND', command: 'navigate', url: 'https://claude.ai/code/session_011CUabc#diff' })).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(window.location.hash).toBe('#diff');
  });

  it('reports run state changes, at most every two seconds', async () => {
    const states = () => ofType('EMBED_AGENT_STATE').map((m) => m.state);
    await vi.advanceTimersByTimeAsync(2500);
    expect(states().at(-1)).toBe('running');
    const before = ofType('EMBED_AGENT_STATE').length;

    document.querySelector('button[aria-label="Stop"]')!.remove();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<p>Claude wants to run npm test</p><button>Allow</button><button>Deny</button>';
    document.body.appendChild(dialog);
    await vi.advanceTimersByTimeAsync(2100);
    expect(states().slice(before)).toEqual(['waiting_permission']);
    expect(ofType('EMBED_AGENT_STATE').at(-1)).toMatchObject({ pane: 'tab_77aa', url: expect.stringContaining('/code/session_011CUabc') });

    // Unchanged: nothing more is sent.
    document.body.appendChild(document.createElement('span'));
    await vi.advanceTimersByTimeAsync(2100);
    expect(states().slice(before)).toEqual(['waiting_permission']);
    dialog.remove();
  });

  describe('identity from the page-world observer', () => {
    const deliver = (data: unknown, init: { origin?: string; source?: MessageEventSource | null } = {}) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          data,
          origin: init.origin ?? window.location.origin,
          source: init.source === undefined ? window : init.source,
        })
      );
    const identityMessage = (body: string, kind = 'claude_account') => ({ source: 'threadkeeper-identity', kind, body });
    const identities = () => ofType('ACCOUNT_IDENTITY');

    it('sends a parsed identity once per key', () => {
      deliver(identityMessage('{"id":"u1"}'));
      deliver(identityMessage('{"id":"u1"}'));
      expect(identities()).toEqual([
        { type: 'ACCOUNT_IDENTITY', provider: 'claude', identity: { key: 'k-u1', display: null, source: 'network' } },
      ]);
      deliver(identityMessage('{"id":"u2"}'));
      expect(identities()).toHaveLength(2);
    });

    it('drops messages from another origin or sender, oversized or unparseable bodies, and unknown shapes', () => {
      const before = identities().length;
      const iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      deliver(identityMessage('{"id":"x1"}'), { origin: 'https://evil.example' });
      deliver(identityMessage('{"id":"x2"}'), { source: iframe.contentWindow });
      deliver(identityMessage('{"id":"x3"}'), { source: null });
      deliver(identityMessage(`{"id":"x4","pad":"${'a'.repeat(70 * 1024)}"}`));
      deliver(identityMessage('{"id":'));
      deliver(identityMessage('{"name":"no id"}'));
      deliver(identityMessage('{"id":"x5"}', 'gmail_profile'));
      deliver(identityMessage('{"id":"x6"}', 'chatgpt_session')); // another sign-in than this page's
      deliver({ source: 'threadkeeper-identity', kind: 'claude_account', body: { id: 'x7' } });
      deliver({ source: 'someone-else', kind: 'claude_account', body: '{"id":"x8"}' });
      expect(identities().length).toBe(before);
      iframe.remove();
    });
  });

  it('says nobody is signed in once, on a plain sign-in page', async () => {
    const before = ofType('ACCOUNT_IDENTITY').length;
    history.replaceState(null, '', '/login');
    document.body.innerHTML = '<form><input type="email" name="email"><button>Continue with email</button></form>';
    await vi.advanceTimersByTimeAsync(4000);
    expect(ofType('ACCOUNT_IDENTITY').slice(before)).toEqual([{ type: 'ACCOUNT_IDENTITY', provider: 'claude', identity: null }]);
    document.body.appendChild(document.createElement('span'));
    await vi.advanceTimersByTimeAsync(4000);
    expect(ofType('ACCOUNT_IDENTITY').slice(before)).toHaveLength(1);
  });
});

describe('MAIN-world identity observer', () => {
  const pageFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

  beforeAll(async () => {
    window.fetch = pageFetch;
    await import('../../src/entrypoints/site-data-main.js');
  });

  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('posts the identity response from a clone and hands the page the untouched response', async () => {
    const spy = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const response = new Response('{"id":"u1"}', { status: 200 });
    pageFetch.mockResolvedValueOnce(response);
    const got = await window.fetch('/api/account');
    expect(got).toBe(response);
    expect(await got.text()).toBe('{"id":"u1"}');
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual([{ source: 'threadkeeper-identity', kind: 'claude_account', body: '{"id":"u1"}' }, 'https://claude.ai']);
    spy.mockRestore();
  });

  it('ignores sends, failures, other addresses and bodies over 64 KB', async () => {
    const spy = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    pageFetch.mockResolvedValueOnce(new Response('{"id":"u1"}'));
    await window.fetch('/api/account', { method: 'POST', body: '{}' });
    pageFetch.mockResolvedValueOnce(new Response('nope', { status: 401 }));
    await window.fetch('/api/account');
    pageFetch.mockResolvedValueOnce(new Response('{"id":"u1"}'));
    await window.fetch('/api/other');
    const big = new Response(`{"id":"u1","pad":"${'a'.repeat(70 * 1024)}"}`);
    pageFetch.mockResolvedValueOnce(big);
    const got = await window.fetch('/api/account');
    expect((await got.text()).length).toBeGreaterThan(70 * 1024); // the page still reads all of it
    await flush();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('markEmbeddedDocument', () => {
  // Called by embed-bridge.ts's startup (and only when frameMode() is 'workspace') with the
  // result of inProfileFrame() and wantsTopLevelView(host) && !paneHasFlag('n').
  const load = async () => {
    const [bridge, profilePage, frame] = await Promise.all([
      import('../../src/entrypoints/embed-bridge.js'),
      import('../../src/core/embed/profile-page.js'),
      import('../../src/core/embed/frame.js'),
    ]);
    return { markEmbeddedDocument: bridge.markEmbeddedDocument, PROFILE_MARK: profilePage.PROFILE_MARK, TOP_LEVEL_MARK: frame.TOP_LEVEL_MARK };
  };
  const fresh = () => ({ documentElement: document.createElement('html') });

  it('leaves no mark when neither is asked for', async () => {
    const { markEmbeddedDocument } = await load();
    const doc = fresh();
    markEmbeddedDocument(doc, { profile: false, topLevel: false });
    expect(doc.documentElement.getAttributeNames()).toEqual([]);
  });

  it('marks a profile frame for the page-world script', async () => {
    const { markEmbeddedDocument, PROFILE_MARK, TOP_LEVEL_MARK } = await load();
    const doc = fresh();
    markEmbeddedDocument(doc, { profile: true, topLevel: false });
    expect(doc.documentElement.hasAttribute(PROFILE_MARK)).toBe(true);
    expect(doc.documentElement.hasAttribute(TOP_LEVEL_MARK)).toBe(false);
  });

  it('marks a frame that should answer framing checks like a top-level page', async () => {
    const { markEmbeddedDocument, PROFILE_MARK, TOP_LEVEL_MARK } = await load();
    const doc = fresh();
    markEmbeddedDocument(doc, { profile: false, topLevel: true });
    expect(doc.documentElement.hasAttribute(TOP_LEVEL_MARK)).toBe(true);
    expect(doc.documentElement.hasAttribute(PROFILE_MARK)).toBe(false);
  });

  it('can leave both marks', async () => {
    const { markEmbeddedDocument } = await load();
    const doc = fresh();
    markEmbeddedDocument(doc, { profile: true, topLevel: true });
    expect(doc.documentElement.getAttributeNames().sort()).toEqual(['data-tk-profile', 'data-tk-top-level']);
  });

  it('is silent when there is no document element or setting an attribute throws', async () => {
    const { markEmbeddedDocument } = await load();
    expect(() => markEmbeddedDocument({ documentElement: null as unknown as HTMLElement }, { profile: true, topLevel: true })).not.toThrow();
    const hostile = {
      documentElement: {
        setAttribute() {
          throw new Error('no');
        },
      } as unknown as HTMLElement,
    };
    expect(() => markEmbeddedDocument(hostile, { profile: true, topLevel: true })).not.toThrow();
  });

  it('writes marks the page-world script consumes exactly once', async () => {
    const { markEmbeddedDocument, PROFILE_MARK } = await load();
    const { consumeMark } = await import('../../src/core/embed/profile-page.js');
    const doc = fresh();
    markEmbeddedDocument(doc, { profile: true, topLevel: false });
    expect(consumeMark(doc, PROFILE_MARK)).toBe(true);
    expect(consumeMark(doc, PROFILE_MARK)).toBe(false);
  });
});
