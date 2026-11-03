// @vitest-environment-options {"url": "http://localhost:3000/c/abc12345"}
// The page is a self-hosted LibreChat the user added under Settings → Capture → Any AI site, so
// the content script runs as Chrome would register it there.
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Sent = { type?: string; payload?: Record<string, unknown>; explicitToken?: string };

describe('content script on an added site', () => {
  const sent: Sent[] = [];
  const listeners: Array<(m: unknown, s: unknown, r: (x: unknown) => void) => unknown> = [];
  let siteAnswer: (r: unknown) => void = () => undefined;

  beforeAll(async () => {
    vi.useFakeTimers();
    document.title = 'Regex help | LibreChat';
    document.body.innerHTML = `<main role="main">
      <div class="message-render"><div class="user-turn"><div class="message-content">Match an email</div></div></div>
      <div class="message-render"><div class="agent-turn"><div class="message-content">Start with ^\\S+@\\S+$</div></div></div>
    </main>`;
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'tk-test-id',
        getURL: (p: string) => `chrome-extension://tk-test-id/${p}`,
        lastError: undefined,
        sendMessage: (message: Sent, cb?: (r: unknown) => void) => {
          sent.push(message);
          if (message.type === 'GET_CAPTURE_SITE') siteAnswer = cb ?? (() => undefined);
          else cb?.({ ok: true, status: 'stored' });
        },
        onMessage: { addListener: (fn: (m: unknown, s: unknown, r: (x: unknown) => void) => unknown) => listeners.push(fn) },
      },
    });
    await import('../../src/entrypoints/content.js');
  });

  const captures = () => sent.filter((m) => m.type === 'PASSIVE_DOM_CAPTURE');

  it('reads nothing until the background confirms the site', () => {
    expect(sent.map((m) => m.type)).toEqual(['GET_CAPTURE_SITE']);
    vi.advanceTimersByTime(10_000);
    expect(captures()).toHaveLength(0);
  });

  it('ignores an answer for another origin', () => {
    siteAnswer({ ok: true, site: { origin: 'http://localhost:4000' } });
    vi.advanceTimersByTime(10_000);
    expect(captures()).toHaveLength(0);
  });

  it('captures once the text has settled across two reads, filed under the site', () => {
    siteAnswer({ ok: true, site: { origin: 'http://localhost:3000' } });
    vi.advanceTimersByTime(1000);
    expect(captures()).toHaveLength(0); // first read: waiting for the page to stop changing
    vi.advanceTimersByTime(3000);
    expect(captures()).toHaveLength(1);
    expect(captures()[0].payload).toMatchObject({
      provider: 'librechat',
      sourceConversationId: 'localhost-3000~abc12345',
      canonicalUrl: 'http://localhost:3000/c/abc12345',
      captureSource: 'dom_observer',
      title: 'Regex help',
    });
    expect(captures()[0].explicitToken).toBeUndefined();
  });

  it('keeps waiting while a reply is still growing', async () => {
    const before = captures().length;
    const reply = document.createElement('div');
    reply.className = 'message-render';
    reply.innerHTML = '<div class="agent-turn"><div class="message-content">Partial</div></div>';
    document.querySelector('main')!.appendChild(reply);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      reply.querySelector('.message-content')!.textContent += ' more';
    }
    expect(captures().length).toBe(before);
    await vi.advanceTimersByTimeAsync(6000);
    expect(captures().length).toBe(before + 1);
    expect((captures().at(-1)!.payload!.messages as unknown[]).length).toBe(3);
  });

  it('sends right away with the background token when the user asks for this tab', () => {
    const before = captures().length;
    const token = 'a'.repeat(32);
    for (const fn of listeners) fn({ type: 'TK_CAPTURE_NOW', explicitToken: token }, {}, () => undefined);
    vi.advanceTimersByTime(100);
    expect(captures().length).toBe(before + 1);
    expect(captures().at(-1)!.explicitToken).toBe(token);
  });
});
