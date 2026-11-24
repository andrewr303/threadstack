# ThreadStack local service and safe checks

The extension is an independent npm package in `extension/`. Paperclip uses the
root pnpm workspace; the extension keeps React 18 and its own lockfile.

Use Node 24.11 or newer and the root package manager version, pnpm 9.15.4. Install
root and extension dependencies separately. The complete Paperclip typecheck
also needs the Rust toolchain and rustfmt pinned in
`packages/paperclip-runner/rust-toolchain.toml`.

```sh
pnpm run check:extension
pnpm run check:all
```

`check:extension` runs the extension typecheck, unit tests and build. `check:all`
first runs Paperclip's root typecheck and test suite, stopping on any failure.
The check wrapper verifies that the extension stays outside the pnpm workspace
and that the root script definitions still use the guarded commands. All check
builds go to `/tmp/tk-build` with a path-based extension ID, irrespective of
inherited `TK_OUT_DIR`, `TK_LIVE_DIR`, or `TK_STABLE_ID` values. These checks never
deploy to the founder's browser. Both modes also run the guard tests
(`pnpm run test:threadstack`) and, after the build, require that
`/tmp/tk-build/manifest.json` was written by that run and has no `key`.

Deployment is a separate action:

```sh
TK_LIVE_DIR=/absolute/folder/the/browser/already/loads pnpm run deploy:extension
```

Keep the existing loaded folder to preserve its extension ID and library. The
command refuses an unset or relative destination, symlinks resolved first: the
home folder and its parents, the fork and anything inside it, and `/tmp/tk-build`
and anything inside it are rejected. Other folders inside the home folder, such as
an existing live folder such as `~/dev/threadkeeper/.output/chrome-mv3`, are allowed. It forces a path-based ID. Do not run it
without authorization for that deployment. Never regenerate the extension key.

## Registering the source checkout with the Mac helper

Run `extension/mac-helper/Install Mac Helper.command` on macOS. It can detect the
fork when run from this checkout; otherwise enter the absolute Paperclip folder
when prompted. Root dependencies must already be installed. The command-line
equivalent is:

```sh
node extension/mac-helper/install.cjs --paperclip-root /absolute/path/to/fork
```

This registers the native messaging host for the detected ThreadStack IDs and
writes a fixed source shim under
`~/Library/Application Support/Threadkeeper/Bridge/paperclip-source`. It does not
register a login service. The shim records absolute Node, tsx and CLI paths and
exports the registered extension IDs, which enables the exact-origin host
bridge in Paperclip's UI. The server reads `PAPERCLIP_THREADSTACK_EXTENSION_IDS`
and, for shims written before the rename, `PAPERCLIP_THREADKEEPER_EXTENSION_IDS`;
when both are set their IDs are combined. Other launch methods can set either. It also sets `PAPERCLIP_BUNDLED_PLUGIN_ROOT` to this
fork's `packages/plugins` so the browser-sessions plugin can be provisioned from
the local source package.

In the extension's Paperclip settings, choose **Set up Paperclip** to install and
start the launchd service. This explicit action runs the fork's existing service
manager. Later openings can start that registered service automatically.
`paperclip.status`, `paperclip.start`, and `paperclip.install` native messages
accept no executable, folder, origin or arguments from the page. A start request
cannot install a missing service or replace a service registered for a different
Paperclip executable. Re-run the helper installer if the checkout or Node path
moves.

The shell shows `Run "Install Mac Helper.command" again and choose the Paperclip
folder.` when nothing is registered. With no helper installed it sends no native
message more than once per window. Automatic starts are deduplicated for 60 seconds
in the extension's service worker memory only; a worker restart forgets that, which
is safe because starting an already active service does nothing.

Closing the extension does not stop Paperclip. Remote servers can be connected
and embedded, but the Mac helper never starts them. Without a registered helper,
start the service manually from the fork with `pnpm paperclipai service start`.

## Disposable local acceptance instance

The documented dev server supports a separate state root:

```sh
pnpm dev:once --data-dir /absolute/temporary/paperclip-home
```

For concurrent instances, configure a free application port and embedded
PostgreSQL port, and set `PAPERCLIP_CONFIG`, `PAPERCLIP_HOME`, and
`PAPERCLIP_INSTANCE_ID` explicitly. The database, storage, secrets key, logs, and
plugin installation records must all belong to that temporary instance. Never
seed an acceptance instance from the founder's live data. The runtime uses the
ordinary local plugin install API to install the browser-sessions package in the
disposable database; that does not install it in another running instance.
