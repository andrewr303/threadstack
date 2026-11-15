Commands captured from /Users/andrew/dev/threadkeeper/paperclip. Each receipt records before/after source hashes, exact argv, result, timestamp and log hash. No host environment override was supplied.

owned-before.json
```sh
node node_modules/vitest/vitest.mjs run --project @paperclipai/server server/src/services/remote-workspace-snapshot-archive.test.ts server/src/services/remote-workspace-migration.test.ts --reporter=verbose
```
Exit 0; 226.808s; log: /tmp/tk-continue/archive/owned-before.log

retained-pack-red.json
```sh
node node_modules/vitest/vitest.mjs run --project @paperclipai/server server/src/services/native-runtime/retained-provider-pack-source.test.ts -t 'installs the exact retained pack through the real uploader on an empty host instead of the current image archive' --reporter=verbose
```
Exit 1; 1.074s; log: /tmp/tk-continue/archive/retained-pack-red.log

doctor.json
```sh
python3 /Users/andrew/dev/Plugins/ult-debugger/scripts/ultdbg_cli.py doctor
```
Exit 0; 0.675s; log: /tmp/tk-continue/archive/doctor.log

platform-repro.json
```sh
node /tmp/tk-continue/archive/platform-repro.mjs
```
Exit 0; 0.146s; log: /tmp/tk-continue/archive/platform-repro.log

long-path-red.json
```sh
node node_modules/vitest/vitest.mjs run --project @paperclipai/server server/src/services/native-runtime/native-skill-library-tools.integration.test.ts -t 'loads long supporting paths from the returned inventory' --reporter=verbose
```
Exit 1; 23.559s; log: /tmp/tk-continue/archive/long-path-red.log

retained-pack-triage.json
```sh
python3 /Users/andrew/dev/Plugins/ult-debugger/scripts/ultdbg_cli.py triage /tmp/tk-continue/archive/retained-pack-red.log --json
```
Exit 1; 0.106s; log: /tmp/tk-continue/archive/retained-pack-triage.log

platform-short-root.json
```sh
node /tmp/tk-continue/archive/platform-repro.mjs
```
Exit 0; 0.186s; log: /tmp/tk-continue/archive/platform-short-root.log

retained-pack-log-triage.json
```sh
python3 /Users/andrew/dev/Plugins/ult-debugger/scripts/ultdbg_cli.py logs /tmp/tk-continue/archive/retained-pack-red.log -C 2
```
Exit 0; 0.096s; log: /tmp/tk-continue/archive/retained-pack-log-triage.log

short-root-triage.json
```sh
python3 /Users/andrew/dev/Plugins/ult-debugger/scripts/ultdbg_cli.py triage /tmp/tk-continue/archive/short-root-stack.txt --json
```
Exit 0; 0.131s; log: /tmp/tk-continue/archive/short-root-triage.log

retained-pack-complete.json
```sh
node node_modules/vitest/vitest.mjs run --project @paperclipai/server server/src/services/native-runtime/retained-provider-pack-source.test.ts --reporter=verbose
```
Exit 1; 1.701s; log: /tmp/tk-continue/archive/retained-pack-complete.log

owned-current.json
```sh
node node_modules/vitest/vitest.mjs run --project @paperclipai/server server/src/services/remote-workspace-snapshot-archive.test.ts server/src/services/remote-workspace-migration.test.ts --reporter=verbose
```
Exit 0; 148.143s; log: /tmp/tk-continue/archive/owned-current.log


Final bounded integration check:
```sh
python3 /tmp/tk-continue/archive/finalize-evidence.py
```
Exit 0; lead-integration-check.json passed=true.
