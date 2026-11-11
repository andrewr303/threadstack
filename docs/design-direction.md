# Design direction

## Who it is for

Someone who runs many AI sessions at once: coding agents (Claude Code, Codex, Cursor agents) beside chats and bots, often under more than one account per provider. They come back mid-task, between other tasks. They do not remember the thread; they remember the problem. They want to see what is running, what is waiting on them, and where each piece of work stopped, then get back into the real page without hunting through browser tabs.

**Verb:** find the right session, see where it stopped, continue in the real page.

**Feel:** a reading workbench under a pane of glass. Quiet warm surfaces, one teal accent, serif where you read, and floating chrome that lets the room show through. Not a SaaS dashboard, not a marketing page, not a browser skin.

**Focal element:** the *Where you left off* block in a thread's summary. Serif, the largest reading type on the screen, on its own raised surface.

## Three views over the same sessions

The full page is a workspace: a side rail and three views. Every view stays mounted, and every embedded page lives on one stage outside the views, so switching never reloads a page.

| View | What it is |
|---|---|
| **Browse** | Provider sites embedded as pages, a tab strip, back, forward, reload, the address, and the account switcher for the tab's sign-in. Tabs of an account that is not signed in show as paused until the person switches. |
| **Threads** | The organized library. A list beside the thread's summary. The summary can show the real page as Live (page only) or Split (summary beside the page). |
| **Dashboard** | Pinned sessions in 1 to 4 live panes, for watching several runs at once. |

The **rail** lists sessions as Coding agents, Chats and Bots (the six most recent of each, with "Show all" leading to Threads), the Threads navigation when Threads is showing, and at the bottom who is signed in to each sign-in, Add account, Settings and the theme. Collapsed, it is a 64px strip of icons, each with a name and a tooltip. Below 900px wide it is always that strip and opens as a drawer over the page.

One Chrome profile holds one login per sign-in ("realm"). Only the signed-in account's pages can load; switching account reloads that realm's pages. The interface says this plainly where it matters and never pretends a paused page is live.

## Glass: where it is allowed and why

Glass (translucent fill, `blur(16px) saturate(150%)`, a hairline edge brighter along the top than the sides, one soft low shadow, a faint sheen fading out over the first rows) is for **floating chrome only**: the rail, the bar at the top of each view, and menus. Chrome is what you steer with; letting the canvas show through it keeps it visually lighter than the work.

Everything a person **reads or works in is opaque**: rows, the list and detail panels, dashboard panes, dialogs, and the slot behind every embedded page. Text you read is never on a moving, blurred backdrop.

Rules that keep glass working:

- Never glass on glass. A menu that opens inside chrome is solid (`--chrome-solid`), or is drawn on the page outside it.
- No ancestor of a glass element may have opacity below 1, a filter, a mask, a clip-path or `will-change` on those: they blank the blur.
- A glass element is a containing block for fixed-position descendants (backdrop-filter does that), so menus positioned with viewport coordinates are portaled to the page.
- Anything that floats over an embedded page of unknown colour (menus, the rail drawer) uses the denser `--pop-fill`.
- Dialogs are opaque `--surface` panels with `--r-panel` corners and a top highlight, over a blurred `--scrim`. The dialog itself is never glass.

The canvas behind it all is painted once, on a fixed layer (`--canvas`, `--canvas-paint`): warm, low-chroma light fields behind the rail (top left) and the bars (top), a faint sage field at the bottom right. No visible blobs, no purple or blue gradients.

## Tokens

Names are the contract; values below are dark / light. Dark is the default (`:root` and `html[data-theme="dark"]`); light is `html[data-theme="light"]`.

### Colour

| Token | Dark | Light | Use |
|---|---|---|---|
| `--canvas` | `#13110F` | `#E9E4DB` | page background |
| `--canvas-paint` | canvas + 3 radial fields | canvas + 3 radial fields | painted once on the body, fixed |
| `--surface` | `#1C1A17` | `#FBFAF7` | panels, rows, dialogs, page slots |
| `--surface-2` | `#24211E` | `#F3F0EA` | raised blocks, hover |
| `--surface-3` | `#2D2A26` | `#E8E4DC` | marks, code, deeper wells |
| `--chrome-solid` | `#1B1916` | `#F4F1EB` | chrome when surfaces are solid |
| `--border-solid` | `#3B3631` | `#CFC7BB` | chrome border when solid |
| `--glass-fill` | `rgba(23,21,18,.50)` | `rgba(251,249,245,.58)` | rail and bars |
| `--pop-fill` | `rgba(23,21,18,.88)` | `rgba(251,249,245,.90)` | menus, the rail drawer |
| `--glass-filter` | `blur(16px) saturate(150%)` | same | |
| `--glass-border` | `rgba(255,244,228,.08)` | `rgba(60,46,32,.10)` | glass edge |
| `--glass-hi` | `rgba(255,244,228,.17)` | `rgba(255,255,255,.90)` | top highlight, sheen |
| `--glass-shadow` | `0 14px 34px -22px rgba(0,0,0,.8)` | `0 14px 32px -22px rgba(70,48,28,.38)` | the one low shadow |
| `--line` / `--line-2` | `rgba(237,232,223,.09 / .15)` | `rgba(40,32,22,.09 / .15)` | dividers, borders |
| `--field-border` | `#81796C` | `#857D71` | input edges (3:1) |
| `--text` | `#EDE8DF` | `#1C1A17` | primary text |
| `--text-2` | `#C6BFB3` | `#46423C` | supporting text |
| `--text-3` | `#A39B8F` | `#625D55` | metadata |
| `--text-disabled` | `#6C655B` | `#A29C92` | disabled only |
| `--accent` | `#5FB8B0` | `#1F6F6B` | the one accent |
| `--on-accent` | `#0E1716` | `#FBFAF7` | text on the accent |
| `--accent-tint` | `#25302C` | `#E5ECE9` | selected fill |
| `--accent-line` | `rgba(95,184,176,.55)` | `rgba(31,111,107,.55)` | selected edge |
| `--warn` | `#D9A441` | `#8A5D0E` | needs you |
| `--danger` | `#D9776A` | `#B5503F` | failed, destructive |
| `--st-running` / `--st-finished` | `#C6BFB3` / `#A39B8F` | `#625D55` / `#625D55` | run-state dots |
| `--ctl-hover` / `--ctl-press` / `--ctl-fill` | warm white at .07 / .11 / .05 | warm brown at .06 / .10, white at .55 | control states |
| `--seg-track` / `--seg-thumb` | `rgba(10,9,8,.35)` / `#34302B` | `rgba(60,46,32,.06)` / `#FFFDF9` | segmented control |
| `--ring` / `--ring-inner` | `#5FB8B0` / `#13110F` | `#1F6F6B` / `#FBFAF7` | two-tone focus ring |
| `--scrim` | `rgba(10,9,8,.55)` | `rgba(40,32,22,.30)` | behind dialogs and the drawer |
| `--pop-shadow` | `0 18px 40px -16px rgba(0,0,0,.8)` | `0 18px 40px -18px rgba(70,48,28,.45)` | menus, dialogs |
| `--ac-teal … --ac-gold` | `#5FAEA6 #E3A07F #AC9BDB #9EB98A #86A8D8 #D6B460` | `#2E7D77 #B4633F #6E58B3 #557543 #3D6BA8 #8F6F12` | account colours, always with the name |

The library's older names stay as aliases so existing rules render in the new colours: `--ink` → `--text`, `--ink-2` → `--text-2`, `--ink-3` → `--text-3`, `--ink-4` → `--text-disabled`, `--rule` → `--line`, `--rule-strong` → `--line-2`, `--paper` → `--surface`, `--paper-2` → `--surface-2`, `--paper-3` → `--surface-3`, `--accent-soft` → `--accent-tint`.

### Type

System faces only, no web fonts: `--font-sans` (UI), `--font-serif` (titles, the summary, the wordmark), `--font-mono` (paths, commands, message ordinals).

| Token | Size | Typical use |
|---|---|---|
| `--fs-11` | 11px | marks, evidence ordinals, the smallest meta (nothing smaller) |
| `--fs-12` | 12px | meta, group labels, eyebrows (sentence case, not uppercase) |
| `--fs-13` | 13px | controls, rail rows, body in dense places |
| `--fs-14` | 14px | reading body |
| `--fs-16` | 16px | wordmark, section headings |
| `--fs-20` | 20px | *Where you left off* line, notice titles |
| `--fs-24` | 24px | thread title in the detail pane |

Row titles in the thread list are serif at 15px. Numerals use tabular figures.

### Radius

`--r-ctl` 6px (buttons, fields, markers) · `--r-row` 10px (rows, cards) · `--r-panel` 14px (panels, page slots, dialogs, menus) · `--r-chrome` 18px (the rail and view bars) · `--r-cap` 999px (pills: segmented controls, tabs, chips).

### Layout

`--gap` 8px (outer padding and the space between floating pieces) · `--nav-w` 264px (240px clipped "Dashboard"; the view switch stacks icon over label so all three fit at 13px; measured "Dashboard" at 13px/600 is 68.9px in Chrome on macOS) · `--row-h` 32px. Collapsed rail: 64px.

### Motion

`--ease-out` `cubic-bezier(.22,1,.36,1)` for entering and moving; `--ease-in` `cubic-bezier(.55,0,.8,.25)` for leaving. `--t-small` 160ms (presses, menus), `--t-mid` 200ms (thumbs, fades), `--t-panel` 260ms (dialogs, the drawer). Only transform and opacity animate. Under `prefers-reduced-motion: reduce` every animation and transition is cut to an instant; the end state (selected, open, loaded) still shows.

## Patterns

- **Rows** are rounded `--r-row` surfaces. Selected: `--accent-tint` inside an `--accent-line` hairline. Never a coloured stripe on the leading edge.
- **Where you left off:** a `--surface-2` block with an `--r-row` corner and a `--line-2` edge, the serif line at 20px, then "Next step" after a dashed rule.
- **Evidence margin:** every extracted claim keeps its marker: a hairline box with the message ordinal in mono, closed by a 2px accent rule on its right; filled pip for what the person committed to, hollow for what the assistant suggested. Opening it shows the captured passage.
- **Run state** of a coding session is a dot and a word (Running, Needs approval, Needs your answer, Finished, Failed, Idle, Signed out), described as what the page showed when Threadkeeper last read it. The dot never pulses or glows. Not observed means nothing is shown.
- **Accounts:** a colour dot and the name. Filled when signed in, a hollow ring when not. Shown only when it says something (more than one account, or not the signed-in one).
- **Notices** (empty, paused, blocked): a centred block with an icon, a title that says what happened, a sentence that says what to do, then the actions.
- **Controls:** 32px tall at least (main actions 36 to 44), `--r-ctl`, distinct hover, pressed, selected and disabled states, `cursor: pointer` when enabled and `not-allowed` when disabled.

## Accessibility floor

- **Contrast**, computed (WCAG 2.x) for text over the darkest and lightest backdrop glass can sit on (the plain canvas, and the canvas under every light field at its centre, composited with the glass fill; saturation not modelled):
  - Dark: `--text` 11.9 to 15.2, `--text-2` 8.0 to 10.2, `--text-3` 5.3 to 6.8, `--accent` 6.2 to 7.9, `--field-border` 3.4 to 4.3.
  - Light: `--text` 14.1 to 16.3, `--text-2` 8.1 to 9.4, `--text-3` 5.3 to 6.1, `--accent` 4.8 to 5.6, `--field-border` 3.3 to 3.5.
  - On opaque surfaces: `--text-3` on `--surface` 6.3 (dark) / 6.3 (light); `--on-accent` on `--accent` 7.8 / 5.7; `--warn` on `--surface` 7.7 / 5.5; `--danger` on `--surface` 5.6 / 4.8.
  - `--field-border` and light `--warn` were darkened from the prototype to reach 3:1 and 4.5:1.
- **Solid surfaces.** Settings can make every translucent surface opaque (`html[data-surfaces="solid"]`), and so can the system: `prefers-reduced-transparency: reduce`, `prefers-contrast: more` (which also strengthens lines and `--text-3`), `forced-colors: active` (system colours throughout), and browsers without `backdrop-filter`. Solid chrome gets a real border.
- **Focus:** a two-tone ring on every control (2px `--ring` outline at 2px offset over a 2px `--ring-inner` halo). Controls inside scrolling lists draw it inside their box so it is never clipped.
- **Semantics:** real buttons, links, inputs and selects; a radiogroup for segmented choices, tablist and tabs (with arrow keys) for tabs, menus as menus. `aria-current` on the item that is showing, `aria-expanded` on everything that opens. Escape closes the innermost thing and focus returns to the control that opened it. Announcements go through one polite live region.
- **Never by colour alone:** every dot has a word or an icon beside it; account dots differ by fill, run states by word.
- **Text never below 11px.** Keyboard order follows the visual order.

## Deliberately not done

- No web fonts, no icon library, no CSS framework, no CSS-in-JS.
- No glass on content, no glass on glass, no glass dialogs.
- No gradients you can see as shapes, no purple or blue gradients, no glow, no pulsing status dots, no decorative shadows beyond the one chrome shadow and the menu shadow.
- No "AI powered", "New" or other decorative badges; no KPI cards. Library counts stay a sentence.
- No provider logos or brand colours: providers are a neutral two-letter mark; the embedded page carries the brand.
- No live claims about a run: run state is labelled as observed.
- No uppercase eyebrows; labels are sentence case.
- No coloured left stripes for selection.
