// Cookie bridge for embedded pages: the jar model, the document.cookie accessor against a fake
// native accessor, and the isolated-world half (core/embed/cookie-shim.ts, entrypoints/embed-bridge.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COOKIE_JAR_EVENT,
  COOKIE_READY_EVENT,
  COOKIE_SET_EVENT,
  applyCookieAssignment,
  installCookieShim,
  parseCookieString,
  parseJarDetail,
  parseSetDetail,
  serializeCookies,
  unionCookies,
  type CookieContext,
  type CookiePair,
} from '../../src/core/embed/cookie-shim.js';
import { COOKIE_CACHE_KEY, startCookieBridge } from '../../src/entrypoints/embed-bridge.js';
import type { EmbedFrameEvent } from '../../src/core/workspace/types.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const ctx: CookieContext = { host: 'chatgpt.com', path: '/c/abc', now: NOW };
const jar = (text: string) => parseCookieString(text);
const apply = (start: string, raw: string, c: CookieContext = ctx) => serializeCookies(applyCookieAssignment(jar(start), raw, c));

describe('jar model', () => {
  it('parses document.cookie strings, keeping "=" inside values and trimming odd whitespace', () => {
    expect(parseCookieString('a=b; c=d')).toEqual([
      { name: 'a', value: 'b' },
      { name: 'c', value: 'd' },
    ]);
    expect(parseCookieString('  tok=abc==;\tq = x=y=z ;;  ;flag')).toEqual([
      { name: 'tok', value: 'abc==' },
      { name: 'q', value: 'x=y=z' },
      { name: '', value: 'flag' },
    ]);
    expect(parseCookieString('')).toEqual([]);
  });

  it('serialises back to the document.cookie form', () => {
    expect(serializeCookies(jar('a=b;c=d=e; flag'))).toBe('a=b; c=d=e; flag');
    expect(serializeCookies([])).toBe('');
  });

  it('unions by name, the first list winning', () => {
    const first: CookiePair[] = [{ name: 'a', value: '1' }];
    expect(serializeCookies(unionCookies(first, jar('a=native; n=1')))).toBe('a=1; n=1');
  });

  it('adds, replaces in place and keeps values with "="', () => {
    expect(apply('a=1; b=2', 'c=x=y; Path=/; SameSite=Lax')).toBe('a=1; b=2; c=x=y');
    expect(apply('a=1; b=2', ' a = 9 ')).toBe('a=9; b=2');
    expect(apply('a=1', 'lonely')).toBe('a=1; lonely');
    expect(apply('a=1', '   ;Path=/')).toBe('a=1');
  });

  it('deletes through Max-Age or a past Expires, Max-Age winning', () => {
    expect(apply('a=1; b=2', 'a=; Max-Age=0')).toBe('b=2');
    expect(apply('a=1; b=2', 'a=gone; expires=Thu, 01 Jan 1970 00:00:00 GMT')).toBe('b=2');
    expect(apply('a=1', 'a=2; Expires=Thu, 01 Jan 2099 00:00:00 GMT')).toBe('a=2');
    expect(apply('a=1', 'a=2; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT')).toBe('a=2');
    expect(apply('a=1', 'a=2; max-age=-1; Expires=Thu, 01 Jan 2099 00:00:00 GMT')).toBe('');
    expect(apply('a=1', 'a=2; Max-Age=soon')).toBe('a=2'); // an invalid Max-Age is ignored
  });

  it('leaves the jar alone for a Path or Domain this page would not see', () => {
    expect(apply('a=1', 'b=2; Path=/admin')).toBe('a=1');
    expect(apply('a=1', 'b=2; Path=/c')).toBe('a=1; b=2');
    expect(apply('a=1', 'b=2; Path=/c/')).toBe('a=1; b=2');
    expect(apply('a=1', 'b=2; Path=/c/ab')).toBe('a=1');
    expect(apply('a=1', 'b=2; Domain=.chatgpt.com')).toBe('a=1; b=2');
    expect(apply('a=1', 'b=2; Domain=openai.com')).toBe('a=1');
    expect(apply('a=1', 'b=2; Domain=t.chatgpt.com')).toBe('a=1');
    expect(apply('a=1', 'b=2', { ...ctx, host: 'ab.chatgpt.com' })).toBe('a=1; b=2');
  });

  it('leaves HttpOnly and the __Host-/__Secure- prefixes to the worker', () => {
    expect(apply('a=1', 'h=2; HttpOnly')).toBe('a=1; h=2');
    expect(apply('a=1', '__Host-x=3; Domain=chatgpt.com')).toBe('a=1; __Host-x=3');
    expect(apply('a=1', '__Secure-y=4')).toBe('a=1; __Secure-y=4');
  });

  it('accepts only well-formed event payloads', () => {
    expect(parseJarDetail(JSON.stringify({ cookie: 'a=1', ack: 2 }))).toEqual({ cookie: 'a=1', ack: 2 });
    expect(parseJarDetail({ cookie: 'a=1', ack: 2 })).toBeNull();
    expect(parseJarDetail(JSON.stringify({ cookie: 1, ack: 2 }))).toBeNull();
    expect(parseJarDetail(JSON.stringify({ cookie: 'a', ack: -1 }))).toBeNull();
    expect(parseJarDetail('{')).toBeNull();
    expect(parseSetDetail(JSON.stringify({ seq: 1, cookie: 'a=1' }))).toEqual({ seq: 1, cookie: 'a=1' });
    expect(parseSetDetail(JSON.stringify({ seq: 0, cookie: 'a=1' }))).toBeNull();
    expect(parseSetDetail(JSON.stringify({ seq: 1, cookie: '' }))).toBeNull();
    expect(parseSetDetail(JSON.stringify({ seq: 1, cookie: 'x'.repeat(9000) }))).toBeNull();
  });
});

/** A document with a native-like accessor: it sees only the cookies set through it. */
function fakeDocument() {
  class FakeDocument {
    nativeJar: CookiePair[] = [];
  }
  const nativeSet = vi.fn(function (this: FakeDocument, value: string) {
    if (!(this instanceof FakeDocument)) throw new TypeError('Illegal invocation');
    // Like a cross-site frame: only SameSite=None assignments stick natively.
    if (/samesite=none/i.test(value)) this.nativeJar = applyCookieAssignment(this.nativeJar, value, ctx);
  });
  Object.defineProperty(FakeDocument.prototype, 'cookie', {
    configurable: true,
    enumerable: true,
    get(this: FakeDocument) {
      if (!(this instanceof FakeDocument)) throw new TypeError('Illegal invocation');
      return serializeCookies(this.nativeJar);
    },
    set: nativeSet,
  });
  const doc = new FakeDocument();
  const events = new EventTarget();
  const sets: Array<{ seq: number; cookie: string }> = [];
  events.addEventListener(COOKIE_SET_EVENT, (e) => sets.push(parseSetDetail((e as CustomEvent).detail)!));
  let readies = 0;
  events.addEventListener(COOKIE_READY_EVENT, () => (readies += 1));
  const deliver = (cookie: string, ack: number) =>
    events.dispatchEvent(new CustomEvent(COOKIE_JAR_EVENT, { detail: JSON.stringify({ cookie, ack }) }));
  return { FakeDocument, doc: doc as unknown as { cookie: string; nativeJar: CookiePair[] }, events, sets, deliver, nativeSet, readies: () => readies };
}

describe('installCookieShim against a fake native accessor', () => {
  const install = (f: ReturnType<typeof fakeDocument>) =>
    installCookieShim({ proto: f.FakeDocument.prototype, doc: f.doc, events: f.events, context: () => ctx });

  it('keeps native behaviour until the isolated half delivers, and says it is ready', () => {
    const f = fakeDocument();
    expect(install(f)).toBe(true);
    expect(f.readies()).toBe(1);
    f.doc.cookie = 'n=1; SameSite=None; Secure';
    expect(f.doc.cookie).toBe('n=1');
    expect(f.nativeSet).toHaveBeenCalledWith('n=1; SameSite=None; Secure');
    // Forwarded even before the first delivery.
    expect(f.sets).toEqual([{ seq: 1, cookie: 'n=1; SameSite=None; Secure' }]);
  });

  it('serves the bridged jar, filled in with native names it lacks', () => {
    const f = fakeDocument();
    install(f);
    f.doc.cookie = 'n=1; SameSite=None; Secure';
    f.deliver('csrf=abc; n=1', 1);
    expect(f.doc.cookie).toBe('csrf=abc; n=1');
    f.doc.nativeJar.push({ name: 'only_native', value: 'z' });
    expect(f.doc.cookie).toBe('csrf=abc; n=1; only_native=z');
  });

  it('shows an assignment at once, calls the native setter too, and keeps it until the worker confirms it', () => {
    const f = fakeDocument();
    install(f);
    f.deliver('csrf=abc', 0);
    f.doc.cookie = 'theme=dark; Path=/';
    expect(f.nativeSet).toHaveBeenLastCalledWith('theme=dark; Path=/');
    expect(f.doc.cookie).toBe('csrf=abc; theme=dark');
    expect(f.sets.at(-1)).toEqual({ seq: 1, cookie: 'theme=dark; Path=/' });
    // A refresh sent before the worker had it does not undo it...
    f.deliver('csrf=abc', 0);
    expect(f.doc.cookie).toBe('csrf=abc; theme=dark');
    // ...and once confirmed, the worker's jar is the truth (here it refused the cookie).
    f.deliver('csrf=abc', 1);
    expect(f.doc.cookie).toBe('csrf=abc');
    f.doc.cookie = 'csrf=; Max-Age=0';
    expect(f.doc.cookie).toBe('');
  });

  it('ignores malformed deliveries and never throws into the page', () => {
    const f = fakeDocument();
    install(f);
    f.events.dispatchEvent(new CustomEvent(COOKIE_JAR_EVENT, { detail: '{nope' }));
    f.events.dispatchEvent(new CustomEvent(COOKIE_JAR_EVENT, { detail: { cookie: 'a=1', ack: 0 } }));
    expect(f.doc.cookie).toBe('');
    expect(() => (f.doc.cookie = 'x'.repeat(10_000))).not.toThrow();
    expect(f.sets).toHaveLength(0);
  });

  it('keeps native errors for a wrong receiver and leaves other documents native', () => {
    const f = fakeDocument();
    install(f);
    f.deliver('csrf=abc', 0);
    const desc = Object.getOwnPropertyDescriptor(f.FakeDocument.prototype, 'cookie')!;
    expect(() => desc.get!.call({})).toThrow('Illegal invocation');
    expect(() => desc.set!.call({}, 'a=1')).toThrow('Illegal invocation');
    const other = new f.FakeDocument() as unknown as { cookie: string };
    expect(other.cookie).toBe('');
    other.cookie = 'z=1; SameSite=None';
    expect(other.cookie).toBe('z=1');
    expect(f.sets).toHaveLength(0);
  });

  it('survives a page that wraps document.cookie itself', () => {
    const f = fakeDocument();
    install(f);
    f.deliver('csrf=abc', 0);
    // What consent and analytics libraries do: wrap whatever accessor the prototype has.
    const inner = Object.getOwnPropertyDescriptor(f.FakeDocument.prototype, 'cookie')!;
    const seen: string[] = [];
    Object.defineProperty(f.doc, 'cookie', {
      configurable: true,
      get: () => inner.get!.call(f.doc),
      set: (v: string) => {
        seen.push(v);
        inner.set!.call(f.doc, v);
      },
    });
    f.doc.cookie = 'consent=yes';
    expect(seen).toEqual(['consent=yes']);
    expect(f.doc.cookie).toBe('csrf=abc; consent=yes');
    // And a page that replaces the accessor outright gets its way without an error.
    expect(() => Object.defineProperty(f.FakeDocument.prototype, 'cookie', { configurable: true, value: 'mine' })).not.toThrow();
  });

  it('refuses to install over an accessor it cannot replace', () => {
    const proto = {};
    Object.defineProperty(proto, 'cookie', { configurable: false, get: () => '', set: () => undefined });
    expect(installCookieShim({ proto, doc: {}, events: new EventTarget(), context: () => ctx })).toBe(false);
    expect(installCookieShim({ proto: {}, doc: {}, events: new EventTarget(), context: () => ctx })).toBe(false);
  });
});

describe('isolated half (startCookieBridge)', () => {
  let doc: Document;
  let storage: Storage;
  let sent: EmbedFrameEvent[];
  let answers: Array<(response: unknown) => void>;
  let delivered: Array<{ cookie: string; ack: number }>;
  let stopBridge: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = document.implementation.createHTMLDocument('embedded');
    // A document without a window reports itself hidden; the frame's own document is shown.
    Object.defineProperty(doc, 'visibilityState', { configurable: true, value: 'visible' });
    storage = window.sessionStorage;
    storage.clear();
    sent = [];
    answers = [];
    delivered = [];
    doc.addEventListener(COOKIE_JAR_EVENT, (e) => delivered.push(parseJarDetail((e as CustomEvent).detail)!));
  });
  afterEach(() => {
    stopBridge?.();
    stopBridge = null;
    vi.useRealTimers();
  });

  const start = (alive = true) => {
    const bridge = startCookieBridge({
      doc,
      win: window,
      storage,
      send: (message, done) => {
        if (!alive) return false;
        sent.push(message);
        answers.push(done);
        return true;
      },
    });
    stopBridge = bridge.stop;
  };
  const answerNext = (response: unknown) => answers.shift()!(response);
  const pageSets = (seq: number, cookie: string) =>
    doc.dispatchEvent(new CustomEvent(COOKIE_SET_EVENT, { detail: JSON.stringify({ seq, cookie }) }));

  it('asks the worker (no address sent), delivers the answer and caches it', () => {
    start();
    expect(sent).toEqual([{ type: 'EMBED_COOKIES_GET' }]);
    answerNext({ ok: true, cookie: 'csrf=abc' });
    expect(delivered).toEqual([{ cookie: 'csrf=abc', ack: 0 }]);
    expect(storage.getItem(COOKIE_CACHE_KEY)).toBe('csrf=abc');
  });

  it('delivers the cached copy synchronously and again when the page half says it is ready', () => {
    storage.setItem(COOKIE_CACHE_KEY, 'csrf=old');
    start();
    expect(delivered).toEqual([{ cookie: 'csrf=old', ack: 0 }]);
    doc.dispatchEvent(new CustomEvent(COOKIE_READY_EVENT));
    expect(delivered).toHaveLength(2);
  });

  it('forwards assignments one at a time and refreshes after each', () => {
    start();
    answerNext({ ok: true, cookie: 'csrf=abc' });
    pageSets(1, 'theme=dark');
    pageSets(2, 'lang=en');
    expect(sent.slice(1)).toEqual([{ type: 'EMBED_COOKIE_SET', cookie: 'theme=dark' }]);
    answerNext({ ok: true });
    expect(sent.slice(2)).toEqual([{ type: 'EMBED_COOKIES_GET' }, { type: 'EMBED_COOKIE_SET', cookie: 'lang=en' }]);
    answerNext({ ok: true, cookie: 'csrf=abc; theme=dark' });
    expect(delivered.at(-1)).toEqual({ cookie: 'csrf=abc; theme=dark', ack: 1 });
  });

  it('drops what the page wrote while reading a stale cached copy', () => {
    storage.setItem(COOKIE_CACHE_KEY, 'csrf=account_a');
    start();
    pageSets(1, 'csrf=account_a');
    answerNext({ ok: true, cookie: 'csrf=account_b' });
    expect(sent.filter((m) => m.type === 'EMBED_COOKIE_SET')).toHaveLength(0);
    expect(delivered.at(-1)).toEqual({ cookie: 'csrf=account_b', ack: 1 });
  });

  it('forwards what the page wrote on a cached copy the worker confirms', () => {
    storage.setItem(COOKIE_CACHE_KEY, 'csrf=same');
    start();
    pageSets(1, 'theme=dark');
    answerNext({ ok: true, cookie: 'csrf=same' });
    expect(sent.at(-1)).toEqual({ type: 'EMBED_COOKIE_SET', cookie: 'theme=dark' });
  });

  it('refreshes once a second while visible, without overlapping requests', () => {
    start();
    vi.advanceTimersByTime(3000);
    expect(sent).toHaveLength(1); // the first request is still unanswered
    answerNext({ ok: true, cookie: 'a=1' });
    expect(sent).toHaveLength(2); // the ticks that came meanwhile ask once more
    answerNext({ ok: true, cookie: 'a=1' });
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(3);
    expect(delivered).toHaveLength(1); // unchanged answers are not delivered again
  });

  it('ignores failures and malformed answers, and stops when the extension is gone', () => {
    start();
    answerNext(undefined);
    vi.advanceTimersByTime(1000);
    answerNext({ ok: true, cookie: 42 });
    expect(delivered).toHaveLength(0);
    stopBridge?.();
    start(false);
    vi.advanceTimersByTime(5000);
    expect(sent).toHaveLength(2);
  });
});
