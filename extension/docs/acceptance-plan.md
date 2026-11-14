# Packaged-extension acceptance plan

Synthetic conversations only. No live provider calls or real-account mutations. Build/typecheck/unit-test results are supporting checks, not substitutes for these outcomes. Record fixtures, browser version, build path/hash, screenshots and failures.

| ID | Preconditions and actions | Falsifiable outcome / required evidence |
|---|---|---|
| QUIET-01 | Install packaged extension in isolated profile; visit controlled ChatGPT/Claude host fixtures. Capture a no-extension baseline and post-install closed page. Complete a fixture response and navigate SPA. | No injected visual control or changed page title, draft or layout; baseline/closed PNG equality and DOM assertions. |
| OPEN-02 | User toolbar or command invocation, repeated toggles, reader/settings nested dialogs, Escape, close button; composer initially focused with an unsent draft, page scrolled. | One overlay root only; inner dialog closes first; final close removes surface and restores scroll/focus/draft. Screenshots plus action/assertion log. If native toolbar/shortcut input cannot be exercised, report separate simulation, not native-input proof. |
| PARITY-03 | Search/select/edit in overlay, open full-page manager, reload and reopen overlay. At laptop and narrow widths. | Query, filters, selected record and persisted edits survive; list/reader not horizontally clipped. Both opened-surface screenshots and dimensions. |
| CAPTURE-04 | Explicitly authorize/bind fixture platform, stream then edit messages, switch branch/path and SPA route, remove lazy messages, revisit. | Completed visible messages captured once with honest partial coverage; drafts absent; stable branch identity and unknown timestamps; fixture assertions. |
| IMPORT-05 | Import 652 ChatGPT/portable fixture conversations under explicit account; manually edit; reimport. | All 652 accessible, no cap/duplicates, all totals reconcile, manual corrections survive. Saved fixture and assertion log. |
| ISOLATE-06 | Same source IDs/titles under two accounts/workspaces/branches; scope a search; attempt host-window messages and unauthorized iframe. | No key collision, cross-scope retrieval or privileged host operation; rejection/assertion log. |
| AI-07 | Contract-fixture responses with unsupported message references/quotes, injection text, malformed output, missing config and quota failure. | Invalid/stale enrichment cannot overwrite valid context, user/manual fields not replaced, no unearned claim of completion. Mock boundary log; live API separate NOT VERIFIED unless authorized. |
| SEARCH-08 | Exact phrase/original message/fuzzy title, local-only excluded record, incompatible model/dimensions and contextual revision change, reranking error. | Local matches and supporting excerpt; scope boundary remains; incompatible/stale vectors rejected, local results retained. Fixture assertions. |
| LIFE-09 | Interrupt/restart job processor, delete while work pending, re-deliver stale completion. Restart browser while manager previously open. | Resumable bounded jobs, no resurrection, no automatic overlay reopening. Logs and closed-state screenshot after restart. |
| PERF-10 | Clearly labeled synthetic 10,000-thread metadata library; warm-open and repeated local-search measurements with environment and percentiles. | Report measured timings against 500ms open/150ms search goals, including misses. No claimed pass without recorded measurement. |

## Visual and keyboard checks

The manager has one named main heading, labeled search and filters, semantic buttons, visible focus, keyboard-accessible rows/previews and native dialogs. Test nested Escape and reduced-motion mode. Inspect 1280×800/1440×900 and a narrow viewport for horizontal overflow and readable metadata. Check light/dark states. Automated accessibility results do not establish complete screen-reader conformance.

## Coverage ledger at handoff

For each ID, record pass/fail/partial/not-run, actual producer/runtime, fixture identity and evidence path. BrowserOS checks of a standalone preview are additional visual checks, not packaged-extension proof. Tests that trigger the production invocation handler programmatically must say so. Missing live ChatGPT/Claude DOM or API access is not a fixture pass for those live services.
