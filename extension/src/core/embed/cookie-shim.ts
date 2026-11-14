// Cookie bridge for pages embedded in the workspace: the jar model both halves share, and the
// document.cookie accessor the MAIN-world half installs.
//
// Why: a page in a frame of an extension page is a cross-site frame, so its scripts can read and
// write only SameSite=None cookies through document.cookie, while the browser still sends all of
// the site's cookies on its requests (spike logs e2b.json, e2.json). Sites that read a cookie
// from script (a CSRF token, a session hint) break. The isolated-world half asks the service
// worker for the cookies a script on this address could read in an ordinary tab, hands them to
// the MAIN-world accessor, and forwards what the page assigns.
//
// Pure apart from `installCookieShim`, which takes the prototype, document and event target it
// works on, so tests can use a fake native accessor.

export interface CookiePair {
  name: string;
  value: string;
}

export interface CookieContext {
  /** location.hostname of the page. */
  host: string;
  /** location.pathname of the page. */
  path: string;
  now: number;
}

/** Isolated half → MAIN half: `{ cookie, ack }` as a JSON string. */
export const COOKIE_JAR_EVENT = 'threadkeeper:embed-cookie-jar';
/** MAIN half → isolated half: `{ seq, cookie }` (the raw assignment) as a JSON string. */
export const COOKIE_SET_EVENT = 'threadkeeper:embed-cookie-set';
/** MAIN half → isolated half: the accessor is installed, deliver the current jar again. */
export const COOKIE_READY_EVENT = 'threadkeeper:embed-cookie-ready';

/** Longer assignments are refused by the browser anyway (4096 bytes for name and value). */
export const MAX_ASSIGNMENT_LENGTH = 8192;
/** Upper bound on a delivered cookie string (about 180 cookies of 4 KB). */
export const MAX_JAR_LENGTH = 800_000;
/** Assignments kept until the worker confirms them; beyond this the oldest are dropped. */
const MAX_PENDING = 100;

// ---------------------------------------------------------------------------------------------
// Jar model
// ---------------------------------------------------------------------------------------------

/** "a=b; c=d" as document.cookie returns it. A part without '=' is a cookie with an empty name. */
export function parseCookieString(text: string): CookiePair[] {
  const pairs: CookiePair[] = [];
  for (const part of text.split(';')) {
    const segment = part.trim();
    if (!segment) continue;
    const eq = segment.indexOf('=');
    if (eq === -1) pairs.push({ name: '', value: segment });
    else pairs.push({ name: segment.slice(0, eq).trim(), value: segment.slice(eq + 1).trim() });
  }
  return pairs;
}

export function serializeCookies(pairs: readonly CookiePair[]): string {
  return pairs.map((p) => (p.name === '' ? p.value : `${p.name}=${p.value}`)).join('; ');
}

/** Every pair of `first`, then the pairs of `second` whose name `first` does not have. */
export function unionCookies(first: readonly CookiePair[], second: readonly CookiePair[]): CookiePair[] {
  const names = new Set(first.map((p) => p.name));
  return [...first, ...second.filter((p) => !names.has(p.name))];
}

/** RFC 6265 path-match: the cookie path is the request path or a directory prefix of it. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

/**
 * The jar after `document.cookie = raw` on the page described by `ctx`, as far as this page's
 * own view goes: name and value, Path and Domain (an assignment this page would not see, or the
 * browser would refuse for its domain, leaves the jar alone), and deletion through Max-Age or a
 * past Expires (Max-Age wins). HttpOnly, SameSite, Secure and the __Host-/__Secure- prefixes
 * are not checked here: the worker sets the cookie through the cookies API with the browser's
 * own rules, and the next refresh replaces this jar with what it actually holds.
 */
export function applyCookieAssignment(jar: readonly CookiePair[], raw: string, ctx: CookieContext): CookiePair[] {
  const [pairPart, ...attributeParts] = raw.split(';');
  const eq = pairPart.indexOf('=');
  const name = eq === -1 ? '' : pairPart.slice(0, eq).trim();
  const value = (eq === -1 ? pairPart : pairPart.slice(eq + 1)).trim();
  if (!name && !value) return jar.slice();

  let maxAge: number | null = null;
  let expires: number | null = null;
  let domain: string | null = null;
  let path: string | null = null;
  for (const part of attributeParts) {
    const at = part.indexOf('=');
    const key = (at === -1 ? part : part.slice(0, at)).trim().toLowerCase();
    const val = at === -1 ? '' : part.slice(at + 1).trim();
    if (key === 'max-age') {
      if (/^-?\d+$/.test(val)) maxAge = Number(val);
    } else if (key === 'expires') {
      const ms = Date.parse(val);
      if (Number.isFinite(ms)) expires = ms;
    } else if (key === 'domain') {
      const d = val.replace(/^\./, '').toLowerCase();
      if (d) domain = d;
    } else if (key === 'path') {
      if (val.startsWith('/')) path = val;
    }
  }

  const host = ctx.host.toLowerCase();
  if (domain !== null && host !== domain && !host.endsWith(`.${domain}`)) return jar.slice();
  if (path !== null && !pathMatches(ctx.path || '/', path)) return jar.slice();

  const expired = maxAge !== null ? maxAge <= 0 : expires !== null && expires <= ctx.now;
  if (expired) return jar.filter((p) => p.name !== name);
  const at = jar.findIndex((p) => p.name === name);
  if (at === -1) return [...jar, { name, value }];
  const next = jar.slice();
  next[at] = { name, value };
  return next;
}

// ---------------------------------------------------------------------------------------------
// Event payloads (JSON strings: a string detail crosses between the page and isolated worlds)
// ---------------------------------------------------------------------------------------------

export function parseJarDetail(detail: unknown): { cookie: string; ack: number } | null {
  if (typeof detail !== 'string' || detail.length > MAX_JAR_LENGTH + 100) return null;
  try {
    const value: unknown = JSON.parse(detail);
    if (typeof value !== 'object' || value === null) return null;
    const { cookie, ack } = value as { cookie?: unknown; ack?: unknown };
    if (typeof cookie !== 'string' || cookie.length > MAX_JAR_LENGTH) return null;
    if (typeof ack !== 'number' || !Number.isSafeInteger(ack) || ack < 0) return null;
    return { cookie, ack };
  } catch {
    return null;
  }
}

export function parseSetDetail(detail: unknown): { seq: number; cookie: string } | null {
  if (typeof detail !== 'string' || detail.length > MAX_ASSIGNMENT_LENGTH + 100) return null;
  try {
    const value: unknown = JSON.parse(detail);
    if (typeof value !== 'object' || value === null) return null;
    const { seq, cookie } = value as { seq?: unknown; cookie?: unknown };
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return null;
    if (typeof cookie !== 'string' || cookie.length === 0 || cookie.length > MAX_ASSIGNMENT_LENGTH) return null;
    return { seq, cookie };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The accessor state
// ---------------------------------------------------------------------------------------------

export interface CookieShimOptions {
  /** The native getter on the page's document. */
  nativeGet(): string;
  context(): CookieContext;
  /** Tell the isolated half about an assignment. */
  forward(seq: number, raw: string): void;
}

export interface CookieShim {
  /** True once the isolated half delivered a cookie string. */
  active(): boolean;
  /** What document.cookie returns. */
  read(): string;
  /** Record an assignment the native setter has already seen. */
  write(raw: string): void;
  /** A cookie string from the worker that reflects every assignment up to `ack`. */
  deliver(cookie: string, ack: number): void;
}

export function createCookieShim(options: CookieShimOptions): CookieShim {
  let base: CookiePair[] | null = null;
  let jar: CookiePair[] = [];
  let seq = 0;
  // Assignments the worker has not confirmed yet. They are laid over each delivered string, so
  // a refresh that was already on its way does not undo what the page just set.
  let pending: Array<{ seq: number; raw: string }> = [];

  const rebuild = () => {
    if (base === null) return;
    const ctx = options.context();
    jar = pending.reduce((acc, p) => applyCookieAssignment(acc, p.raw, ctx), base);
  };

  return {
    active: () => base !== null,
    read() {
      const native = options.nativeGet();
      if (base === null) return native;
      // Native cookies (SameSite=None, which the frame can see itself) fill in names the
      // bridged string does not have yet.
      return serializeCookies(unionCookies(jar, parseCookieString(native)));
    },
    write(raw) {
      if (raw.length === 0 || raw.length > MAX_ASSIGNMENT_LENGTH) return;
      seq += 1;
      pending.push({ seq, raw });
      if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);
      if (base !== null) jar = applyCookieAssignment(jar, raw, options.context());
      options.forward(seq, raw);
    },
    deliver(cookie, ack) {
      base = parseCookieString(cookie);
      pending = pending.filter((p) => p.seq > ack);
      rebuild();
    },
  };
}

export interface InstallCookieShimOptions {
  /** Where the native `cookie` accessor lives: Document.prototype in a page. */
  proto: object;
  /** The one document whose cookies are bridged; other documents keep the native accessor. */
  doc: object;
  /** Where the bridge events are dispatched and heard: the document. */
  events: EventTarget;
  context(): CookieContext;
}

/**
 * Replace the `cookie` accessor on `proto` with one that serves the bridged jar once the
 * isolated half has delivered one, and the native value until then. The native setter always
 * runs first, so SameSite=None cookies keep working natively and a native error (an invalid
 * receiver) is thrown exactly as before. Nothing else this adds can throw into the page.
 *
 * The cookieStore API is deliberately left alone: replacing an async API the page may hold
 * references to is riskier than the gap, and the spike showed the frame's cookieStore.set
 * failing for every cookie anyway, so pages that use it already have a fallback.
 *
 * Returns false when the accessor is missing or cannot be replaced.
 */
export function installCookieShim(options: InstallCookieShimOptions): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(options.proto, 'cookie');
  if (!descriptor?.get || !descriptor.set || !descriptor.configurable) return false;
  const nativeGet = descriptor.get;
  const nativeSet = descriptor.set;
  // Held now: page scripts that run later may replace any of these globals.
  const dispatch = EventTarget.prototype.dispatchEvent;
  const listen = EventTarget.prototype.addEventListener;
  const EventCtor = CustomEvent;
  const stringify = JSON.stringify;
  const { doc, events } = options;

  const send = (type: string, detail?: string) => {
    try {
      Reflect.apply(dispatch, events, [new EventCtor(type, detail === undefined ? undefined : { detail })]);
    } catch {
      // never disturb the page
    }
  };

  const shim = createCookieShim({
    nativeGet: () => Reflect.apply(nativeGet, doc, []) as string,
    context: options.context,
    forward: (seq, raw) => send(COOKIE_SET_EVENT, stringify({ seq, cookie: raw })),
  });

  Object.defineProperty(options.proto, 'cookie', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: function cookie(this: unknown): string {
      if (this !== doc || !shim.active()) return Reflect.apply(nativeGet, this, []) as string;
      try {
        return shim.read();
      } catch {
        return Reflect.apply(nativeGet, this, []) as string;
      }
    },
    set: function cookie(this: unknown, value: unknown): void {
      // String() once, as the native setter would; a value that cannot be a string throws the
      // same TypeError the native setter would throw.
      const text = String(value);
      Reflect.apply(nativeSet, this, [text]);
      if (this !== doc) return;
      try {
        shim.write(text);
      } catch {
        // never disturb the page
      }
    },
  });

  Reflect.apply(listen, events, [
    COOKIE_JAR_EVENT,
    (event: Event) => {
      try {
        const parsed = parseJarDetail((event as CustomEvent).detail);
        if (parsed) shim.deliver(parsed.cookie, parsed.ack);
      } catch {
        // never disturb the page
      }
    },
  ]);
  send(COOKIE_READY_EVENT);
  return true;
}
