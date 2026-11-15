# Workspace and retrieval continuation

Runtime: Synara integrated browser, fallback from BrowserOS neo (tools absent).
Target: existing preview server at http://127.0.0.1:4317, built from this worktree.
Role: synthetic demo library, stubbed extension APIs, no real provider login or API key.

| ID | Outcome | Actions and assertion | Required evidence |
| --- | --- | --- | --- |
| workspace | Three workspace views remain reachable | Switch Threads, Browse, Dashboard and back; inspect the actual visible panels | Screenshot and execution transcript |
| filters | Active filters can be collapsed | Set a provider filter, collapse Filters, confirm count remains, reopen and clear | Screenshot and execution transcript |
| endpoints | Endpoint choice persists | Settings, Search & embeddings, select Voyage and each endpoint, close/reopen; inspect MongoDB geography controls without entering a key | Screenshot and execution transcript |
| narrow | Workspace controls remain usable at narrow width | Resize to 800px, open navigation drawer, reach Threads and settings; inspect layout | Screenshot and execution transcript |
| live-provider | Real signed-in provider interaction | Requires user logins; no credentials available in isolated preview | Blocked |
| live-model | Hosted embedding/rerank account success | Requires authorized model key and paid call; no calls made | Blocked |

Supporting checks: typecheck, build, unit/fixture tests, offline retrieval evaluation. These are separate from browser acceptance. Previous workspace E2E screenshots are not recaptured or relabelled; they cover provider-host stand-ins only.
