// A menu button for the Table view. The menu is drawn on the page (portaled, fixed position) so
// the table's scrolling box never clips it.
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { onMenuKeyDown, usePopover } from '../shell/primitives.js';

const EDGE = 8;
const MENU_WIDTH = 280;

export function TableMenu({
  label,
  buttonClassName,
  buttonContent,
  title,
  children,
  align = 'left',
}: {
  /** Accessible name of the menu. */
  label: string;
  buttonClassName: string;
  buttonContent: React.ReactNode;
  title?: string;
  /** The items; `close` dismisses the menu after an action. */
  children: (close: () => void) => React.ReactNode;
  align?: 'left' | 'right';
}) {
  const popover = usePopover();
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const { open } = popover;

  const measure = useCallback(() => {
    const button = popover.triggerProps.ref.current;
    if (!button) return;
    const r = button.getBoundingClientRect();
    const maxLeft = Math.max(EDGE, window.innerWidth - MENU_WIDTH - EDGE);
    const left = align === 'right' ? r.right - MENU_WIDTH : r.left;
    setPlace({ left: Math.min(Math.max(EDGE, left), maxLeft), top: r.bottom + 6 });
  }, [align, popover.triggerProps.ref]);

  useEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, measure]);

  const close = () => {
    popover.setOpen(false);
    popover.triggerProps.ref.current?.focus();
  };

  return (
    <>
      <button
        type="button"
        className={buttonClassName}
        title={title}
        {...popover.triggerProps}
        aria-controls={open ? popover.menuProps.id : undefined}
        onClick={() => {
          if (!open) measure();
          popover.toggle();
        }}
      >
        {buttonContent}
      </button>
      {open &&
        place &&
        createPortal(
          <div
            {...popover.menuProps}
            className="tk-pop tk-table-menu"
            aria-label={label}
            tabIndex={-1}
            style={{ left: place.left, top: place.top, maxHeight: Math.max(200, window.innerHeight - place.top - EDGE) }}
            onKeyDown={onMenuKeyDown}
          >
            {children(close)}
          </div>,
          document.body
        )}
    </>
  );
}
