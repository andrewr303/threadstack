# The blueprint: `blueprint.json` → `blueprint.html`

`scripts/blueprint.py` turns one JSON file into a one-file page: a traffic curve with milestones
pinned on it and the inflection window shaded; lanes of dated moves under it on the same time axis;
a tabbed showcase of evidence cards per channel; ten plays with copyable prompts; things to skip;
the bill; the method. `examples/acme/blueprint.json` is a complete fictional example of every field
(`python3 scripts/blueprint.py demo -o demo.html` renders it).

```
blueprint.py scaffold --company N --domain D --period START END --traffic traffic.csv \
  [--series-id ID --series-label L --series-sublabel S --source-url U --source-date D] \
  [--extra-series CSV:ID:LABEL ...] [--inflection inflection.json] [--moves moves-vs-growth.csv] \
  [--calls calls.jsonl] [--costs costs.json] [--today D] -o blueprint.json
                                              # chart, window, lanes, bill from the analysis outputs
blueprint.py validate blueprint.json --strict # every rule below; TODO markers fail
blueprint.py render blueprint.json -o blueprint.html --inline-images [--offline]
blueprint.py md blueprint.json -o playbook.md
```

`--offline` drops the web-font links and refuses remote images: use it whenever the page will be
viewed inside a sandbox with a strict CSP (threadkeeper's artifact viewer, email, some wikis).
Download images next to `blueprint.json` first; `--inline-images` embeds them.

## Text

Every text field is markdown-lite: `**bold**` for the number that matters, `` `code` `` for paths
and parameters (`/pt-br/`, `?via=`), `[label](url)` for sources. Everything else is escaped. Only
`https:`/`http:`, `mailto:` and relative URLs survive; anything else becomes `#`.

## Top level

| Field | Notes |
|---|---|
| `schema` | `"rea-growth/blueprint@1"` |
| `company` | `{name, domain, logo?}` |
| `title` | optional, default "<name>'s growth blueprint" |
| `period` | `{start, end}` months shown on the time axis |
| `as_of` | date every count was read |
| `pulled_through`, `cost_usd` | header line: "every number pulled through treg, $0.58 of data" |
| `example` | `true` only for fictional demos (required when the domain ends in `.example`) |

## `chart`

- `series[]`: `{id, label, short_label?, sublabel ("a month, US est."), unit, source {label, url,
  date}, points [{month, value, partial?}], leaves_out?}`. Two or more series get a switch.
  Attention series (visits, views) lead; a people series (stars, headcount, sign-ups) leads only when
  no attention series is left. Brand demand from Google Trends is a good second series.
- `annotations[]`: `{date, text, detail?, url, evidence, series?, priority?}`: reported revenue,
  user milestones, raises. Short text ("$15M", "10K teams"); lower `priority` gives way first when
  labels crowd.
- `windows[]`: `{start, end, label, series?}` from `analyze.py inflection` (`window`), drawn only
  when the window rule in `methods.md` holds.

## `lanes[]`

`{id, label, note?, moves[]}`; usual lanes: `seo` "SEO / AEO", `ads` "Ads", `social` "Social
media", `loop` "Product loop", `company` "Company" (launches, funding, hires). A move: `{date, label, platform, url, evidence, detail?, highlight?,
icon?}`. `label` ≤ 32 characters (the chip); `detail` holds the numbers and the date read.
`highlight: true` = the move lined up with growth (from `analyze.py moves`, or "Most views" when
lift cannot be credited). Platforms: x, youtube, tiktok, instagram, linkedin, reddit, meta,
google, google_ads, bing, chatgpt, gemini, perplexity, github, hn, producthunt, link, web, email,
podcast, app_store, play_store, trustpilot, wayback, news, money.

## `channels[]`: the showcase

`{id, label, icons[], takeaway, cards[≤3]}`. The takeaway is one line that ties the cards to the
curve ("Each post came right before Google visits grew faster."), only if step 10 supports it.

A card: `{title, finding, source {label, date, url}, evidence, visual}`. Title = the play in 4-8
words ("Put a badge on every app users publish"). Finding = one sentence, number in bold
("**20,132 sites** now link back through “Edit with”."). Source footer = where and when
("BACKLINKS · DATAFORSEO · 29 OCT 2026").

| `visual.type` | Use for | Fields |
|---|---|---|
| `post` | a top post (founder, creator, user) | `platform, author, handle, avatar?, date, text, highlight` (a substring of text), `media?` (path or list), `media_alt?`, `metrics {views, likes, …}`, `url` |
| `ads` | creatives sharing a caption, local-language ads | `network, quote?` (the shared caption), `images [{src, alt, caption?}]` (2-4) |
| `badge` | an output-badge loop | `badge_text` ("Edit with"), `brand, brand_icon?, note` ("↳ links every app back to …"), `windows [{host, src?}]` (2-3 user sites) |
| `links` | affiliate / referral codes | `rows [{domain, param ("?via="), value, url?}]` |
| `ai_answer` | AI answer share | `engine, question, ranked [{name, icon?}], target, pages [cited urls]` |
| `image` | a screenshot that is the evidence | `src, alt` |
| `stat` | a number with nothing better to show | `value, label, kicker?, bar? {value, max, min_label, max_label}` |

## `plays`, `skip`, `path`, `next`, `calls`, `method`

- `plays`: `{show: 3, items[10]}`; item `{title, stage, effort, first_result, metric, evidence
  [{kind: SEEN|INFERRED, text}], prompt, channel?}`. Stages: Get noticed, Sign up, First win, Pay,
  Share. `--strict` requires exactly ten plays, each with stage, effort, metric and at least one
  SEEN item whose text carries a `[link](url)`.
- `skip[]`: `{title, why}`; `--strict` requires 2-3.
- `path` (optional): `{stages: [{stage, text, evidence, url?}], loops: [{name, text, since?}]}`:
  one row per stage (Get noticed → Share), rendered as a stage strip, and the 1-2 dominant loops.
- `next[]` (optional): `{text, evidence, url?}`: "What they are scaling next" (hiring, new pages).
- `mode` (optional): `"growth"` (default) or `"content"`. Content mode skips the play rules and
  titles the page "<name>'s content report".
- `calls`: `{total_usd, items [{label, endpoints [{id, calls, cost_usd}], cost_usd}], footnote}`
  (`scaffold --calls calls.jsonl` fills it; totals must add up).
- `method[]`: one markdown-lite line per note.

## What `validate` refuses

Wrong schema id; bad dates; a move, card or annotation without SEEN/INFERRED; SEEN without a url;
a post `highlight` that is not in its text; window start ≥ end or outside the period; duplicate
lane or channel ids; plays without a prompt; missing local images; `javascript:` URLs anywhere;
non-finite numbers. Warnings (errors under `--strict`): more than 3 cards per channel, an AI
`target` missing from `ranked`, a bill that does not add up, TODO markers left by `scaffold`.
