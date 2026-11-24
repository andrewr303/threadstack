<p align="center">
  <img src="assets/brand/threadstack-mark.png" alt="ThreadStack" width="72" />
</p>

# ThreadStack in this Paperclip fork

ThreadStack is the browser extension under `extension/`. It keeps its IndexedDB library, account
identifiers, provider pages, embeddings and retrieval in the browser. Paperclip stores
company-scoped session metadata and task links through the first-party `browser-sessions` plugin
(`packages/plugins/plugin-browser-sessions/`).

ThreadStack was imported from its own repository (then named Threadkeeper) with its Git history.
Implementation and acceptance records live in `.plan/`. Feature documentation for the extension
itself is in [`extension/README.md`](../extension/README.md) and [`extension/docs/`](../extension/docs/).

## Development and verification

Use Node 24.11 or newer and the repository's pinned pnpm 9.15.4. Install the root workspace with
`pnpm install` and install `extension/` separately with `npm ci`. The extension stays outside the
pnpm workspace and uses React 18; Paperclip uses React 19.

```sh
pnpm run check:extension
pnpm run check:all
```

The guarded checks typecheck and test the extension, then build only into `/tmp/tk-build` with
their own path-based extension ID. `check:all` also runs the root typecheck and tests. The native
Runner's Rust checks need the toolchain recorded in `packages/paperclip-runner/rust-toolchain.toml`.
`pnpm run test:threadstack` runs only the guard and cross-package contract tests.

Never build into the folder your browser has loaded from another checkout. For an intentional
deploy, set `TK_LIVE_DIR` to the existing unpacked-extension folder and run
`pnpm run deploy:extension`. That keeps the path-based extension ID and therefore the library
stored under it. The command fails without an explicit target. Review the completed checks first.
[THREADSTACK-SERVICE.md](THREADSTACK-SERVICE.md) has the full rules.

## Local service and embedded app

Run `extension/mac-helper/Install Mac Helper.command` to register the helper with the current
extension ID and this fork's directory. It records fixed executable paths and a source shim.
In Settings → Paperclip, grant access to the selected origin and use **Set up Paperclip** for
the first background-service installation. Later openings can start that registered service.
Closing ThreadStack leaves Paperclip running.

The Paperclip view loads the real server app in a persistent direct-child frame. It keeps its
own routing, sign-in, live updates and security headers. The source shim exports the helper's
registered IDs for the host handshake. The server reads `PAPERCLIP_THREADSTACK_EXTENSION_IDS` and,
from shims written before the rename, `PAPERCLIP_THREADKEEPER_EXTENSION_IDS`; other launch methods
must set one of them. Both sides validate the sender's window, exact origin, protocol and path.
Provider frames remain direct children of ThreadStack.

Browse, Threads and Session board use the documented view-switching fallback. Fused clipping
is withheld until its overlay, focus, click-through, resize and provider-frame spike passes in
the required browsers.

## Pairing and sharing

Open Settings → Paperclip → Browser sessions, choose a company and start pairing. Confirm
the eight-character code in that company's Browser sessions settings in Paperclip. Pairing
uses a separate bridge token; agent credentials cannot pair or impersonate the extension.
Share sessions with each company explicitly. Sharing is off by default, and local-only sessions
and Paperclip-imported tasks stay out of the browser-session inventory.

The extension owns retrieval and redaction. Plugin tools expose bounded list, read, context,
related and search operations through Paperclip's tool gateway. Session text is labelled
untrusted data. The task Sessions tab, extension linked-task panel and dashboard attention widget
use company-scoped links. Session state events can comment on linked tasks and request governed
wakeups. Change hints refresh Paperclip tasks in the library; periodic sync remains available.

## Agent actions

Actions require the extension's master and provider switches, the company's master and provider
switches, a trusted agent, and an eligible link to that agent's current task. Agent-created links
do not grant action authority. All switches default off. Only Claude, Claude Code, ChatGPT and
Codex have initial delivery adapters.

The worker targets one manager document and the exact recorded account. It refuses another
account's occupied profile slot. Persistent request IDs, rate limits and delivery receipts prevent
repeated submissions. An interrupted submission is recorded as uncertain and is never retried
automatically. A real signed-in-provider acceptance run remains a separate founder-operated check.

## Model keys

Model-key transfer is opt-in. Select the source company, link its secrets and explicitly allow
transfer. Resolved values exist only in the feature call's memory. A linked remote feature pauses
when Paperclip is unavailable; local search continues.

**Move my keys to Paperclip** is an explicit action. It reads each new secret back successfully
before deleting that key's local value. A failed readback preserves the original value. Moved
values are absent from new extension backups; older backups keep their original contents.

## Naming and compatibility

The product was called Threadkeeper before it became ThreadStack. Names people see, code
identifiers, file names, scripts (`scripts/threadstack-*.mjs`), the CI workflow
(`.github/workflows/threadstack-pr.yml`) and Paperclip-page-internal names
(`data-threadstack-host`, `data-threadstack-slot`, `data-threadstack-slot-view`,
`data-threadstack-notice`, `data-threadstack-overlay`, `.threadstack-slot`,
`paperclip:threadstack-open-view`, `paperclip:threadstack-host` and the
`paperclip-threadstack-extension-ids` meta tag) use the new name.

These identifiers keep the old name on purpose. Each one is shared with a separately installed
or separately deployed party, or is already stored somewhere, so renaming it would break a
connection or orphan data:

| Identifier | Why it stays |
| --- | --- |
| `paperclip-threadkeeper/1`, `paperclip-threadkeeper/2` | Bridge protocol between the extension and the browser-sessions plugin. Builds of either side must agree. |
| `"threadkeeper-shell"` | Sender tag on the extension's messages to the embedded Paperclip UI. |
| `X-Threadkeeper-Bridge-Token` | Header paired extensions send on every bridge request. |
| `still-threadkeeper/1`, `app`/`from: 'threadkeeper'` | Protocol with the separate Still (Sidebar Dock) extension. |
| `com.threadkeeper.accounts` | Native messaging host the Mac helper registers in each browser. |
| `~/Library/Application Support/Threadkeeper/…` | Folders holding the helper, account profiles and library backups. |
| `threadkeeper-portable-v1`, `threadkeeper-backup-v1` | Export and backup file formats; existing files must still import. |
| Link source `"threadkeeper"`, audit reader `"threadkeeper-extension"`, policy name "Threadkeeper shared session read access" | Values stored in Paperclip's database and matched later. |
| `PAPERCLIP_THREADKEEPER_EXTENSION_IDS` | Still read as a fallback for helper shims written before the rename. The Mac helper now writes both names. |
| IndexedDB database `ThreadkeeperDB` | The whole library. A new name would open an empty database. (The class is `ThreadStackDB`.) |
| `threadkeeper.landed`, `threadkeeper.embedCookies` | Keys the extension already stored in the browser. |
| `toggle-threadkeeper` command, `threadkeeper-resumable-jobs` alarm | Custom keyboard shortcuts are stored by command id; an alarm under a new name would leave the old one running. |
| `threadkeeper-overlay-root`, `threadkeeper-overlay-iframe`, `CLOSE_THREADKEEPER_OVERLAY`, `TOGGLE_THREADKEEPER_OVERLAY` | Shared with content scripts that can still be the previous build in tabs opened before an update. |
| Message sources `threadkeeper-site-data`, `threadkeeper-identity`, `threadkeeper-identity-replay`, `threadkeeper-grok-x`, `threadkeeper-manager-iframe`, `threadkeeper-host-overlay`, `threadkeeper-embed-gesture`, events `threadkeeper:embed-cookie-*`, `Symbol.for('threadkeeper.*')` guards | Same reason: page scripts and content scripts from before an update must still reach, or be recognized by, the new build. |
| `threadkeeper-worker` | Name of the optional Cloudflare Worker, which is also its `workers.dev` host. |
| Manifest name `Threadkeeper` | Accepted alongside `ThreadStack` by the build's folder guard and the Mac helper, so earlier builds are recognized. |
| `AVRCORP/threadkeeper` | The upstream repository the CI guards name. |

See `.plan/verify/` for validation records and remaining runtime gaps.
