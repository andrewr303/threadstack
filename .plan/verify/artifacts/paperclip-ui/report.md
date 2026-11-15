# Paperclip core UI implementation checks

Scope: REQ-5 host integration, REQ-6 switching fallback, REQ-13 session search.
Source scope is pinned in `source-hashes.json`. No Git commit was made by this worker.

Implemented:

- Runtime-only exact extension-ID allowlist, authenticated parent handshake,
  validated path/navigation, route/title reporting, external-link handoff, and
  plugin view handoff. The module is inert without configuration or outside a frame.
- Native search remains independent. Session searches debounce 250 ms, require
  two characters, use best quality on Enter, abort on company/query changes and
  suppress stale responses. Page results paginate eight at a time; the palette
  shows at most five. Session open revalidates through the bridge.
- Offline, no grant, timeout, disabled plugin, local-only fallback and
  newly-private-session states have dedicated behavior and copy.
- No fused clipping or overlay product changes. The spike fixture and unresolved
  real-component/browser checks are in `../../req6-spike/`.

Executed checks:

| Check | Result | Evidence |
|---|---|---|
| Host contract tests before implementation | Failed on missing implementation module | `tk-ui-host-red.log` |
| Search contracts before implementation | Failed on missing implementation modules | `tk-ui-search-red.log` |
| Host, client, session results, existing Search and palette tests | 5 files, 44 tests passed | `tk-ui-final-tests.log` |
| Static HTML tests including runtime allowlist and injection rejection | 1 file, 4 tests passed | `tk-server-host-green.log` |
| UI TypeScript check after required Storybook catalogue generation | Exit 0 | `tk-ui-typecheck-green.log` |
| Targeted `git diff --check` | Exit 0 | Coordinator execution record |
| Spike server syntax (`node --check`) | Exit 0 | Coordinator execution record |

Commands ran from `ui/` using `node ../node_modules/vitest/vitest.mjs run ...`
and `node ../scripts/run-tsc.mjs -p tsconfig.json --pretty false`; server tests ran
from `server/`. The first direct UI TypeScript run failed because the ignored
Storybook catalogue had not yet been generated. The package's documented generator
resolved it; no tracked product code was changed to bypass that prerequisite.

Not established by these checks: live iframe sign-in, live WebSocket and service
worker behavior in the extension, real session opening/foregrounding, latency at
2,000 sessions, a before/after native search latency comparison, or any of the
five fused-layout browser spike outcomes. No browser acceptance is claimed.
