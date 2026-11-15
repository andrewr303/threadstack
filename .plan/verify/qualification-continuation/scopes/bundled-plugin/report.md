# Bundled browser-sessions package fixture repair

## Diagnosis

The production bundled catalog correctly includes browser-sessions. Its real package.json and manifest both have version0.1.0. The error is not a missing package version: `manifest` was undefined because `bundled-plugin-package.test.ts` imported and mapped only sandbox provider manifests. The generic shipped-package fixture also assumed every bundle was worker-only and did not create a UI directory. The browser-sessions package declares `./dist/ui/`; after fixing the manifest lookup, the resolver correctly rejected that missing fixture directory.

## Change

Only `server/src/__tests__/bundled-plugin-package.test.ts` changed:

- Import the actual browser-sessions manifest and map its catalog key.
- When a real package declares a UI entrypoint, create that directory in the disposable package fixture.

The production package, manifest, catalog, resolver, and policy remain unchanged. All existing shipped-package identity, version, compatibility, containment, and tamper assertions remain unchanged. No bundle was excluded, and no resolver guard was bypassed.

## Validation

Runtime: Node24.22.2 and Vitest5.0.3 through the parent qualification wrapper and protected environment/sandbox policy.

Base command: `python3 /tmp/tk-continue/runtime/run-qualification.py <receipt-name> pnpm exec vitest run --project @paperclipai/server server/src/__tests__/bundled-plugin-package.test.ts --maxWorkers 1`.

1. RED (`bundled-plugin-red`): exit1, 14passed/1failed. Failure is undefined manifest.version for browser-sessions.
2. Intermediate (`bundled-plugin-green`, preserved as `manifest-import-attempt`): exit1, 14passed/1failed. After the actual manifest is imported, the missing fixture UI directory is reported by the real entrypoint containment resolver.
3. GREEN (`bundled-plugin-green-final`): exit0, all15tests passed. The real browser-sessions package/manifest contract now passes with all other shipped packages.
4. `git diff --check -- server/src/__tests__/bundled-plugin-package.test.ts`: exit0.

`source-hashes.json` records before/after hashes; only the named test changed. `change.patch` retains the exact patch. The required ult-debugger router/TypeScript workflow was followed; triage does not recognize Vitest's assertion-stack formatting, so its unparsed results and complete RED logs are retained. `debugger-doctor.txt` records available debug tooling; the test wrapper uses the separately recorded Node24.22.2.

No production edit or browser/UI evidence invalidation. No broader suite, build, live folder, helper/service, source HEAD, commit, push, or workflow action was performed by this repair.
