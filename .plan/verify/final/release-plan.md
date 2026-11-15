# Prepared live transition — not executed

The founder approved the working-snapshot import and pinned dependencies. The plan separately
reserves deployment, helper installation and background-service registration for a specific
go-ahead. None of the commands below has been run against the live installation.

Review [implementation and validation](report.md), including the unqualified broad test suite and
blocked native permission check, before deciding whether to proceed.

1. Inspect the current live extension identity, library count/backup and existing Paperclip service
   through authorized read-only or interactive mechanisms. Do not replace or stop another service
   without understanding its current ownership and active work.
2. Run the fork's guarded deploy to the **existing** loaded folder:

   ```sh
   cd /Users/andrew/dev/threadkeeper/paperclip
   TK_LIVE_DIR=/Users/andrew/dev/threadkeeper/.output/chrome-mv3 npx --yes pnpm@9.15.4 run deploy:extension
   ```

   The deployment forces a path identity and does not regenerate the manifest key. Confirm the
   browser still shows `bajiblleoodfabmofjmcjeejhbjikfkp` and the same library after reload; the ID
   is recorded from the plan and filesystem path, not newly claimed as an inspected live browser.
3. Install/update the fork's Mac helper with the live ID and fixed fork source folder. The shipped
   `extension/mac-helper/Install Mac Helper.command` performs that explicit setup; its Node installer
   also accepts `--paperclip-root`. The generated shim records the executable paths, extension-ID
   allowlist and bundled-plugin root.
4. Use the explicit first-time Paperclip setup action to register/start the fork service. Inspect
   its actual health/build/plugin status and verify it outlives closing the extension window.
5. Pair through the two actual UIs, share only the selected companies and complete native permission
   consent. Real provider delivery is a separate founder-present test on a disposable linked session;
   keep action and model-key transfer switches off until intentionally enabled.

The original checkout remains available. After the first live fork deploy, its old build command
must not overwrite the same live output folder with pre-integration code.
