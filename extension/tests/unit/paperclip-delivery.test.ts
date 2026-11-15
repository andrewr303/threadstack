import { describe, expect, it, vi } from 'vitest';
import { createSessionDeliveryHandler, deliverProviderMessage } from '../../src/core/embed/session-delivery.js';

function fixture() {
  document.body.innerHTML = '<main><div data-message-author-role="user">old</div><form><textarea id="prompt-textarea"></textarea><button data-testid="send-button" type="button">Send</button></form></main>';
  const command = { requestId: 'r1', provider: 'chatgpt', text: 'unique new message', expectedUrl: 'https://chatgpt.com/c/session', deadlineAt: Date.now() + 2000 };
  const options = { visible: () => true, confirmationMs: 20, currentUrl: () => command.expectedUrl };
  return { command, options, button: document.querySelector('button')!, input: document.querySelector('textarea')! };
}

describe('provider delivery stand-in', () => {
  it('reports delivered only after a new user message appears', async () => {
    const { command, options, button, input } = fixture();
    button.onclick = () => { const node = document.createElement('div'); node.dataset.messageAuthorRole = 'user'; node.textContent = input.value; document.querySelector('main')!.appendChild(node); };
    expect(await deliverProviderMessage(document, command.expectedUrl, command, options)).toMatchObject({ delivered: true });
    expect(document.querySelectorAll('[data-message-author-role="user"]')).toHaveLength(2);
  });
  it('does not mistake existing text for successful delivery', async () => {
    const { command, options } = fixture();
    document.querySelector('[data-message-author-role="user"]')!.textContent = command.text;
    await expect(deliverProviderMessage(document, command.expectedUrl, command, options)).rejects.toMatchObject({ code: 'unknown_delivery' });
  });
  it('does not count a re-rendered earlier message with the same text as delivery (REQ-11 F-13)', async () => {
    const { command, options, button } = fixture();
    const old = document.querySelector('[data-message-author-role="user"]')!; old.textContent = command.text;
    // React remounts the earlier message: a new element with identical text, but no new message.
    button.onclick = () => { const node = document.createElement('div'); node.dataset.messageAuthorRole = 'user'; node.textContent = command.text; old.replaceWith(node); };
    await expect(deliverProviderMessage(document, command.expectedUrl, command, options)).rejects.toMatchObject({ code: 'unknown_delivery' });
  });
  it('confirms a repeated message once one more copy appears', async () => {
    const { command, options, button, input } = fixture();
    document.querySelector('[data-message-author-role="user"]')!.textContent = command.text;
    button.onclick = () => { const node = document.createElement('div'); node.dataset.messageAuthorRole = 'user'; node.textContent = input.value; document.querySelector('main')!.appendChild(node); };
    expect(await deliverProviderMessage(document, command.expectedUrl, command, options)).toMatchObject({ delivered: true });
  });
  it('allows a send button that becomes enabled after its empty composer receives text', async () => {
    const { command, options, button, input } = fixture(); button.disabled = true;
    input.addEventListener('input', () => { button.disabled = !input.value; });
    button.onclick = () => { const node = document.createElement('div'); node.dataset.messageAuthorRole = 'user'; node.textContent = input.value; document.querySelector('main')!.appendChild(node); };
    expect(await deliverProviderMessage(document, command.expectedUrl, command, options)).toMatchObject({ delivered: true });
  });
  it('refuses wrong sessions, signed-out pages and an existing draft without typing', async () => {
    const { command, options, input } = fixture();
    await expect(deliverProviderMessage(document, 'https://chatgpt.com/c/other', command, options)).rejects.toMatchObject({ code: 'denied' });
    expect(input.value).toBe('');
    input.value = 'my unsent draft';
    await expect(deliverProviderMessage(document, command.expectedUrl, command, options)).rejects.toMatchObject({ code: 'busy' });
    expect(input.value).toBe('my unsent draft');
    input.value = ''; document.body.insertAdjacentHTML('beforeend', '<input type="password" />');
    await expect(deliverProviderMessage(document, command.expectedUrl, command, options)).rejects.toMatchObject({ code: 'signed_out' });
  });
  it('reports a deadline abort before submission as timeout with the contract text (NF-2)', async () => {
    const { command, options, input } = fixture();
    const controller = new AbortController(); controller.abort('timeout');
    await expect(deliverProviderMessage(document, command.expectedUrl, command, { ...options, signal: controller.signal })).rejects.toMatchObject({ code: 'timeout', message: 'The browser did not answer in 30 seconds.' });
    expect(input.value).toBe('');
  });
  it('honors cancellation before submission', async () => {
    const { command, options, input, button } = fixture(); const clicked = vi.fn(); button.onclick = clicked;
    const controller = new AbortController(); controller.abort();
    await expect(deliverProviderMessage(document, command.expectedUrl, command, { ...options, signal: controller.signal })).rejects.toMatchObject({ code: 'disabled' });
    expect(input.value).toBe(''); expect(clicked).not.toHaveBeenCalled();
  });
  it('refuses navigation while waiting for Send to become enabled', async () => {
    const { command, options, button } = fixture();
    let url = command.expectedUrl;
    button.disabled = true;
    const clicked = vi.fn(); button.onclick = clicked;
    setTimeout(() => { url = 'https://chatgpt.com/c/another-session'; button.disabled = false; }, 25);
    await expect(deliverProviderMessage(document, command.expectedUrl, command, { ...options, currentUrl: () => url }))
      .rejects.toMatchObject({ code: 'denied' });
    expect(clicked).not.toHaveBeenCalled();
  });
  it('rechecks the live session after the composer input event before clicking Send', async () => {
    const { command, options, button, input } = fixture();
    let url = command.expectedUrl;
    const clicked = vi.fn(); button.onclick = clicked;
    input.addEventListener('input', () => { url = 'https://chatgpt.com/c/another-session'; }, { once: true });
    await expect(deliverProviderMessage(document, command.expectedUrl, command, { ...options, currentUrl: () => url }))
      .rejects.toMatchObject({ code: 'denied' });
    expect(clicked).not.toHaveBeenCalled();
  });
  it('refuses a replaced document root even when its URL and controls look the same', async () => {
    const { command, options } = fixture();
    const doc = document.implementation.createHTMLDocument('Stand-in session');
    doc.body.innerHTML = '<textarea id="prompt-textarea"></textarea><button data-testid="send-button" type="button" disabled>Send</button>';
    const clicked = vi.fn();
    setTimeout(() => {
      const replacement = doc.documentElement.cloneNode(true) as HTMLElement;
      replacement.querySelector('button')!.removeAttribute('disabled');
      replacement.querySelector('button')!.onclick = clicked;
      doc.documentElement.replaceWith(replacement);
    }, 5);
    await expect(deliverProviderMessage(doc, command.expectedUrl, command, options)).rejects.toMatchObject({ code: 'denied' });
    expect(clicked).not.toHaveBeenCalled();
  });
  it('never confirms a matching message shown after navigating away from the submitted session', async () => {
    const { command, options, button } = fixture();
    let url = command.expectedUrl;
    const clicked = vi.fn(() => {
      setTimeout(() => {
        url = 'https://chatgpt.com/c/another-session';
        const node = document.createElement('div'); node.dataset.messageAuthorRole = 'user'; node.textContent = command.text;
        document.querySelector('main')!.append(node);
      }, 5);
    });
    button.onclick = clicked;
    await expect(deliverProviderMessage(document, command.expectedUrl, command, { ...options, confirmationMs: 100, currentUrl: () => url }))
      .rejects.toMatchObject({ code: 'unknown_delivery' });
    expect(clicked).toHaveBeenCalledOnce();
  });
  it('honors cancellation while waiting and restores only its own original-session draft', async () => {
    const { command, options, input, button } = fixture();
    button.disabled = true;
    const clicked = vi.fn(); button.onclick = clicked;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await expect(deliverProviderMessage(document, command.expectedUrl, command, { ...options, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'disabled' });
    expect(input.value).toBe(''); expect(clicked).not.toHaveBeenCalled();
  });
  it('refuses page senders and every non-workspace frame', () => {
    const { command, input } = fixture(); const response = vi.fn();
    const handler = createSessionDeliveryHandler({ ownId: 'our-id', doc: document, url: () => command.expectedUrl, workspace: true });
    expect(handler({ type: 'TK_SESSION_DELIVER', ...command }, { id: 'our-id', origin: 'https://chatgpt.com' }, response)).toBe(true);
    expect(response).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'denied' }) }));
    const other = createSessionDeliveryHandler({ ownId: 'our-id', doc: document, url: () => command.expectedUrl, workspace: false });
    other({ type: 'TK_SESSION_DELIVER', ...command }, { id: 'our-id', origin: 'chrome-extension://our-id' }, response);
    expect(input.value).toBe('');
  });
});
