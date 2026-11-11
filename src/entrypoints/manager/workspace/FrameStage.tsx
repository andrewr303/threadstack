// Where embedded pages live. Every loaded session tab has exactly one <iframe>, kept in one
// layer for the whole life of the page. Views do not render iframes: they render a <FrameSlot>
// where a page should appear, and the stage lays the iframe over that slot.
//
// The reason is that an iframe reloads whenever its element is moved or recreated in the DOM.
// Switching tabs, switching between Browse, Threads and Dashboard, or re-ordering panes must
// never do that, so the iframes stay put (in a stable order) and only their position changes.
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { EMBED_FRAME_NAME_PREFIX, type SessionTab } from '../../../core/workspace/types.js';
import { EMBED_ALLOW, EMBED_SANDBOX, realmLabel, type WorkspaceController } from './useWorkspace.js';

interface SlotRegistry {
  register: (tabId: string, owner: symbol, element: HTMLElement | null) => void;
}

const SlotContext = createContext<SlotRegistry | null>(null);

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: string;
}

function sameBox(a: Box | undefined, b: Box): boolean {
  return !!a && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height && a.radius === b.radius;
}

function measure(element: HTMLElement): Box | null {
  // A slot inside a hidden view has no box; its page is then hidden too.
  if (!element.isConnected || element.getClientRects().length === 0) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    radius: getComputedStyle(element).borderRadius,
  };
}

/**
 * Hosts the iframes of every loaded session tab and gives descendants the slot registry.
 * Mount once, around the views.
 */
export function FrameStage({ workspace, children }: { workspace: WorkspaceController; children: React.ReactNode }) {
  // tabId -> the slot elements asking for it. Every view stays mounted, so one tab can have a
  // slot in several views at once (the Browse tab, the Threads live pane, a Dashboard pane);
  // the page goes to the one that is on screen, the most recently registered first.
  const slots = useRef(new Map<string, Array<{ owner: symbol; element: HTMLElement }>>());
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const [slotVersion, setSlotVersion] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const frame = useRef(0);
  const settleUntil = useRef(0);

  const remeasure = useCallback(() => {
    const next: Record<string, Box> = {};
    for (const [tabId, list] of slots.current) {
      for (let i = list.length - 1; i >= 0; i--) {
        // A slot inside a hidden view has no box: it does not get the page.
        const box = measure(list[i].element);
        if (box) {
          next[tabId] = box;
          break;
        }
      }
    }
    setBoxes((prev) => {
      const keys = Object.keys(next);
      if (keys.length === Object.keys(prev).length && keys.every((k) => sameBox(prev[k], next[k]))) return prev;
      return next;
    });
  }, []);

  /** Measure on the next frame, and keep measuring for a moment while a layout change settles. */
  const schedule = useCallback(
    (settleMs = 0) => {
      if (settleMs > 0) settleUntil.current = Math.max(settleUntil.current, performance.now() + settleMs);
      if (frame.current) return;
      const tick = () => {
        frame.current = 0;
        remeasure();
        if (performance.now() < settleUntil.current) frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
    },
    [remeasure]
  );

  const registry = useMemo<SlotRegistry>(
    () => ({
      register(tabId, owner, element) {
        const list = (slots.current.get(tabId) ?? []).filter((s) => s.owner !== owner);
        const previous = slots.current.get(tabId)?.find((s) => s.owner === owner)?.element;
        if (previous && previous !== element) observer.current?.unobserve(previous);
        if (element) {
          list.push({ owner, element });
          observer.current?.observe(element);
        }
        if (list.length) slots.current.set(tabId, list);
        else slots.current.delete(tabId);
        setSlotVersion((v) => v + 1);
      },
    }),
    []
  );

  useEffect(() => {
    // Every browser this runs in has ResizeObserver; without it (a bare DOM in tests) the window
    // resize listener below still keeps the pages in place.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
    observer.current = ro;
    if (ro) {
      for (const list of slots.current.values()) for (const s of list) ro.observe(s.element);
      ro.observe(document.documentElement);
    }
    const onLayout = () => schedule();
    // A slot can move without changing size while something animates around it.
    const onMotion = () => schedule(400);
    window.addEventListener('resize', onLayout);
    window.addEventListener('scroll', onLayout, true);
    document.addEventListener('transitionrun', onMotion, true);
    document.addEventListener('transitionend', onLayout, true);
    document.addEventListener('animationstart', onMotion, true);
    return () => {
      ro?.disconnect();
      observer.current = null;
      window.removeEventListener('resize', onLayout);
      window.removeEventListener('scroll', onLayout, true);
      document.removeEventListener('transitionrun', onMotion, true);
      document.removeEventListener('transitionend', onLayout, true);
      document.removeEventListener('animationstart', onMotion, true);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [schedule]);

  // Slots come and go with every render of the views; measure after each commit that changed them.
  useLayoutEffect(() => {
    remeasure();
    schedule(120);
  }, [slotVersion, workspace.plan.live, remeasure, schedule]);

  // A stable order: React moves keyed children when their order changes, and a moved iframe reloads.
  const liveTabs = useMemo(() => {
    const live = new Set(workspace.plan.live);
    return workspace.state.tabs
      .filter((t) => live.has(t.id))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }, [workspace.plan.live, workspace.state.tabs]);

  return (
    <SlotContext.Provider value={registry}>
      {children}
      <div className="tk-frame-stage" data-testid="frame-stage">
        {liveTabs.map((tab) => (
          <EmbeddedPage
            key={`${tab.id}#${workspace.runtime(tab.id).reloads}`}
            tab={tab}
            box={boxes[tab.id] ?? null}
            loaded={workspace.runtime(tab.id).loaded}
            onLoad={workspace.noteFrameLoaded}
          />
        ))}
      </div>
    </SlotContext.Provider>
  );
}

const EmbeddedPage = React.memo(function EmbeddedPage({
  tab,
  box,
  loaded,
  onLoad,
}: {
  tab: SessionTab;
  box: Box | null;
  loaded: boolean;
  onLoad: (id: string) => void;
}) {
  // The address is fixed when the page is mounted. The tab's address keeps following the page as
  // it navigates; feeding that back into `src` would reload the page on every navigation.
  const src = useRef(tab.url).current;
  const style: React.CSSProperties = box
    ? { position: 'fixed', left: box.left, top: box.top, width: box.width, height: box.height, borderRadius: box.radius }
    : // display: none stops rendering and slows the page's timers; the page itself stays loaded.
      { display: 'none' };
  return (
    <iframe
      className="tk-frame"
      name={`${EMBED_FRAME_NAME_PREFIX}${tab.id}`}
      title={`${tab.title || realmLabel(tab.realm)} (embedded page)`}
      src={src}
      sandbox={EMBED_SANDBOX}
      allow={EMBED_ALLOW}
      data-tab={tab.id}
      data-loaded={loaded ? 'true' : 'false'}
      style={style}
      onLoad={() => onLoad(tab.id)}
    />
  );
});

/**
 * Marks where a session tab's page should appear. Children are what shows underneath while the
 * page is not loaded (a paused, sleeping or loading state); the page covers them once it loads.
 */
export function FrameSlot({
  tabId,
  className,
  children,
}: {
  tabId: string | null;
  className?: string;
  children?: React.ReactNode;
}) {
  const registry = useContext(SlotContext);
  const owner = useRef(Symbol('frame-slot')).current;
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!registry || !tabId) return;
    registry.register(tabId, owner, ref.current);
    return () => registry.register(tabId, owner, null);
  }, [registry, tabId, owner]);
  return (
    <div ref={ref} className={className ? `tk-frame-slot ${className}` : 'tk-frame-slot'} data-tab={tabId ?? undefined}>
      {children}
    </div>
  );
}
