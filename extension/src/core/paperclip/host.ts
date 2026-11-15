/** Messages from the real Paperclip document. Session iframes never share this channel. */
export type PaperclipMode = 'fused' | 'switching';
export type PaperclipHostMessage =
  | { type: 'ready'; mode: PaperclipMode }
  | { type: 'disconnected' }
  | { type: 'route'; path: string; title: string }
  | { type: 'open-view'; view: 'browse' | 'threads' | 'dashboard' }
  | { type: 'open-session'; threadKey: string }
  | { type: 'open-link'; url: string }
  /** A native click Chromium sent to the just-closed frame instead of the visible Threads list. */
  | { type: 'slot-activate'; view: 'threads'; x: number; y: number; sequence: number }
  /** REQ-6 fused mode: the page's content rectangle, in the Paperclip frame's own viewport. */
  | { type: 'slot'; view: FusedView | null; rect: PaperclipRect | null; scheme: 'light' | 'dark' }
  /** `open` counts blocking overlays; `regions` are notices to cut out of the view. */
  | { type: 'overlay'; open: boolean; regions: PaperclipRect[] };

export type FusedView = 'browse' | 'threads' | 'dashboard';
export interface PaperclipRect { x: number; y: number; width: number; height: number }
export const MAX_NOTICE_REGIONS = 8;
export const SLOT_ACTIVATION_WINDOW_MS = 250;
/** Paperclip route segment → shell view. */
const SLOT_VIEWS: Record<string, FusedView> = { browse: 'browse', threads: 'threads', 'session-board': 'dashboard' };

function rectOf(value: unknown): PaperclipRect | null {
  if (!value || typeof value !== 'object') return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const rect = { x, y, width, height } as PaperclipRect;
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

/** Inside the frame's viewport, allowing one CSS pixel of rounding on each edge (AC-11). */
function insideBounds(rect: PaperclipRect, bounds: { width: number; height: number }): boolean {
  return rect.x >= -1 && rect.y >= -1 && rect.x + rect.width <= bounds.width + 1 && rect.y + rect.height <= bounds.height + 1;
}

export function paperclipPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.length > 2000 || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

export function parsePaperclipHostMessage(
  event: { source: unknown; origin: string; data: unknown },
  frameWindow: unknown,
  origin: string,
  /** The frame's viewport size; slot rectangles outside it are ignored. */
  bounds: { width: number; height: number } = { width: globalThis.innerWidth ?? 0, height: globalThis.innerHeight ?? 0 }
): PaperclipHostMessage | null {
  if (!frameWindow || event.source !== frameWindow || event.origin !== origin) return null;
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const message = data as Record<string, unknown>;
  if (message.source !== 'paperclip-ui' || message.v !== 1) return null;
  if (message.type === 'ready') return { type: 'ready', mode: message.mode === 'fused' ? 'fused' : 'switching' };
  if (message.type === 'disconnected') return { type: 'disconnected' };
  if (message.type === 'slot-activate') {
    const { x, y, sequence } = message;
    return message.view === 'threads' && typeof x === 'number' && Number.isFinite(x)
      && typeof y === 'number' && Number.isFinite(y) && x >= 0 && y >= 0 && x < bounds.width && y < bounds.height
      && typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence > 0
      ? { type: 'slot-activate', view: 'threads', x, y, sequence } : null;
  }
  if (message.type === 'route') {
    const path = paperclipPath(message.path);
    return path ? { type: 'route', path, title: typeof message.title === 'string' ? message.title.slice(0, 300) : '' } : null;
  }
  if (message.type === 'open-view' && ['browse', 'threads', 'dashboard'].includes(message.view as string)) {
    return { type: 'open-view', view: message.view as 'browse' | 'threads' | 'dashboard' };
  }
  if (message.type === 'open-session' && typeof message.threadKey === 'string' && message.threadKey.length > 0 && message.threadKey.length <= 1000) {
    return { type: 'open-session', threadKey: message.threadKey };
  }
  if (message.type === 'slot') {
    const scheme = message.scheme === 'dark' ? 'dark' : 'light';
    if (message.view === null) return { type: 'slot', view: null, rect: null, scheme };
    const view = typeof message.view === 'string' && Object.hasOwn(SLOT_VIEWS, message.view) ? SLOT_VIEWS[message.view] : null;
    const rect = rectOf(message.rect);
    if (!view || !rect || !insideBounds(rect, bounds)) return null;
    return { type: 'slot', view, rect, scheme };
  }
  if (message.type === 'overlay') {
    if (typeof message.open !== 'boolean') return null;
    const regions: PaperclipRect[] = [];
    for (const value of Array.isArray(message.regions) ? message.regions : []) {
      if (regions.length >= MAX_NOTICE_REGIONS) break;
      const rect = rectOf(value);
      if (rect) regions.push(rect);
    }
    return { type: 'overlay', open: message.open, regions };
  }
  if (message.type === 'open-link' && typeof message.url === 'string' && message.url.length <= 4000) {
    try {
      const url = new URL(message.url);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return { type: 'open-link', url: url.href };
    } catch { /* Invalid links are ignored. */ }
  }
  return null;
}

/** The iframe's own navigation already changes joint history; the shell only replaces its entry. */
export function paperclipPageAddress(current: string, path: string): string {
  const url = new URL(current);
  const safe = paperclipPath(path);
  if (!safe) return current;
  url.searchParams.set('view', 'paperclip');
  url.searchParams.set('pc', safe);
  return url.href;
}

export function paperclipPathForUrl(url: string, origin: string): string | null {
  try {
    const target = new URL(url);
    return target.origin === new URL(origin).origin && !target.username && !target.password
      ? paperclipPath(`${target.pathname}${target.search}${target.hash}`)
      : null;
  } catch { return null; }
}
