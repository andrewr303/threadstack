// @vitest-environment-options {"url": "https://x.com/i/chat/1234-5678"}
// X Chat also carries human DMs: Grok Bot chats are read only after "Capture this tab".
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Sent = { type?: string; payload?: Record<string, unknown>; explicitToken?: string };

describe('content script on X Chat', () => {
  const sent: Sent[] = [];
  const listeners: Array<(m: unknown, s: unknown, r: (x: unknown) => void) => unknown> = [];

  beforeAll(async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><div id="host"></div></main>';
    const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
    root.innerHTML = `<div data-testid="dm-conversation-header">Grok Bot</div><button data-testid="dm-conversation-more-button"></button>
      <div data-testid="dm-message-scroller">
        <div data-testid="message-1" class="justify-end"><div data-testid="message-text-1">Status of the deploy?</div></div>
        <div data-testid="message-2"><div data-testid="message-text-2">Deployed at 14:02.</div></div>
      </div>`;
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'tk-test-id',
        getURL: (p: string) => `chrome-extension://tk-test-id/${p}`,
        sendMessage: (message: Sent, cb?: (r: unknown) => void) => {
          sent.push(message);
          cb?.({ ok: true, status: 'stored' });
        },
        onMessage: { addListener: (fn: (m: unknown, s: unknown, r: (x: unknown) => void) => unknown) => listeners.push(fn) },
      },
    });
    await import('../../src/entrypoints/content.js');
  });

  const captures = () => sent.filter((m) => m.type === 'PASSIVE_DOM_CAPTURE');
  const tell = (message: unknown) => {
    for (const fn of listeners) fn(message, {}, () => undefined);
  };

  it('never reads the chat on its own', () => {
    vi.advanceTimersByTime(20_000);
    expect(captures()).toHaveLength(0);
  });

  it('does not read it when a capture is asked without the background token', () => {
    tell({ type: 'TK_CAPTURE_NOW' });
    vi.advanceTimersByTime(2000);
    expect(captures()).toHaveLength(0);
  });

  it('saves the open chat when the user chose Capture this tab', () => {
    tell({ type: 'TK_CAPTURE_NOW', explicitToken: 'b'.repeat(32) });
    vi.advanceTimersByTime(200);
    expect(captures()).toHaveLength(1);
    expect(captures()[0]).toMatchObject({
      explicitToken: 'b'.repeat(32),
      payload: { provider: 'grok_bot', sourceConversationId: '1234-5678', title: 'Grok Bot on X Chat' },
    });
    expect((captures()[0].payload!.messages as Array<{ role: string; content: string }>).map((m) => [m.role, m.content])).toEqual([
      ['user', 'Status of the deploy?'],
      ['assistant', 'Deployed at 14:02.'],
    ]);
  });
});
