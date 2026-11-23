# Growth blueprint plugin

A first-party plugin that adds a **Growth** page and agent. Enter a website, and the
managed Growth agent studies it from public evidence, reports live progress, and
attaches a one-page HTML blueprint to the task.

## What it declares

- **Agent** `growth` (claude_local, paused until you resume it, explicit monthly
  budget). It syncs only the `growth-blueprint` skill. Because it reads untrusted web
  pages, it is declared with `canCreateAgents: false` and `canCreateSkills: false`.
- **Project** "Growth blueprints". Every run is a task in this project.
- **Skill** `growth-blueprint`. `skills/growth-blueprint/SKILL.md` wraps the vendored
  rea-growth playbook in `skills/growth-blueprint/rea-growth/`. Every text file under
  the skill folder ships with the skill (see `src/assets.ts`; host limit 50 files,
  200 000 characters each).
- **Tool** `report_step`. Task, agent and company come from the run context only.
- **UI** page at `/growth` and a sidebar entry.

## Vendored rea-growth snapshot

`skills/growth-blueprint/rea-growth/` is a copy of the rea-growth skill: `SKILL.md`,
`scripts/{analyze,blueprint,rea_math}.py`, `assets/blueprint.template.html` and
`references/*.md`. Tests, examples and caches are left out. The snapshot is unmodified.
The template still carries its Google Fonts `<link>` tags; `render --offline` strips
them (and refuses remote images) when the page is built, so the attached file loads
nothing remote and falls back to the local font stacks in its CSS. The wrapper
`SKILL.md` always renders with `--inline-images --offline`.

The wrapper `SKILL.md` overrides the playbook where it assumes a person is present
(no pause prompts, fixed defaults for the person's company, stage and country) and
replaces its step 12 delivery with `blueprint.py scaffold`, `validate --strict` and
`render --inline-images --offline`. It names the wrapper folder `SKILL_DIR` and the
playbook folder `PLAYBOOK_DIR="$SKILL_DIR/rea-growth"`, and tells the agent to run the
playbook's `$SKILL_DIR/scripts/...` commands from `$PLAYBOOK_DIR/scripts/...` with
`python3 -B`.

## Treg access

The Growth agent reaches Treg in one of two ways:

- **The `treg` CLI**, when it is installed and signed in on the machine the agent runs
  on. The agent is `claude_local`, so it runs on the host machine and uses that
  machine's `treg` login. For unattended runs, sign in once with
  `treg login --token <team-token>`.
- **The Treg MCP connection**, connected in Apps.

If neither is available on a quick or full task the agent reports
`blocked: "treg_missing"` and the page offers Connect Treg.

## Modes

The start form offers three modes, and Free is the default:

- **Free**: public sources only, no data spend, no Treg calls. The agent follows the
  playbook's free mode, so it never needs Treg and the plugin rejects `treg_missing` and
  `budget` blocks on a free task. Its cap is always $0.
- **Quick**: about $0.60 of data (the playbook's quick mode).
- **Full**: up to $3 of data (the playbook's full mode).

For quick and full the person can set a data cap above $0 and up to $10. The task
description carries `Mode:` and `Data cap:` lines the skill reads. A free and a full task
for the same site are different tasks, so starting one does not return the other. Tasks
saved before modes existed have no mode and are treated as full.

This plugin ships no Treg mark. The Treg brand SVGs the host's Apps catalog shows
(`ui/public/brands/apps/treg.svg` and `treg-dark.svg`) are placeholders until the
official mark is supplied; replace them then.

## Progress contract

See `src/contracts.ts`. Steps are `computer`, `reading`, `signals`, `building`,
`published`. The job record lives in plugin state scoped to the task, every change is
written to the activity log, and the full record is emitted on the company-scoped
`blueprint-progress` stream. `published` is accepted only after the worker finds the
named `text/html` attachment on the same task, uploaded by the task's Growth agent
after the task started. Writes to one task's job, to the company's task index, and
each start's duplicate check run under an in-worker lock, and each job carries a
`revision` that a save re-checks.

## Viewing the blueprint

"View blueprint" links to the task with `?attachmentId=`. In the default (coordinator)
workspace the host opens the file in the task's Artifacts panel. In the classic
workspace it opens the task, and `blueprint.html` is under the task's attachments.

The rendered page opens source links with `target="_blank"`. The host preview sandbox
has no `allow-popups`, so those links may not open from inside the viewer. This has
not been checked in a browser yet.

## Commands

```sh
pnpm --filter @paperclipai/plugin-growth-blueprint typecheck
pnpm --filter @paperclipai/plugin-growth-blueprint test
pnpm --filter @paperclipai/plugin-growth-blueprint build
```

Install it from its local path in the instance plugin settings. Connect Treg in Apps
before the first run.

`pnpm run check:tokens` only scans tracked files, and `check:token-gates` only scans
`ui/src`, so neither covers this package while it is untracked. The contracts test
checks the package for absolute home paths.
