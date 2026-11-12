import { detectProviderFromUrl, extractConversationIdFromUrl, type ProviderId } from './providers.js';

/**
 * Recent conversations as the site's own sidebar (or library page) lists them.
 *
 * There is no per-site selector here on purpose: every site links each conversation to a URL the
 * provider registry already knows how to read, so any link on the page whose URL names a
 * conversation of this provider is one. That keeps it working when a site reshuffles its markup,
 * and costs nothing when it does not apply. The order is the page's, which for every site listed
 * is newest first.
 */

export interface SidebarConversation {
  id: string;
  url: string;
  title: string;
}

/** Ids that are routes, not conversations. */
const NOT_A_CONVERSATION = new Set(['new', 'new_chat', 'library', 'history', 'recents', 'settings', 'search']);

export function readSidebarConversations(doc: Document, pageUrl: string, provider: ProviderId, limit = Infinity): SidebarConversation[] {
  const out: SidebarConversation[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    if (out.length >= limit) break;
    let url: URL;
    try {
      url = new URL(a.getAttribute('href') ?? '', pageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:') continue;
    if (detectProviderFromUrl(url.href) !== provider) continue;
    const id = extractConversationIdFromUrl(url.href);
    if (!id || NOT_A_CONVERSATION.has(id.toLowerCase()) || seen.has(id)) continue;
    seen.add(id);
    const title = (a.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    out.push({ id, url: `${url.origin}${url.pathname}${url.search}`, title });
  }
  return out;
}

/** The nearest ancestor that scrolls, where a sidebar keeps loading older conversations. */
function scrollParent(el: Element, win: Window): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflow = win.getComputedStyle(p).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && p.scrollHeight > p.clientHeight + 4) return p;
  }
  return null;
}

export interface LoadSidebarOptions {
  limit: number;
  sleep: (ms: number) => Promise<void>;
  isCancelled?: () => boolean;
  /** Give up after this many scrolls that bring nothing new. */
  patience?: number;
  /** Most scrolls in one run. */
  maxScrolls?: number;
}

/**
 * Read the conversations on the page, scrolling the list to load older ones until there are
 * enough, nothing new appears, or the cancel flag is set. Scrolls only the sidebar's own
 * container, and puts it back where it was.
 */
export async function loadSidebarConversations(
  doc: Document,
  win: Window,
  provider: ProviderId,
  options: LoadSidebarOptions
): Promise<SidebarConversation[]> {
  return (await loadSidebarList(doc, win, provider, options)).items;
}

/**
 * The same, saying whether the list was read to its end: `complete` is false when reading stopped
 * at the limit, the scroll budget or a cancel while the list was still growing, so a run can say the
 * site has more than it imported instead of reporting a partial list as everything.
 */
export async function loadSidebarList(
  doc: Document,
  win: Window,
  provider: ProviderId,
  options: LoadSidebarOptions
): Promise<{ items: SidebarConversation[]; complete: boolean }> {
  const patience = options.patience ?? 2;
  const maxScrolls = options.maxScrolls ?? 20;
  let items = readSidebarConversations(doc, win.location.href, provider, options.limit);
  let idle = 0;
  let restore: { el: HTMLElement; top: number } | null = null;
  // Ended because nothing more appeared (or nothing scrolls): the whole list was read.
  let complete = false;
  for (let i = 0; ; i++) {
    if (idle >= patience) {
      complete = true;
      break;
    }
    if (i >= maxScrolls || items.length >= options.limit || options.isCancelled?.()) break;
    const lastLink = Array.from(doc.querySelectorAll('a[href]')).filter((a) => items.some((it) => a.getAttribute('href')?.includes(it.id))).pop();
    const scroller = lastLink ? scrollParent(lastLink, win) : null;
    if (!scroller) {
      complete = true;
      break;
    }
    restore ??= { el: scroller, top: scroller.scrollTop };
    scroller.scrollTop = scroller.scrollHeight;
    await options.sleep(700);
    const next = readSidebarConversations(doc, win.location.href, provider, options.limit);
    idle = next.length > items.length ? 0 : idle + 1;
    items = next;
  }
  if (restore) restore.el.scrollTop = restore.top;
  return { items, complete };
}
