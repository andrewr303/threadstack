import { useEffect, type MutableRefObject } from 'react';
import type { SearchHit } from '../../../core/search.js';
import { hasOpenPopover } from '../shell/primitives.js';

export interface WorkbenchKeyboardOptions {
  surface: 'overlay' | 'page' | 'sidepanel';
  handshakeToken: string;
  /** Inner dialogs, innermost first: Escape closes the first one that is open. */
  dialogRefs: Array<MutableRefObject<HTMLDialogElement | null>>;
  /** When an inner dialog last closed; a second Escape right after it must not also clear the selection. */
  lastInnerModalCloseAtRef: MutableRefObject<number>;
  listHits: SearchHit[];
  selectedThreadKey: string | undefined;
  checkedCount: number;
  searchInputRef: MutableRefObject<HTMLInputElement | null>;
  selectAllRef: MutableRefObject<HTMLInputElement | null>;
  rowRefs: MutableRefObject<Map<string, HTMLButtonElement>>;
  /** "/" switches to search mode before focusing the box. */
  onFocusSearch: () => void;
  onSelectThread: (threadKey: string) => void;
  /** Escape with rows checked: clear them and say so. */
  onClearChecked: () => void;
  onCloseOverlay: () => void;
  /**
   * False while a view other than the thread list is showing: "/" and j/k belong to the list
   * and must not act on it while it is hidden. Escape keeps working. Default true.
   */
  listShortcuts?: boolean;
}

/** Escape (innermost dialog, then selection, then the overlay), "/" to search, j and k to move through the list. */
export function useWorkbenchKeyboard({
  surface,
  handshakeToken,
  dialogRefs,
  lastInnerModalCloseAtRef,
  listHits,
  selectedThreadKey,
  checkedCount,
  searchInputRef,
  selectAllRef,
  rowRefs,
  onFocusSearch,
  onSelectThread,
  onClearChecked,
  onCloseOverlay,
  listShortcuts = true,
}: WorkbenchKeyboardOptions) {
  useEffect(() => {
    const getOpenInnerModal = () =>
      dialogRefs
        .map((ref) => ref.current)
        .find((d) => d && (d.open || d.hasAttribute('open'))) ??
      // Feature-owned native dialogs (such as task links) need the same keyboard boundary.
      // Keep the registered innermost-first order; otherwise prefer the focused top-layer dialog.
      document.activeElement?.closest<HTMLDialogElement>('dialog[open]') ??
      [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1);

    const handleEscapeStep = () => {
      const openModalEl = getOpenInnerModal();
      if (openModalEl) {
        lastInnerModalCloseAtRef.current = Date.now();
        openModalEl.close();
        return;
      }
      if (Date.now() - lastInnerModalCloseAtRef.current < 150) return;
      if (checkedCount > 0) {
        // The bulk bar's controls disappear with the selection; keep focus in the list toolbar.
        if (document.activeElement?.closest('.tk-bulk-bar')) selectAllRef.current?.focus();
        onClearChecked();
        return;
      }
      if (surface === 'overlay') onCloseOverlay();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const openModalEl = getOpenInnerModal();
      if (e.key === 'Escape') {
        // An open menu closes first; its own handler takes this key.
        if (hasOpenPopover()) return;
        // Dialogs belong to this handler. After them, let the rail's document handler close
        // its drawer before this window-capture handler can clear rows or close an overlay.
        if (!openModalEl && document.querySelector('.tk-rail[data-drawer-open="true"]')) return;
        e.preventDefault();
        e.stopPropagation();
        handleEscapeStep();
        return;
      }
      if (openModalEl || !listShortcuts) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isEditing = tag === 'input' || tag === 'textarea' || tag === 'select' || Boolean(target?.isContentEditable);
      if (!isEditing && e.key === '/') {
        e.preventDefault();
        onFocusSearch();
        searchInputRef.current?.focus();
        return;
      }
      // Modified keys (Command+K opens Paperclip's palette in fused mode) are not row navigation.
      if (!isEditing && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'j' || e.key === 'k')) {
        if (listHits.length === 0) return;
        e.preventDefault();
        const curIdx = listHits.findIndex((h) => h.conversation.threadKey === selectedThreadKey);
        const step = e.key === 'j' ? 1 : -1;
        // A grouped list can hide rows (a collapsed group): move to the next row that is on
        // the page. When no row is known to be on the page (nothing registered yet), move by one.
        const shown = (key: string) => rowRefs.current.get(key)?.isConnected === true;
        const anyShown = listHits.some((h) => shown(h.conversation.threadKey));
        let nextIdx = curIdx < 0 ? 0 : curIdx + step;
        while (anyShown && nextIdx >= 0 && nextIdx < listHits.length && !shown(listHits[nextIdx].conversation.threadKey)) {
          nextIdx += step;
        }
        if (nextIdx < 0 || nextIdx >= listHits.length) {
          // Past either end: stay on the first or last row, as before.
          nextIdx = curIdx < 0 ? 0 : curIdx;
        }
        const nextKey = listHits[nextIdx]?.conversation.threadKey;
        if (nextKey) {
          onSelectThread(nextKey);
          rowRefs.current.get(nextKey)?.focus();
        }
      }
    };

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; handshakeToken?: string; action?: string } | null;
      if (
        data &&
        data.source === 'threadkeeper-host-overlay' &&
        data.handshakeToken === handshakeToken &&
        data.action === 'REQUEST_ESCAPE'
      ) {
        handleEscapeStep();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('message', onMessage);
    };
  }, [surface, handshakeToken, listHits, selectedThreadKey, checkedCount, listShortcuts]);
}
