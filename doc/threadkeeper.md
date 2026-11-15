# Threadkeeper in this Paperclip fork

This fork includes Threadkeeper under `extension/`. Its IndexedDB library, account identifiers,
provider pages, embeddings and retrieval stay in the extension. Paperclip stores company-scoped
session metadata and task links through the first-party `browser-sessions` plugin.

The import retains Threadkeeper's Git history and the approved working snapshot. The previous
checkout is preserved. Implementation and acceptance records live in `.plan/`.

## Development and verification

Use Node 24.11 or newer and the repository's pinned pnpm 9.15.4. Install the root workspace with
pnpm and install `extension/` separately with `npm ci`. The extension remains outside the pnpm
workspace and uses React 18; Paperclip uses React 19.

```sh
pnpm run check:extension
pnpm run check:all
```

The guarded checks typecheck and test the extension, then build only into `/tmp/tk-build` with
its own path-based extension ID. `check:all` also runs the root typecheck and tests. The native
Runner's existing Rust checks require the toolchain recorded in `packages/paperclip-runner/rust-toolchain.toml`.

Never build from the previous checkout into the browser's live folder. For an intentional deploy,
set `TK_LIVE_DIR` to the existing unpacked-extension folder and run `pnpm run deploy:extension`.
That command preserves the path-based extension ID and therefore the library associated with it.
The command fails without an explicit target. Review the completed checks before deploying.

## Local service and embedded app

Run `extension/mac-helper/Install Mac Helper.command` to register the helper with the current
extension ID and this fork's directory. It records fixed executable paths and a source shim.
In Settings → Paperclip, grant access to the selected origin and use `Set up Paperclip` for
the first background-service installation. Later openings can start that registered service.
Closing Threadkeeper leaves Paperclip running.

The Paperclip view loads the real server app in a persistent direct-child frame. It keeps its
own routing, sign-in, live updates and security headers. The source shim exports the helper's
registered IDs through `PAPERCLIP_THREADKEEPER_EXTENSION_IDS`; other server launch methods must
set that runtime allowlist themselves for the host handshake. Both sides validate the sender's
window, exact origin, protocol and path. Provider frames remain direct children of Threadkeeper.

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

Actions require the extension's master/provider switches, the company's master/provider switches,
a trusted agent, and an eligible link to that agent's current task. Agent-created links do not
grant action authority. All switches default off. Only Claude, Claude Code, ChatGPT and Codex
have initial delivery adapters.

The worker targets one manager document and the exact recorded account. It refuses another
account's occupied profile slot. Persistent request IDs, rate limits and delivery receipts prevent
repeated submissions. An interrupted submission is recorded as uncertain and is never retried
automatically. A real signed-in-provider acceptance run remains a separate founder-operated check.

## Model keys

Model-key transfer is opt-in. Select the source company, link its secrets and explicitly allow
transfer. Resolved values exist only in the feature call's memory. A linked remote feature pauses
when Paperclip is unavailable; local search continues.

`Move my keys to Paperclip` is an explicit action. It reads each new secret back successfully before
deleting that key's local value. A failed readback preserves the original value. Successfully moved
values are absent from new extension backups; older backups retain their original contents.

See `.plan/verify/` and `.acceptances/paperclip-merge/` for actual validation and remaining runtime gaps.
