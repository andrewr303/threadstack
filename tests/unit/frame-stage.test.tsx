import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FrameSlot, FrameStage } from '../../src/entrypoints/manager/workspace/FrameStage.js';
import { EMBED_SANDBOX, type FrameRuntime, type WorkspaceController } from '../../src/entrypoints/manager/workspace/useWorkspace.js';
import { EMPTY_WORKSPACE_STATE, type SessionTab } from '../../src/core/workspace/types.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const runtime: FrameRuntime = { frameId: null, loaded: false, canGoBack: false, canGoForward: false, agentState: null, reloads: 0 };

function tab(id: string, url: string, createdAt: number): SessionTab {
  return { id, provider: 'claude_code', realm: 'anthropic', accountId: 'primary~anthropic', url, title: id, threadKey: null, createdAt, lastActiveAt: createdAt };
}

function controller(tabs: SessionTab[], live: string[], runtimes: Record<string, FrameRuntime> = {}): WorkspaceController {
  return {
    state: { ...EMPTY_WORKSPACE_STATE, tabs },
    plan: { live, resting: {} },
    runtime: (id: string) => runtimes[id] ?? runtime,
    noteFrameLoaded: vi.fn(),
  } as unknown as WorkspaceController;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // jsdom has no layout engine: every slot measures as empty, so pages render hidden. That is
  // enough here, because what must hold is the identity of the iframe elements.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(ws: WorkspaceController, children: React.ReactNode) {
  act(() => root.render(<FrameStage workspace={ws}>{children}</FrameStage>));
}

const frames = () => [...container.querySelectorAll<HTMLIFrameElement>('iframe.tk-frame')];

describe('FrameStage', () => {
  it('mounts one sandboxed iframe per loaded tab, named after the tab', () => {
    const a = tab('a', 'https://claude.ai/code/one', 1);
    const b = tab('b', 'https://claude.ai/code/two', 2);
    render(controller([a, b], ['a']), <FrameSlot tabId="a" />);
    expect(frames().map((f) => f.name)).toEqual(['tk-pane~a']);
    expect(frames()[0].getAttribute('sandbox')).toBe(EMBED_SANDBOX);
    expect(frames()[0].getAttribute('sandbox')).not.toContain('allow-top-navigation');
    expect(frames()[0].getAttribute('src')).toBe('https://claude.ai/code/one');
  });

  it('keeps the same iframe element when the view, the slot or the order of use changes', () => {
    const a = tab('a', 'https://claude.ai/code/one', 1);
    const b = tab('b', 'https://claude.ai/code/two', 2);
    render(controller([a, b], ['a', 'b']), <FrameSlot tabId="a" />);
    const [first, second] = frames();
    // Another view shows the other tab; most-recently-used order flips; a third tab loads.
    const c = tab('c', 'https://claude.ai/code/three', 3);
    render(controller([a, b, c], ['b', 'c', 'a']), <div><FrameSlot tabId="b" /><FrameSlot tabId="c" /></div>);
    const after = frames();
    expect(after.map((f) => f.name)).toEqual(['tk-pane~a', 'tk-pane~b', 'tk-pane~c']);
    expect(after[0]).toBe(first);
    expect(after[1]).toBe(second);
  });

  it('does not feed the page its own navigation back as a new address', () => {
    const a = tab('a', 'https://claude.ai/code/one', 1);
    render(controller([a], ['a']), <FrameSlot tabId="a" />);
    const element = frames()[0];
    render(controller([{ ...a, url: 'https://claude.ai/code/one?tab=diff', title: 'Diff' }], ['a']), <FrameSlot tabId="a" />);
    expect(frames()[0]).toBe(element);
    expect(frames()[0].getAttribute('src')).toBe('https://claude.ai/code/one');
  });

  it('remounts a page from its current address when it is reloaded, and drops it when it rests', () => {
    const a = tab('a', 'https://claude.ai/code/one?tab=diff', 1);
    render(controller([a], ['a']), <FrameSlot tabId="a" />);
    const element = frames()[0];
    render(controller([a], ['a'], { a: { ...runtime, reloads: 1 } }), <FrameSlot tabId="a" />);
    expect(frames()[0]).not.toBe(element);
    expect(frames()[0].getAttribute('src')).toBe('https://claude.ai/code/one?tab=diff');
    render(controller([a], []), <FrameSlot tabId="a">Paused</FrameSlot>);
    expect(frames()).toHaveLength(0);
    expect(container.querySelector('.tk-frame-slot')?.textContent).toBe('Paused');
  });

  it('puts the page on the slot that is on screen when hidden views hold a slot for the same tab', async () => {
    // jsdom has no layout: give one slot a box by hand and leave the other (a hidden view) without.
    const boxed = (el: Element, rect: { left: number; top: number; width: number; height: number } | null) => {
      Object.defineProperty(el, 'getClientRects', { configurable: true, value: () => (rect ? [rect] : []) });
      Object.defineProperty(el, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ ...(rect ?? { left: 0, top: 0, width: 0, height: 0 }), right: 0, bottom: 0, x: 0, y: 0, toJSON() {} }),
      });
    };
    const a = tab('a', 'https://claude.ai/code/one', 1);
    render(
      controller([a], ['a']),
      <div>
        <FrameSlot tabId="a" className="shown" />
        <div hidden>
          <FrameSlot tabId="a" className="in-hidden-view" />
        </div>
      </div>
    );
    boxed(container.querySelector('.shown')!, { left: 300, top: 120, width: 800, height: 600 });
    boxed(container.querySelector('.in-hidden-view')!, null);
    // The stage measures on window resize (and on its own schedule); ask it to measure now.
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await new Promise((r) => setTimeout(r, 60));
    });
    const frame = frames()[0];
    expect(frame.style.display).not.toBe('none');
    expect([frame.style.left, frame.style.top, frame.style.width, frame.style.height]).toEqual(['300px', '120px', '800px', '600px']);
  });

  it('hides a loaded page that no view is showing instead of unloading it', () => {
    const a = tab('a', 'https://claude.ai/code/one', 1);
    render(controller([a], ['a']), null);
    expect(frames()).toHaveLength(1);
    expect(frames()[0].style.display).toBe('none');
  });
});
