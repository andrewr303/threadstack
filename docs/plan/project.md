---
id: PROJECT
title: Paperclip + Threadkeeper merge
status: active
root: docs/plan
prd:
created: 2026-11-13
updated: 2026-11-13
---

# Paperclip + Threadkeeper merge

Threadkeeper (a Chrome/Edge extension that embeds AI provider sites, captures every conversation and
searches them with embeddings and reranking) is merged into a hard fork of Paperclip (an AI-agent
orchestration server and web app). The result is one window for a solo founder: Paperclip's real web
app runs inside the extension, Threadkeeper's Browse, Threads and Dashboard appear in Paperclip's
sidebar, and Paperclip's agents can find, read, link and (when trusted) act on the founder's browser
sessions. "v1 done" means EPIC-1 to EPIC-3 are done and REQ-12 and REQ-13 of EPIC-4 are done.

**Nothing in this plan may start until the founder's separate multi-profile work is merged.** See
`HANDOFF.md` and REQ-1.

## Defaults

- Artifact root: `docs/plan/` in the Threadkeeper repository until REQ-2 moves it to `.plan/` at the fork root.
- PRD path: none. The brief (`briefs/BRIEF-1-one-window.md`) is the product contract.
- Stack (from platform context): extension is TypeScript, React 18, esbuild, Dexie, vitest, npm;
  Paperclip is TypeScript, Express 5, Postgres via Drizzle, React 19, Vite, pnpm workspace, Node 24.11 or newer.
- Sequencing: each REQ builds on the last unless its `blocked_by` says otherwise. REQ-1 gates everything.
- Session hooks: `config.json` has `hooks.enabled: false` on purpose, so this plan does not load into
  other sessions working in this repository. REQ-1 turns it on.

## Open decisions

| ID | Decision | Default if skipped |
|---|---|---|
| Q-1 | Where the fork is pushed (GitHub organisation, repository name, visibility) | Local branch only; nothing is pushed |
| Q-2 | Label for Threadkeeper's Dashboard in Paperclip's sidebar (Paperclip already has "Dashboard") | "Session board" |
| Q-3 | If the fused-sidebar spike fails: accept view switching, or try another technique | Accept view switching (REQ-5 behaviour) |
| Q-4 | May every agent in a shared company read sessions, or only named agents | Every agent in a company the founder shares sessions with |
| Q-5 | Which sessions a trusted agent may act on | Only sessions linked to the agent's current task |
| Q-6 | Rate limits for trusted agents | 10 sends and 3 starts per agent per hour; 1 send per session per 60 s |
| Q-7 | Providers enabled for agent actions | Each provider off until the founder turns it on; adapters for Claude, Claude Code, ChatGPT and Codex first |
| Q-8 | Product name and extension name after the merge | No rename in v1; the extension keeps its name and ID |
| Q-9 | Keep REQ-14 (credentials in one place) | Keep as P2, last |
| Q-10 | Final folder for the fork working copy (today it sits inside the Threadkeeper folder) | Leave in place for REQ-2; decide before pushing |
| Q-12 | G-1's option said Paperclip's app runs "unmodified"; the plan makes small edits to Paperclip's interface (REQ-5 route reporting and header handling, REQ-6 sidebar host mode and overlay reporting, REQ-13 search section). Accept? | Yes: G-4 (hard fork) removed the reason for "unmodified", which was clean upstream merges |
| Q-11 | Which folder the browser loads Threadkeeper from after the merge | Keep loading `/Users/andrew/dev/threadkeeper/.output/chrome-mv3` and deploy the fork's build into it with `pnpm run deploy:extension` (same ID, same library). Alternative: move the library to the fixed-key ID by backup and restore |
