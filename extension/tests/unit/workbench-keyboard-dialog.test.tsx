import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkbenchKeyboard } from '../../src/entrypoints/manager/hooks/useWorkbenchKeyboard.js';
import type { SearchHit } from '../../src/core/search.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

function Harness({ onSelect, onClear, onSearch, registered = [] }: {
  onSelect: (key: string) => void;
  onClear: () => void;
  onSearch: () => void;
  registered?: HTMLDialogElement[];
}) {
  useWorkbenchKeyboard({
    surface: 'page', handshakeToken: 'test', dialogRefs: registered.map(dialog => ({ current: dialog })),
    lastInnerModalCloseAtRef: useRef(0), listHits: [{ conversation: { threadKey: 'thread-a' } }] as SearchHit[],
    selectedThreadKey: undefined, checkedCount: 1, searchInputRef: useRef(null), selectAllRef: useRef(null), rowRefs: useRef(new Map()),
    onFocusSearch: onSearch, onSelectThread: onSelect, onClearChecked: onClear, onCloseOverlay: vi.fn(),
  });
  return null;
}

function nativeDialog() {
  const dialog = document.createElement('dialog');
  dialog.setAttribute('open', '');
  dialog.innerHTML = '<button type="button">Close</button>';
  dialog.close = vi.fn(() => { dialog.removeAttribute('open'); dialog.dispatchEvent(new Event('close')); });
  host.append(dialog);
  dialog.querySelector('button')!.focus();
  return dialog;
}

it('holds row/search shortcuts behind an independently owned native dialog and spends Escape on that dialog', async () => {
  const onSelect = vi.fn(); const onClear = vi.fn(); const onSearch = vi.fn();
  await act(async () => root.render(<Harness onSelect={onSelect} onClear={onClear} onSearch={onSearch} />));
  const dialog = nativeDialog();
  for (const key of ['j', 'k', '/']) dialog.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  expect(onSelect).not.toHaveBeenCalled();
  expect(onSearch).not.toHaveBeenCalled();
  dialog.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(dialog.close).toHaveBeenCalledOnce();
  expect(onClear).not.toHaveBeenCalled();
  expect(dialog.open).toBe(false);
});

it('retains the registered innermost-first order and closes only one dialog for each Escape', async () => {
  const inner = nativeDialog(); const outer = nativeDialog();
  await act(async () => root.render(<Harness onSelect={vi.fn()} onClear={vi.fn()} onSearch={vi.fn()} registered={[inner, outer]} />));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(inner.close).toHaveBeenCalledOnce();
  expect(outer.close).not.toHaveBeenCalled();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(outer.close).toHaveBeenCalledOnce();
});
