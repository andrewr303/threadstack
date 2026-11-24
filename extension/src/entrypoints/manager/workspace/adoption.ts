// Whether a Chrome tab whose opener is this workspace tab was opened by one of its embedded pages.
//
// Chrome names the active tab as the opener of far more than the windows a page opens: a tab the
// user creates with Cmd/Ctrl+T or the New Tab button, an address typed with Alt+Enter, and every
// tab an extension creates with chrome.tabs.create (ThreadStack's own "Open original" and online
// import included) all get the tab that was active at the time. When the full-tab manager is that
// tab, the worker used to take every one of them that showed ChatGPT or Claude "back into the
// workspace" and close it. Without the webNavigation permission the worker cannot see which frame
// opened a tab, so the workspace page decides: its embedded pages report each click
// (embed-bridge.ts), and a tab counts as theirs only when it appeared right after one.
//
// Pure apart from the clock it is given, so it can be tested without a browser.

/** `source` of the message an embedded page posts to the workspace page on each click. */
export const EMBED_GESTURE_SOURCE = 'threadkeeper-embed-gesture';

/**
 * How close to a click inside an embedded page the new tab must appear. A page that opens a tab
 * from its click handler does so within a few hundred milliseconds; a tab the user makes by hand
 * comes later, and a tab opened late (after the page waited for something) is simply left open.
 */
export const ADOPT_AFTER_GESTURE_MS = 1_000;

export interface GestureClock {
  /** Last click inside one of this page's embedded frames. */
  gestureAt: number | null;
  /** Last time this page went hidden (another tab of its window became the active one). */
  hiddenAt: number | null;
}

/**
 * True when the tab now asking to be adopted followed a click inside an embedded page closely
 * enough to have been opened by it. A tab that became the active one hid this page, so the moment
 * this page went hidden is compared with the click; a tab opened in the background (Cmd+click)
 * left it visible, so the moment of the request is.
 */
export function openedByEmbeddedPage(clock: GestureClock, now: number): boolean {
  const { gestureAt, hiddenAt } = clock;
  if (gestureAt === null) return false;
  // Hidden around or after the click (the two events travel separately, so allow either order).
  if (hiddenAt !== null && hiddenAt >= gestureAt - ADOPT_AFTER_GESTURE_MS) {
    return hiddenAt - gestureAt <= ADOPT_AFTER_GESTURE_MS;
  }
  return now - gestureAt <= ADOPT_AFTER_GESTURE_MS;
}

export function isEmbedGestureMessage(data: unknown): boolean {
  return Boolean(data) && typeof data === 'object' && (data as { source?: unknown }).source === EMBED_GESTURE_SOURCE;
}

export interface AdoptionGate {
  noteGesture(): void;
  noteHidden(): void;
  /** Whether to adopt the tab asking now. A yes uses the click up, so one click adopts one tab. */
  claim(): boolean;
}

export function createAdoptionGate(now: () => number = () => Date.now()): AdoptionGate {
  const clock: GestureClock = { gestureAt: null, hiddenAt: null };
  return {
    noteGesture() {
      clock.gestureAt = now();
    },
    noteHidden() {
      clock.hiddenAt = now();
    },
    claim() {
      if (!openedByEmbeddedPage(clock, now())) return false;
      clock.gestureAt = null;
      return true;
    },
  };
}
