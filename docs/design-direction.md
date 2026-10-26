# Design direction

## Brief

**Human:** returning to unfinished project work, mid-task, between other tasks. They do not remember the thread — they remember the problem. They open the manager deliberately, scan, recognise, read the context, and resume.

**Verb:** recognise the right thread, then understand where it stopped.

**Feel:** a well-set reference index on a workbench — calm, dense where it matters, quiet surfaces, one book-cloth accent. Not a SaaS dashboard, not a marketing page.

**Focal element:** the *Where you left off* strip in the detail pane. It wins through position and the only serif type in the interface, ringed in whitespace. Everything else is demoted.

## Signature: the evidence margin

Every extracted claim (decision, action, constraint, next step) renders with a small right-margin marker — a 2px rule plus the source message's ordinal. Activating it reveals the exact captured passage with its revision. Assistant suggestions carry a hollow marker; user commitments carry a filled one. Nothing in the interface states a conclusion it cannot point at.

## Domain and rejected defaults

Concepts: index, folio, margin note, ribbon, cross-reference, branch, checkpoint, workstream, handoff.

Rejected: metric dashboard with KPI cards → a reading workbench with counts as a single sentence. Rainbow folder/tag chips → plain muted text, one accent only. Hover-only previews → selection-driven detail pane. Provider-first filing → project/workstream first. Oversized marketing cards → rows with real density. Provider-coloured brand chrome → the content dominates; provider is small metadata.

## Layout

| Surface | Composition |
|---|---|
| Overlay | `<dialog>` inset `clamp(16px, 3vw, 40px)`; one raised surface, radius 12px. Columns: nav `232px` (collapsible to `56px`), list `minmax(320px, 1fr)`, detail `minmax(380px, 1.1fr)`. |
| < 1100px | Detail becomes a panel over the list; back affordance returns to the list with focus restored to the row. |
| < 760px | Nav becomes a drawer; list is full width. |
| Full page | Same components, no dialog chrome; max content width 1600px, centred. |
| Laptop 1280×800 | No horizontal scroll in any state. Secondary metadata wraps or moves into the detail pane. |

## Tokens (semantic; light / dark)

```
--ink         #1B1A17 / #EDEAE3     primary text
--ink-2       #4A4741 / #C3BEB4     supporting
--ink-3       #6E6A62 / #9A958B     metadata
--ink-4       #918C83 / #767168     disabled
--rule        rgba(27,26,23,.10) / rgba(237,234,227,.10)
--rule-strong rgba(27,26,23,.18) / rgba(237,234,227,.18)
--paper       #FBFAF7 / #16181A     canvas
--paper-2     #F4F2ED / #1C1F21     rails, inputs (inputs are inset: one step darker)
--paper-3     #EDEAE3 / #23272A     hover, selected row
--accent      #1F6F6B / #5FB8B0     book-cloth teal, one accent only
--accent-soft rgba(31,111,107,.10) / rgba(95,184,176,.12)
--warn        #8A5A12 / #D9A441
--danger      #8C3A2E / #D9776A
```

Depth is **borders-only** plus one soft elevation for the overlay surface: light `0 0 0 1px var(--rule), 0 24px 60px -24px rgba(20,19,17,.35)`; dark collapses to the ring. No gradient, no decorative shadow.

## Type

Display/h1 and the detail conversation title only: `ui-serif, Georgia, 'Times New Roman', serif`. Everything else: `ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`. No webfont download.

| Role | Size / weight / colour |
|---|---|
| Manager h1 | 28 / 600 serif / `--ink` |
| Detail title | 24 / 600 serif / `--ink`, `text-wrap: balance` |
| Section heading | 19 / 600 sans / `--ink` |
| List row title | 16 / 600 / `--ink`, 2-line clamp |
| Body, controls | 14 / 400 / `--ink` |
| Row summary, excerpt | 13 / 400 / `--ink-2` |
| Meta | 12 / 400 / `--ink-3` |
| Eyebrow / coverage label | 11 / 500 uppercase, `.06em` tracking / `--ink-3` |

Numerals use `font-variant-numeric: tabular-nums`. No type below 11px.

## Spacing and density

4px base. Comfortable: row padding `12px 16px`, gaps 8, section gap 24. Compact: `8px 12px`, gaps 4, section gap 16. Hit areas ≥ 40×40px via padding or a pseudo-element; never overlapping.

## Component patterns

- **Row:** title (2-line clamp) · one-line summary or real excerpt · `project · provider / account` · right column: relative time (tabular) + coverage tick + optional next-step chip. Selected = `--paper-3` fill plus a 2px `--accent` inset rule on the leading edge; focus-visible = 2px `--accent` outline offset 2px.
- **Coverage tick:** three short rules — 1 filled = title/metadata, 2 = partial, 3 = full. Always paired with a text label in the detail pane; never colour-only.
- **Status:** dot + word. Active filled accent, Needs review filled warn, Waiting hollow, Paused hollow muted, Done check muted, Reference hollow muted.
- **Counts sentence:** `652 threads · 44 filed · 608 unfiled` with an expandable "how these are counted" note. No KPI cards.
- **Where you left off:** left hairline rule, serif line, then up to three evidence-marked lines.
- **Empty states:** one sentence naming the next action. No illustrations, no upsell.
- **Buttons:** 32px height, 6px radius, `--paper-2` fill with `--rule` border; primary is `--accent` fill with white text. `:active` `scale(.97)`.
- **Inputs:** `--paper-2` fill, `--rule` border, 6px radius, focus ring 2px `--accent`.

## Motion

Overlay enters at `opacity 0 → 1` and `scale(.985) → 1` over 180ms with `cubic-bezier(.23,1,.32,1)`; exit 120ms. Row selection has no animation. `@media (prefers-reduced-motion: reduce)` removes all transforms and leaves opacity/colour changes only.

## Accessibility floor

Native `<dialog>` for the overlay and every inner dialog; Escape closes the innermost first. Single `h1` per surface, ordered headings, landmarks, skip link in the full page. Labelled search and filters. Keyboard-reachable rows (`button` semantics or `role="option"` inside a `listbox` with roving tabindex — choose one and implement it fully). Live-region announcements for result counts and save confirmations, polite and debounced. WCAG AA contrast on every rendered pair in both themes. No information by colour alone.

## Anti-slop checks before delivery

Squint test: is the *Where you left off* strip unmistakably the focal point? Swap test: would this read as a generic AI chat dashboard if the name were removed? Signature test: can five places be pointed at where the evidence margin appears? Token test: do the token names belong to this product rather than any project?
