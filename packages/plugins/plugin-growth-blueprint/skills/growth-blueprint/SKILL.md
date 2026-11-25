---
name: growth-blueprint
description: Build a growth blueprint for one website from public evidence, report each step to the task's progress panel with report_step, and attach the finished blueprint.html to the task.
---

# Growth blueprint

Use this skill when a task or a chat asks for a growth blueprint, a growth plan or a
growth teardown of a website. The research method lives in the vendored rea-growth
playbook in this skill's folder. This file adds what that playbook does not know:
how to run it without a person watching, the progress calls, the mode, the Treg and
budget checks, how to build `blueprint.json`, and how the result is published.

Where this file and `rea-growth/SKILL.md` disagree, this file wins.

## Folders and paths

There are three places. Keep them apart.

- **`SKILL_DIR`** is the folder that holds this SKILL.md (the wrapper folder). Set it
  once at the start of the run, for example
  `SKILL_DIR="<the folder this file was loaded from>"`.
- **`PLAYBOOK_DIR`** is the vendored rea-growth playbook inside it:
  `PLAYBOOK_DIR="$SKILL_DIR/rea-growth"`. It holds:
  - `SKILL.md`: the research playbook (steps 0 to 12).
  - `scripts/`: `analyze.py`, `blueprint.py` and `rea_math.py`.
  - `assets/blueprint.template.html`: the page template `blueprint.py` fills.
  - `references/`: channel, endpoint and method notes the playbook cites.
- **The task workspace** is your working directory for the run. Every file you write,
  including `calls.jsonl`, the CSVs, `blueprint.json` and `blueprint.html`, goes here.

The playbook was written to be its own skill, so it says `$SKILL_DIR/scripts/...` and
`python3 scripts/...`. Here `SKILL_DIR` is the wrapper folder, not the playbook. Wherever
the playbook or a reference says `$SKILL_DIR/scripts/...`, run
`"$PLAYBOOK_DIR/scripts/..."` instead, and read its `references/` and `assets/` from
`$PLAYBOOK_DIR` too.

Run every command from the task workspace and call the scripts by their full path. Run
Python as `python3 -B` so no `__pycache__` folder is written into the skill folder.
Never `cd` into the skill folder to run a script, and never write output files there.

## Running without a person

Nobody watches a blueprint run live, so these defaults replace the playbook's
interactive parts:

- **No pauses.** Skip the playbook's ◆ "continue, skip or stop" prompt after each step.
  Write the three-line finding into your notes, put a short version in the `detail` of
  your next `report_step` call, and go on to the next step.
- **Inputs the playbook asks for in step 0:**
  - Mode: the task's `Mode:` line (`free`, `quick` or `full`), which picks the playbook's
    mode of the same name. No `Mode:` line means `full`. Never content mode.
  - Target: the website from the task (see Inputs below). Never propose other targets.
  - The person's own company, domain and stage: `unknown`. Write the plays so that any
    early-stage team can start them, and say so in the method notes.
  - Country: US (`location_code` 2840, `language_code` `en`).
  - Budget cap: the task's data cap. In free mode it is $0 and nothing is billed.
- **Questions.** The only way to ask is a comment on the task. Ask only when you are
  blocked (see the procedure), then stop the run. Do not wait inside the run for an
  answer.

## Inputs

- **Website.** The task description has a `Website:` line. In a chat, use the domain
  the person pasted. Reduce it to a bare lowercase host with no scheme, `www.`, path or
  port: `https://www.Example.com/pricing` becomes `example.com`. Use exactly this
  string as `site` in every `report_step` call. A different site is rejected.
- **Mode.** The task description has a `Mode:` line: `free`, `quick` or `full`. If it
  is missing, the mode is `full`. In a chat, the mode is `full` unless the person asks
  for a free run.
- **Data cap.** The task description has a `Data cap:` line, in US dollars. In free
  mode it is $0. If the line is missing, the cap is $3.00 (full) or $0.60 (quick).
  Never spend more than the cap on Treg.

## The report_step tool

`report_step` comes from the Growth plugin. In your tool list it may carry a plugin
prefix, for example `growth-blueprint:report_step`. The plugin takes the task from
your run, so never pass a task, agent or company id.

Arguments: `step` (`reading`, `signals`, `building` or `published`), `site`, and
optionally `detail` (plain text, at most 140 characters, shown to the person),
`spentUsd` (Treg spend on this task so far), `blocked` (`treg_missing`, `budget` or
`site_unreachable`) and `attachmentId` (required for `published`).

In free mode, never pass `spentUsd`, and never report `blocked: "treg_missing"` or
`blocked: "budget"`: the plugin rejects both on a free task. Only `site_unreachable`
can block a free run.

Steps only move forward. Repeating the current step updates its note. If the tool
returns an error, read it, fix the cause, and call it again. Do not skip ahead to
`published` to finish early.

## Spend tracking

In free mode there is no spend to track: skip this whole section, do not run
`treg balance`, and do not report `spentUsd`. The playbook's free mode is the only
procedure that applies to data.

In quick and full mode:

- Before the first billed call, read the Treg balance: run `treg balance`, or call the
  `balance` tool if you use Treg through MCP. Save it as the balance before.
- Log every billed call as one JSON line in `calls.jsonl` in the task workspace, as
  `rea-growth/references/endpoints.md` describes:
  `{"step": "2", "endpoint": "<endpoint id>", "calls": 1, "cost_usd": 0.05}`.
- Spend so far is the sum of `cost_usd` in `calls.jsonl`. Pass it as `spentUsd`.

## Procedure

1. **Check Treg and the cap (playbook step 0).**
   - **Free mode: skip this step entirely.** Do not run `treg`, do not look for Treg
     tools, do not read a balance, and never report `blocked: "treg_missing"`, even if
     Treg is missing. Go to step 2.
   - Quick and full mode: run `treg --version`. If the command is missing, look for Treg MCP tools in your
     tool list instead.
   - If neither is available, call `report_step` with `step: "reading"`,
     `blocked: "treg_missing"` and `detail: "Treg is not connected"`. Then comment on
     the task that Treg needs to be connected in Apps, and stop this run.
   - Read the balance before (see Spend tracking).
   - If the cap is too small for even the first lookup, report `blocked: "budget"` on
     `reading`, say on the task what cap you need, and stop.
2. **Start reading (playbook step 1).** Call `report_step` with `step: "reading"` and a
   short `detail` such as `Reading the home and pricing pages`. Fetch the public site
   (free mode: with the playbook's free page and sitemap reads, not `treg.web.*`).
   If it cannot be reached, report `blocked: "site_unreachable"` on `reading`, say so
   on the task, and stop. Step 1's site map costs about $0.001. Log it, but it does
   not move you to `signals`.
3. **Free mode: pull the free sources (playbook step F).** Report `step: "signals"` with
   a `detail` such as `Starting the free source pulls` just before the first
   `free_sources.py` pull, and again after each source group (launch feed, attention
   series, people series, who talks) with a one-line `detail` and no `spentUsd`. Make no
   Treg calls. Then do the playbook's steps 10 and 11 (no calls) and go to step 4. The
   steps still run in the same order here: reading, signals, building, published.

   **Quick and full mode: collect the data (playbook steps 2 to 11).** Report `step: "signals"` just before
   the first billed call of playbook step 2. After each playbook step that made billed
   calls, report `signals` again with the new `spentUsd` and a one-line `detail`.
   Check the spend against the cap before every call. If the next call would pass the
   cap, stop calling, report `blocked: "budget"` with the current `spentUsd`, comment
   on the task that the cap is used up and that a person can ask you to finish with
   what you have or start a new task with a higher cap, and stop. A reply on this task
   does not raise the cap.
4. **Build the blueprint (replaces the delivery in playbook step 12).** Report
   `step: "building"`. Work out the plays, the things to skip, the timeline and the
   method notes as playbook step 12 describes. Then write them into `blueprint.json`
   instead of `playbook.md` and `playbook.html`.

   The playbook also has `analyze.py moves-collect` (gathers dated moves into a moves
   file), `analyze.py trends` (Google Trends brand demand into `demand.csv`) and
   `analyze.py ads` (ad creatives into a table); use them where its steps say to. Read
   their flags with `python3 -B "$AN" <subcommand> -h`. Add `--brand-demand demand.csv`
   and `--peers peers/*.csv` to `moves` when you have them, as playbook step 10 says.

   In free mode, run only the commands whose inputs you have from the free sources.
   Skip the `costs` command (there is no bill), leave `--calls` and `--costs` out of
   `scaffold`, and add the free-data flags the playbook's step F names
   (`--pulled-through`, `--series-unit`, `--source-label`). Every lane you could not
   read gets a note such as "not read in free mode"; `validate --strict` refuses a
   silent empty lane. The block below is the full-mode form.

   ```sh
   PLAYBOOK_DIR="$SKILL_DIR/rea-growth"
   BP="$PLAYBOOK_DIR/scripts/blueprint.py"
   AN="$PLAYBOOK_DIR/scripts/analyze.py"

   # 1. Moves against growth, first. Scaffold reads its CSV.
   python3 -B "$AN" moves --moves ./moves.csv --traffic ./traffic.csv --placebo \
     --today <YYYY-MM-DD> --csv-out ./moves-vs-growth.csv

   # 2. The bill: balance before and after, summed from the calls ledger.
   python3 -B "$AN" costs --ledger ./calls.jsonl --balance-before <before> --balance-after <after> -o ./costs.json

   # 3. A skeleton from the analysis files you made in steps 3 to 10.
   # Leave out any flag whose file you do not have.
   python3 -B "$BP" scaffold --company "<target name>" --domain <site> \
     --period <first YYYY-MM> <last YYYY-MM> \
     --traffic ./traffic.csv --inflection ./inflection.json \
     --moves ./moves-vs-growth.csv --calls ./calls.jsonl --costs ./costs.json \
     --today <YYYY-MM-DD> -o ./blueprint.json
   ```

   Check `python3 -B "$AN" moves -h` and `python3 -B "$BP" scaffold -h` for the exact
   flags in the playbook you were given, and use the playbook's own spelling if it
   differs. `--balance-before` and `--balance-after` take a bare number such as `10.00`.

   The file follows the `rea-growth/blueprint@1` schema, which `blueprint.py validate`
   checks. Replace every `TODO` the scaffold left with your findings: the plays (each
   with its stage, evidence, effort, first result and metric, and paste-ready prompt;
   the data cost is shown once in the page's cost section, not per play), the channels,
   the things to skip and the method notes. Do not add fields the schema in
   `$PLAYBOOK_DIR/references/blueprint.md` does not list. Mark every claim SEEN or
   INFERRED. Then check it and render it:

   ```sh
   python3 -B "$BP" validate ./blueprint.json --strict
   python3 -B "$BP" render ./blueprint.json -o ./blueprint.html --inline-images --offline
   ```

   `validate --strict` must exit 0. It lists each missing or invalid field; fix them
   and run it again. The page must be one self-contained file: `--inline-images` embeds
   local images, and `--offline` drops the web-font links and refuses any image given as
   a web address (the task viewer blocks every remote load). Before attaching it,
   confirm it loads no remote scripts, stylesheets, fonts or images:

   ```sh
   grep -nE '<(script|link|img)[^>]+(src|href)="https?://' ./blueprint.html
   ```

   That command must print nothing. If it prints a line, find the remote reference in
   `blueprint.json` (usually an image given as a web address), save that image into
   the workspace or drop it, and render again.
5. **Attach the page to the task.** Publishing means attaching to this task and
   nothing else.
   - If the native `register_deliverable` tool is available, use it with
     `contentRef: "blueprint.html"` (relative to the task workspace),
     `filename: "blueprint.html"`, `contentType: "text/html"`, the exact `byteSize`
     and SHA-256 of the file, `title: "Growth plan for <site>"`, and
     `idempotencyKey: "growth-blueprint-<site>-<YYYY-MM-DD>"`. Wait for the receipt
     and take `attachmentId` from it.
   - Otherwise run the upload helper that ships with the `paperclip` skill
     (`scripts/paperclip-upload-artifact.sh` in that skill's folder), from the task
     workspace:

     ```sh
     bash <paperclip-skill-folder>/scripts/paperclip-upload-artifact.sh ./blueprint.html \
       --title "Growth plan for <site>" \
       --content-type text/html \
       --output json | jq -r '.attachment.id'
     ```

     The helper prints `{attachment, workProduct, chatComment}`. The attachment id is
     `.attachment.id`.
   - See the paperclip skill and its artifact reference if the upload fails or the
     result is unclear. Never report a workspace path as the published file.
6. **Report published.** Call `report_step` with `step: "published"`, the `site`, the
   final `spentUsd` (not in free mode) and the `attachmentId`. The plugin checks that this attachment is
   on the task, is `text/html`, was uploaded by you, and was uploaded after the task
   started. If it rejects the call, fix the attachment and try again.
7. **Close out.** Comment on the task with two or three lines on what the blueprint
   found and the first play to run this week, link the attached file, and finish the
   task as the paperclip skill describes.

## Rules

- Free mode makes no Treg calls at all, even when Treg is installed and signed in.
- Public evidence only. Do not log in to the site, use anyone's private account, or
  collect personal data beyond public business contact details.
- Ask on the task before posting, sending, submitting or publishing anything outside
  the task, including outreach, forms and social posts.
- Keep `detail` notes short and factual. They are shown to the person as written.
