// REQ-6 fused mode (layered variant, see .plan/reqs/REQ-6-design.md). Paperclip's frame fills the
// window and its sidebar is the only one; on its Browse, Threads and Session board pages the page
// reports a transparent content rectangle and the shell lays the matching view over it, above the
// frame by z-order. While Paperclip has a blocking overlay open, the frame is raised above the view;
// notices are cut out of the view instead. The views stay mounted (same DOM nodes) throughout.
import { useEffect, useRef, type RefObject } from 'react';
import type { FusedView, PaperclipMode, PaperclipRect } from '../../core/paperclip/host.js';
import type { PaperclipFrameControl } from './PaperclipView.js';

export const SLOT_DEADLINE_MS = 2_000;
export const OVERLAY_STALE_MS = 60_000;

export interface FusionState {
  mode: PaperclipMode | null;
  readyAt: number;
  /** A slot arrived in time after a fused `ready`; with the server running, the window is fused. */
  engaged: boolean;
  slotView: FusedView | null;
  /** The last valid content rectangle in shell coordinates; kept across pages and outages. */
  rect: PaperclipRect | null;
  overlayOpen: boolean;
  regions: PaperclipRect[];
  overlayAt: number;
  /** Bumped for each new placement (engagement or view change); the shell re-sends `placed` on it. */
  slotSeq: number;
}

export const INITIAL_FUSION: FusionState = {
  mode: null, readyAt: 0, engaged: false, slotView: null, rect: null, overlayOpen: false, regions: [], overlayAt: 0, slotSeq: 0,
};

export type FusionAction =
  | { type: 'ready'; mode: PaperclipMode; at: number }
  | { type: 'slot'; view: FusedView | null; rect: PaperclipRect | null; at: number }
  | { type: 'overlay'; open: boolean; regions: PaperclipRect[]; at: number }
  | { type: 'queried'; at: number }
  | { type: 'offline' };

export function fusionReducer(state: FusionState, action: FusionAction): FusionState {
  switch (action.type) {
    case 'ready':
      return { ...INITIAL_FUSION, mode: action.mode, readyAt: action.at, rect: state.rect, slotSeq: state.slotSeq };
    case 'slot':
      if (state.mode !== 'fused') return state;
      if (!state.engaged && action.at - state.readyAt > SLOT_DEADLINE_MS) return state;
      return {
        ...state,
        engaged: true,
        slotView: action.view,
        rect: action.rect ?? state.rect,
        slotSeq: !state.engaged || state.slotView !== action.view ? state.slotSeq + 1 : state.slotSeq,
      };
    case 'overlay':
      return { ...state, overlayOpen: action.open, regions: action.regions, overlayAt: action.at };
    case 'queried':
      return { ...state, overlayAt: action.at };
    case 'offline':
      return { ...INITIAL_FUSION, rect: state.rect, slotSeq: state.slotSeq };
  }
}

export const overlayIsStale = (state: FusionState, now: number): boolean =>
  state.overlayOpen && now - state.overlayAt >= OVERLAY_STALE_MS;

/** `clip-path` cutting the notice rectangles (shell coordinates) out of an element's own box. */
export function noticeClipPath(box: PaperclipRect, regions: readonly PaperclipRect[]): string {
  const parts: string[] = [];
  for (const region of regions) {
    const left = Math.max(region.x, box.x) - box.x;
    const top = Math.max(region.y, box.y) - box.y;
    const right = Math.min(region.x + region.width, box.x + box.width) - box.x;
    const bottom = Math.min(region.y + region.height, box.y + box.height) - box.y;
    if (right <= left || bottom <= top) continue;
    // The connecting segments back to the origin have zero area (spike v2 layered variant).
    parts.push(`${left}px ${top}px`, `${right}px ${top}px`, `${right}px ${bottom}px`, `${left}px ${bottom}px`, `${left}px ${top}px`, '0px 0px');
  }
  if (!parts.length) return '';
  return `polygon(evenodd, 0px 0px, 100% 0px, 100% 100%, 0px 100%, 0px 0px, ${parts.join(', ')})`;
}

const ROUTE_FOR_VIEW: Record<FusedView, string> = { browse: 'browse', threads: 'threads', dashboard: 'session-board' };
/** Company prefixes are upper-case issue prefixes; Paperclip redirects every board page to one. */
const COMPANY_PREFIX = /^\/([A-Z0-9][A-Z0-9_-]*)(?:[/?#]|$)/;

export function fusedRoute(view: FusedView, lastPath: string): string | null {
  const prefix = COMPANY_PREFIX.exec(lastPath)?.[1];
  return prefix ? `/${prefix}/${ROUTE_FOR_VIEW[view]}` : null;
}

const isFusedViewKey = (event: KeyboardEvent) =>
  (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k';

/**
 * The DOM side of fused mode: Command/Control+K from a view, focus return after an overlay, the
 * stale-overlay check, and notice holes. Everything is inert unless `fused` is true.
 */
export function usePaperclipFusionDom({ fused, state, shellRef, control, onStaleOverlay }: {
  fused: boolean;
  state: FusionState;
  shellRef: RefObject<HTMLElement | null>;
  control: RefObject<PaperclipFrameControl | null>;
  onStaleOverlay: () => void;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const inView = (element: Element | null): element is HTMLElement => {
    const shell = shellRef.current;
    return Boolean(element && shell?.contains(element) && !element.closest('.tk-view-paperclip')) && element instanceof HTMLElement;
  };

  // FR-4: with focus in a view, Command+K opens Paperclip's palette. A Threadkeeper handler that
  // claimed the key first (preventDefault) wins; a provider page keeps the key because focus
  // inside its iframe never reaches this document.
  useEffect(() => {
    if (!fused) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isFusedViewKey(event)) return;
      const active = document.activeElement;
      if (!inView(active)) return;
      event.preventDefault();
      returnFocus.current = active;
      control.current?.focus();
      control.current?.post({ type: 'command', name: 'palette' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fused]);

  // Focus goes back to the view element that had it when the overlay closes.
  const wasOpen = useRef(false);
  useEffect(() => {
    const open = fused && state.overlayOpen;
    if (open && !wasOpen.current && !returnFocus.current && inView(document.activeElement)) {
      returnFocus.current = document.activeElement as HTMLElement;
    }
    if (!open && wasOpen.current) {
      const target = returnFocus.current;
      returnFocus.current = null;
      const frame = control.current?.frame();
      if (target?.isConnected && (document.activeElement === frame || document.activeElement === document.body)) target.focus();
    }
    wasOpen.current = open;
  }, [fused, state.overlayOpen]);

  // FR-3 negative: an overlay reported open for 60 s is checked with Paperclip.
  const stateRef = useRef(state);
  stateRef.current = state;
  const onStaleRef = useRef(onStaleOverlay);
  onStaleRef.current = onStaleOverlay;
  useEffect(() => {
    if (!fused || !state.overlayOpen) return;
    const timer = setInterval(() => {
      if (overlayIsStale(stateRef.current, Date.now())) onStaleRef.current();
    }, 1_000);
    return () => clearInterval(timer);
  }, [fused, state.overlayOpen]);

  // Notices show through holes in every shell layer drawn over the content rectangle. Re-applied
  // when the notices, the overlay state or the placement change, and on window resize.
  const clipped = useRef(new Set<HTMLElement>());
  useEffect(() => {
    const regions = fused && !state.overlayOpen ? state.regions : [];
    const apply = () => {
      const shell = shellRef.current;
      const targets = new Set<HTMLElement>();
      if (regions.length && shell) {
        const layers = shell.querySelectorAll<HTMLElement>(':scope > .tk-rail, .tk-main > .tk-banner, .tk-main > .tk-view:not(.tk-view-paperclip):not([hidden])');
        for (const element of [...layers, ...document.querySelectorAll<HTMLElement>('iframe.tk-frame')]) targets.add(element);
      }
      for (const element of clipped.current) if (!targets.has(element)) element.style.clipPath = '';
      for (const element of targets) {
        const box = element.getBoundingClientRect();
        const path = noticeClipPath({ x: box.left, y: box.top, width: box.width, height: box.height }, regions);
        if (element.style.clipPath !== path) element.style.clipPath = path;
      }
      clipped.current = targets;
    };
    apply();
    if (!regions.length) return;
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, [fused, state.regions, state.overlayOpen, state.rect, state.slotView]);
}
