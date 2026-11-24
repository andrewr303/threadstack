# Browser sessions

The first-party bridge keeps ThreadStack's library in the browser and exposes sessions to explicitly selected Paperclip companies. Each company has its own pairing token and inventory. Provider message text is fetched on demand, redacted, bounded and fenced as untrusted data.

Build from the fork root:

```sh
pnpm --filter @paperclipai/plugin-browser-sessions build
pnpm --filter @paperclipai/plugin-browser-sessions typecheck
pnpm --filter @paperclipai/plugin-browser-sessions test
```

The fork's existing bundled-plugin provisioner includes `browser-sessions`. The service must set `PAPERCLIP_BUNDLED_PLUGIN_ROOT` to this checkout's `packages/plugins` folder. It installs a missing built package, retains the persisted installation across restart, respects operator disable/uninstall, and lets the server start if loading fails. An explicitly requested local install can also use the existing CLI:

```sh
pnpm exec tsx cli/src/index.ts plugin install ./packages/plugins/plugin-browser-sessions --local --api-base http://127.0.0.1:3100
```

Installation, service registration and deployment to a live extension are separate operator actions. Builds above do not deploy the extension. The production instance was not changed during implementation.

In ThreadStack settings, pair the selected company. Confirm the eight-character code in Paperclip's company settings → Browser sessions. Sharing is off until selected. A board sharing receipt creates a narrowly scoped six-tool read grant through the host's policy service; explicit blocks, approvals and restrictive profiles still apply. Unsharing immediately purges inventory and blocks reads. Automatic task cross-links are imported with origin `auto`; deleting a link records a durable tombstone so the same pair is not recreated. An explicit board link can reauthorize it.

Browser actions are off by default on both sides. They require a board trust mark, enabled provider, current task, appropriate link origin, per-agent and per-session rate admission, and a unique request ID. An agent's ordinary links never grant acting scope. Started sessions gain scope only for the agent/task that started them. Duplicate IDs preserve the first result, including uncertain delivery. The extension independently rechecks its policy, account and privacy before provider submission.

The company settings page uses the host's native secret pickers for eleven model/worker/AWS key fields. Transfer is separately off by default. Resolution requires the company's paired token and a configured `secret_ref`; values are returned only to the extension's in-memory credential boundary. No values enter plugin storage, logs, UI data or action history.

Transport uses board-authenticated, company-scoped routes under `/api/plugins/browser-sessions/api`, with a separate `X-Threadkeeper-Bridge-Token` (header name kept from before the ThreadStack rename) on every `bridge/*` request. Long polls are bounded to twenty seconds, below host RPC deadlines. Queues are bounded and expire with individual request deadlines. A live connection renews its forty-second observation deadline; this is protocol renewal for an active browser resource. No database/network scan runs when unpaired or after active work settles. Event hint timers exist only for a concrete five-second coalescing window. Shutdown clears owned deadlines and rejects outstanding requests.

`src/contracts.ts` records the wire shapes. Inventory accepts `upserts`, `removes`, `automaticLinks: [{issueId,threadKey}]`, and settled observed state `events`. `bridge/connect` returns existing fingerprints and task links; `bridge/poll` returns typed requests, merged policies, links and bounded Paperclip change hints. Restart loses transient queued requests; durable action records prevent re-sending an uncertain prior action. HTTP diagnostics use private payload projections for bridge/pair namespaces.

Domain tests cover pairing, expiry, company boundaries, privacy removal, revocation races, typed responses, untrusted text, trust/link origin, rate limits, duplicate requests, cancellation, started-session linking, automatic-link tombstones, state notification deduplication and hint coalescing. Real provider sending and signed-in account delivery require browser acceptance evidence beyond these tests.
