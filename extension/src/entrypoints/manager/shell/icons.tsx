// The workspace's icons: plain 24-unit line drawings, one stroke weight, no fills. Each is drawn
// for what it stands for here (a tab strip, a pane grid, a paused page), so there is no library
// to load and nothing that reads as decoration. Icons are always hidden from assistive tech;
// the control that holds one carries the name.
import React from 'react';

const PATHS = {
  // Views
  browse: 'M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5ZM3 9h18M7 6.5h.01',
  threads: 'M4 6h16M4 12h16M4 18h10',
  dashboard: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h4A1.5 1.5 0 0 1 11 5.5v13A1.5 1.5 0 0 1 9.5 20h-4A1.5 1.5 0 0 1 4 18.5ZM14 5.5A1.5 1.5 0 0 1 15.5 4h3A1.5 1.5 0 0 1 20 5.5v4A1.5 1.5 0 0 1 18.5 11h-3A1.5 1.5 0 0 1 14 9.5ZM14 15.5a1.5 1.5 0 0 1 1.5-1.5h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3a1.5 1.5 0 0 1-1.5-1.5Z',
  // Navigation of an embedded page
  back: 'M14.5 5.5 8 12l6.5 6.5',
  forward: 'M9.5 5.5 16 12l-6.5 6.5',
  reload: 'M19 12a7 7 0 1 1-2.2-5.1M19 4.5V8h-3.5',
  external: 'M13 5h6v6M19 5l-8 8M10 6H6.5A1.5 1.5 0 0 0 5 7.5v10A1.5 1.5 0 0 0 6.5 19h10a1.5 1.5 0 0 0 1.5-1.5V14',
  copy: 'M8 8h11v12H8ZM5 16H4V4h11v1',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7',
  lock: 'M7.5 11V8.5a4.5 4.5 0 0 1 9 0V11M6.5 11h11A1.5 1.5 0 0 1 19 12.5v6A1.5 1.5 0 0 1 17.5 20h-11A1.5 1.5 0 0 1 5 18.5v-6A1.5 1.5 0 0 1 6.5 11Z',
  // Tabs and panes
  plus: 'M12 5v14M5 12h14',
  close: 'M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5',
  pause: 'M9 6v12M15 6v12',
  pin: 'M9 4h6l-1 6 3 3H7l3-3ZM12 13v7',
  unpin: 'M9 4h6l-1 6 3 3H7l3-3ZM12 13v7M4 4l16 16',
  swap: 'M7 8h12l-3-3M17 16H5l3 3',
  summary: 'M6.5 4h11A1.5 1.5 0 0 1 19 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5v-13A1.5 1.5 0 0 1 6.5 4ZM8.5 9h7M8.5 12.5h7M8.5 16h4',
  live: 'M4.5 5h15A1.5 1.5 0 0 1 21 6.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 15.5v-9A1.5 1.5 0 0 1 4.5 5ZM8 20h8M10 9.5l4 2.5-4 2.5Z',
  split: 'M4.5 5h15A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11A1.5 1.5 0 0 1 4.5 5ZM12 5v14',
  pane1: 'M5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-11A1.5 1.5 0 0 1 5.5 5Z',
  pane2: 'M5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-11A1.5 1.5 0 0 1 5.5 5ZM12 5v14',
  pane3: 'M5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-11A1.5 1.5 0 0 1 5.5 5ZM12 5v14M12 12h8',
  pane4: 'M5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-11A1.5 1.5 0 0 1 5.5 5ZM12 5v14M4 12h16',
  // Lists
  list: 'M8.5 6.5H20M8.5 12H20M8.5 17.5H20M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01',
  table: 'M5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4ZM4 9.5h16M4 14.5h16M10 9.5V20',
  board: 'M5.5 4h3A1.5 1.5 0 0 1 10 5.5v13A1.5 1.5 0 0 1 8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4ZM15.5 4h3A1.5 1.5 0 0 1 20 5.5v8a1.5 1.5 0 0 1-1.5 1.5h-3a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 15.5 4Z',
  search: 'M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0ZM15.5 15.5 20 20',
  organize: 'M4 6.5h16M7 12h10M10 17.5h4',
  chevronDown: 'M6 9.5 12 15l6-5.5',
  chevronRight: 'M9.5 6 15 12l-5.5 6',
  check: 'M5 12.5 10 17 19 7.5',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  // Accounts and settings
  userPlus: 'M14.5 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM3.5 20a7 7 0 0 1 12-4.9M18.5 14v6M15.5 17h6',
  window: 'M4.5 5h15A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11A1.5 1.5 0 0 1 4.5 5ZM3 9h18',
  settings: 'M5 7h8M17 7h2M5 17h2M11 17h8M15 4.5v5M9 14.5v5',
  sun: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8ZM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',
  moon: 'M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z',
  panelLeft: 'M5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-11A1.5 1.5 0 0 1 5.5 5ZM9.5 5v14',
  branch: 'M7 5.5v13M7 14c6 0 10-1.5 10-6.5M7 5.5a1.5 1.5 0 1 0 0-.01M7 18.5a1.5 1.5 0 1 0 0-.01M17 6a1.5 1.5 0 1 0 0-.01',
  repo: 'M6.5 4H18v13H7a2 2 0 0 0-2 2V5.5A1.5 1.5 0 0 1 6.5 4ZM5 19a2 2 0 0 0 2 2h11v-4M9.5 8h5',
  pullRequest: 'M7 7.5v9M7 6a1.5 1.5 0 1 0 0-.01M7 18a1.5 1.5 0 1 0 0-.01M17 18a1.5 1.5 0 1 0 0-.01M17 16.5V10a3 3 0 0 0-3-3h-2.5M13.5 4.5 11 7l2.5 2.5',
  alert: 'M12 4 21 19.5H3ZM12 10v4.5M12 17h.01',
  sleep: 'M8 6h6l-6 7h6M15 13h4l-4 5h4',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `tk-icon ${className}` : 'tk-icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
