// Which new tabs next to the full-tab manager count as opened by an embedded page
// (manager/workspace/adoption.ts), and the click relay in embedded frames (embed-bridge.ts).
import { describe, expect, it, vi } from 'vitest';
import {
  ADOPT_AFTER_GESTURE_MS,
  EMBED_GESTURE_SOURCE,
  createAdoptionGate,
  isEmbedGestureMessage,
  openedByEmbeddedPage,
} from '../../src/entrypoints/manager/workspace/adoption.js';
import { startGestureRelay } from '../../src/entrypoints/embed-bridge.js';

describe('openedByEmbeddedPage', () => {
  const W = ADOPT_AFTER_GESTURE_MS;

  it('never adopts without a click inside an embedded page', () => {
    expect(openedByEmbeddedPage({ gestureAt: null, hiddenAt: null }, 1_000)).toBe(false);
    // Cmd/Ctrl+T hides the manager, but nothing inside it was clicked.
    expect(openedByEmbeddedPage({ gestureAt: null, hiddenAt: 1_000 }, 1_500)).toBe(false);
  });

  it('adopts a tab that became active right after the click, even when its address came later', () => {
    expect(openedByEmbeddedPage({ gestureAt: 10_000, hiddenAt: 10_150 }, 14_000)).toBe(true);
    // The hide may be seen just before the click message arrives.
    expect(openedByEmbeddedPage({ gestureAt: 10_000, hiddenAt: 9_950 }, 10_300)).toBe(true);
  });

  it('leaves a tab the user opened by hand a while after clicking in an embedded page', () => {
    // Clicked in the chat, then Cmd/Ctrl+T two seconds later and typed chatgpt.com.
    expect(openedByEmbeddedPage({ gestureAt: 10_000, hiddenAt: 12_000 }, 13_500)).toBe(false);
    expect(openedByEmbeddedPage({ gestureAt: 10_000, hiddenAt: 10_000 + W + 1 }, 10_000 + W + 2)).toBe(false);
  });

  it('adopts a tab opened in the background right after the click, and nothing later', () => {
    // The manager went hidden long before (the user was on another tab), then came back and clicked.
    expect(openedByEmbeddedPage({ gestureAt: 50_000, hiddenAt: 1_000 }, 50_200)).toBe(true);
    expect(openedByEmbeddedPage({ gestureAt: 50_000, hiddenAt: null }, 50_000 + W)).toBe(true);
    // A tab an extension opens (online import, Open original) long after the last click.
    expect(openedByEmbeddedPage({ gestureAt: 50_000, hiddenAt: null }, 50_000 + W + 1)).toBe(false);
  });
});

describe('createAdoptionGate', () => {
  it('lets one click adopt one tab', () => {
    let now = 0;
    const gate = createAdoptionGate(() => now);
    expect(gate.claim()).toBe(false);
    now = 1_000;
    gate.noteGesture();
    now = 1_100;
    gate.noteHidden();
    now = 2_500;
    expect(gate.claim()).toBe(true);
    // A second tab asking afterwards (e.g. the user's own Cmd+T tab) is not covered by that click.
    expect(gate.claim()).toBe(false);
  });

  it('refuses after a hand-made tab hid the page well after the click', () => {
    let now = 0;
    const gate = createAdoptionGate(() => now);
    now = 1_000;
    gate.noteGesture();
    now = 4_000;
    gate.noteHidden();
    now = 6_000;
    expect(gate.claim()).toBe(false);
  });
});

describe('gesture messages', () => {
  it('recognises only the relay message', () => {
    expect(isEmbedGestureMessage({ source: EMBED_GESTURE_SOURCE })).toBe(true);
    for (const bad of [null, undefined, 'x', {}, { source: 'threadkeeper-manager-iframe' }]) expect(isEmbedGestureMessage(bad)).toBe(false);
  });

  it('posts each trusted click to the workspace page only, and stops', () => {
    // isTrusted cannot be set on a real event, so the window is a stand-in that keeps listeners.
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const win = {
      addEventListener: (type: string, fn: (event: unknown) => void) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
      removeEventListener: (type: string, fn: (event: unknown) => void) => void listeners.get(type)?.delete(fn),
    } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>;
    const postMessage = vi.fn();
    const relay = startGestureRelay(win, { postMessage } as unknown as Pick<Window, 'postMessage'>, 'chrome-extension://abc');
    const fire = (type: string, isTrusted: boolean) => {
      for (const fn of listeners.get(type) ?? []) fn({ type, isTrusted });
    };
    fire('click', true);
    fire('auxclick', true);
    fire('click', false); // a script's synthetic click
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenCalledWith({ source: EMBED_GESTURE_SOURCE }, 'chrome-extension://abc');
    relay.stop();
    fire('click', true);
    expect(postMessage).toHaveBeenCalledTimes(2);
  });
});
