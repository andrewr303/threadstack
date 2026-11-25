---
name: rea-growth
description: Use when the user wants to know how a company gets its users, reverse engineer a competitor's growth or distribution, find when and why a startup's growth took off, copy what a winning company does on each channel, or study a brand's content (titles, thumbnails, covers, captions, ads) on YouTube, TikTok, Instagram, X, LinkedIn or Reddit. Delivers a cited growth blueprint page (traffic curve with every move dated under it, evidence cards per channel, ten plays with prompts). Also for "how did X grow", "teardown of X's marketing", "growth blueprint for X", "what content works for X".
---

# REA growth

A company in, a growth blueprint out: when it grew, which moves came right before, how it wins on
each channel, and ten plays the user can copy, each with a ready prompt. The deliverable is a
one-file HTML page (`blueprint.html`) plus `playbook.md` and the CSVs behind every number.

Runs on treg. If `treg --version` fails, read https://treg.to/llms.txt, install and sign in, then
come back. `SKILL_DIR` below is the folder holding this file; scripts are stdlib Python 3.10+.

## Modes

| Mode | When | Steps | Cap | Delivers |
|---|---|---|---|---|
| **full** (default) | "how does TARGET grow", "teardown", "what to copy" | 0-12 | $3 | blueprint + playbook.md + CSVs |
| **quick** | "rough idea", a list of companies, a tight budget | 0, 1, 3 (target + 1 peer), 4, 5 (Meta + Google only), 8, 10, 12 | $0.60 | blueprint with SEO/AEO, Ads, Product loop lanes |
| **free** | no treg, no budget, "just use your own tools" | 0, 1, F, 10, 11, 12 | $0 | blueprint on free public signals (see "Free mode") |
| **content** | titles, thumbnails, covers, captions, "what content works", nothing about growth | 0, 1 (handles only), 7, 13 | $1 | `content.md` + `content.html` + CSVs |

## Rules

- Every finding is **SEEN** (a call result, page or image shows it; link it, date it) or
  **INFERRED** (reasoned from what was seen; say from what). Nothing seen → "not seen". Absence in an
  ad library, timeline or index proves nothing on its own.
- Public evidence only. Create no accounts, fill no forms, post nothing, contact no one.
- **Numbers come from scripts.** Every figure in the blueprint is printed by `scripts/analyze.py` or
  read straight from a saved call result; never typed from memory or rounded by hand. Date every count.
- **Money.** Before an endpoint's first call: `treg catalog get <id>`, quote the price, check it fits
  the cap. Append one line per call to `calls.jsonl`:
  `{"step":"3","endpoint":"<id>","calls":1,"cost_usd":<charged or quoted>}` (a bare step number
  renders as "3 · Traffic and peers"). Run `treg balance` at the start and the end; the bill is the
  difference. Prices and ids: `references/endpoints.md`.
- Free first: `treg.web.search` / `treg.web.extract` with header `X-Treg-Route-Prefer: tinyfish`.
  Blocked page → the route tries the next vendor; still blocked → list it as blocked, move on.
- An endpoint fails → `treg catalog search` the same job, try one alternative → else "unavailable".
- Save every raw result under the run folder before reading it (`raw/<step>-<name>.json`).
- How numbers become claims (inflection, peers, lift, placebo, loops, date bounds):
  `references/methods.md`. Read it once before step 3.
- ◆ After each step (interactive runs): 3-line finding + what the next step checks + est. cost →
  continue | skip | stop. Unattended runs (a task, a routine) never pause: note it and go on.

## How the steps connect

Step 1 gives the path families, handles and touchpoints. Step 2 gives dated launches, raises,
pixels and hires. Step 3 marks the inflection against peers. Steps 4-9 each pull one channel group
and yield **dated moves** (`date,channel,label,platform,url,evidence,detail,reach`; channel ∈ seo,
ads, social, loop, company). Moves are not typed by hand: `analyze.py moves-collect` builds
`moves.csv` from the saved outputs (Wayback changes, website evolution, news and funding, loop
anchors, ads, ranked posts, free-source moves), and only what no script reads goes in a small
`manual.csv` via `--extra`. Step 10 credits moves against growth. Steps 11-12 order it along the
customer's path and write the blueprint.

## 0 · Setup

INPUT: mode | target domain | user's company + domain (optional) | user's stage (pre-launch / early
revenue / scaling) | cap | country (US → location_code 2840, language_code en). Ask only for what
is missing and matters; unattended runs default to US, full mode, $3, stage unknown.
No target → `treg.web.search` {"q":"fastest growing <category> startups 2026"} → propose 3.

Make the run folder and start the bill:
`R=rea/<domain>-$(date +%Y%m%d-%H%M); mkdir -p $R/raw $R/peers $R/img $R/posts && cd $R && treg balance > balance-before.txt`
(local date, so the folder matches the `--today` you pass everywhere)
(free mode: skip `treg balance`). Every later path is relative to this folder; never reuse
another run's folder.

## 1 · The site — ~$0.04 (page reads free)

- `treg.web.map` {"url":"https://TARGET"} → `urls.txt` (also fetch `/sitemap.xml`). Then
  `python3 $SKILL_DIR/scripts/analyze.py families --urls urls.txt --brand <brand>` → path families,
  URL templates, programmatic-SEO families (one template with 50+ pages), `/x-vs-y` pages, locales.
- `treg.web.extract` on home, about, pricing, sign-up, onboarding/getting-started doc, referral /
  affiliate / partner page, changelog. Record: sign-up method (SSO, email, card up front?), waitlist
  or invite codes, what is free, trial length and how it ends, plans and prices, the first thing a
  new user is told to do, every place a non-user meets the product (shared outputs, public pages,
  embeds, badges, invites, emails to outsiders).
- **Page history (free):** `python3 $SKILL_DIR/scripts/analyze.py wayback --url TARGET/pricing
  --from <year-2> --every month --csv-out pricing-changes.csv` (and the home page). Each price,
  plan, trial or CTA change is a dated move ("by" the capture date).
- `predictleads.companies.website_evolution` {company_id_or_domain, limit:1000} → new subpages with
  first-seen dates (a new /pricing, /partners, /affiliates, /templates family = a dated move).
- Handles: official social accounts linked from the site, founders' X handles (about page, else
  search). A handle not linked from the site counts only if its bio links back to TARGET.
- Content mode: home and about only, collect handles, go to step 7.

## 2 · Stack, partners, news, team — ~$0.20

- `predictleads.companies.technology_detections` → analytics, ad pixels, A/B testing,
  referral/affiliate (Rewardful, FirstPromoter, Impact, PartnerStack), lifecycle email, chat. Keep
  score ≥ 0.9, not behind_firewall. A pixel = SEEN; what they run on it = INFERRED; first seen is a
  bound, and a single detection is weak.
- `predictleads.companies.connections` → partners, integrations, investors.
- `predictleads.companies.news_events` + `financing_events` → launches, press, funding, reported
  revenue (label "reported"). Each is a dated move; a reported revenue figure can be a chart
  annotation ("$17M ARR, reported").
- `fiber-ai.linkedin.company.profile` {"type":"slug","value":<slug>,"getHistoricalHeadcount":true}
  → headcount by month (a second "people" series; hiring waves are moves).

## 3 · When it grew, against whom — ~$0.17-0.62

- `dataforseo.x.dataforseo-labs-google-historical-rank-overview-live`
  [{"target":"TARGET","location_code":2840,"language_code":"en","date_from":<24 months ago>}] →
  `raw/3-history.json`, then
  `python3 $SKILL_DIR/scripts/analyze.py inflection --from-dataforseo raw/3-history.json --kind attention
  --today <today> --emit-csv traffic.csv -o inflection.json` → MoM growth, changepoints with
  stability, the inflection month, and the "N× in M months" window, which the script returns only
  when the window rule holds (else `window: null` with `window_reason`).
- **Peers.** `dataforseo.x.dataforseo-labs-google-competitors-domain-live` → pick 2-3 organic
  competitors of similar size (quick mode: 1). Within the cap, pull their history the same way
  (`peers/<d>.csv`, ≈$0.15 each) and rerun `inflection --peers peers/*.csv`: excess growth, and a
  market-tailwind flag.
- **Brand demand.** One `dataforseo.x.keywords-data-dataforseo-trends-explore-live` call with the
  target's brand and up to 4 peers' brands → `raw/3-trends.json` →
  `analyze.py trends --trends raw/3-trends.json --keyword <brand> --today <today> -o demand.csv`.
- Channel split: `akta.x.website-traffic` needs the team's own Akta key; else "unavailable".
- Third-party traffic is an estimate: compare shape, timing and order, never absolute levels.

## 4 · Search and AI answers — ~$0.05

- `dataforseo.google.domain.ranked_keywords` [{"target":"TARGET",…,"limit":1000,
  "order_by":["ranked_serp_element.serp_item.etv,desc"]}] → `raw/4-keywords.json`, then rerun
  `families --keywords raw/4-keywords.json` → traffic share per family, brand vs non-brand.
- `dataforseo.x.dataforseo-labs-google-subdomains-live` on TARGET and on the product's user domain
  (e.g. `TARGET-app.com`): user-content subdomains that rank = a UGC loop.
- 3 buyer questions for the category, asked as a customer would. Each to ChatGPT
  (`cloro.ai-search.chatgpt.scrape`), Gemini (`cloro.ai-search.gemini.scrape`) and Google AI Mode
  (`crawl4ai.google.serp.ai_mode`) → `answers.json` [{engine, question, text, citations}] →
  `analyze.py ai --answers answers.json --target <brand> --brands <peers> --domain TARGET` → who is
  named first, which TARGET pages are cited (feeds an `ai_answer` card).

## 5 · Ads — ~$0.03

Rules in `references/channels.md` (days running = last seen − first seen; iterated variants are the
winner signal; absence proves nothing; never compare counts across libraries).
- Meta: `scrapecreators.x.v1-facebook-adlibrary-search-companies` {"query":"TARGET name"} → the
  page whose ig_username or category matches → `…-company-ads` {"pageId":…,"status":"ACTIVE","trim":true}.
- Google: `serpapi.google.ads.transparency` {"engine":"google_ads_transparency_center","text":"TARGET","num":40}.
- LinkedIn: `adyntel.linkedin.search.ads.company` {"company_domain":"TARGET"}.
- TikTok: `anyapi.tiktok.ad_library_search` {"advertiserName":…}.
- `python3 $SKILL_DIR/scripts/analyze.py ads --meta raw/5-meta.json --google raw/5-google.json
  --today <today> -o ads.json` → days running (last seen − first seen), caption families with
  counts, long-runners (30+ days), languages, landing paths, and ad-start moves.
- Read the landing pages of the top families; note creator-made vs brand-made. Save 2-4 creative
  images of the most-seen ads to `img/` for the Ads cards.

## 6 · Who talks about TARGET — ~$0.03

- X: `anyapi.x.search.posts` {"query":"from:FOUNDER","queryType":"Top"} and
  {"query":"TARGET min_faves:300 -from:FOUNDER","queryType":"Top"}.
- YouTube: `anyapi.youtube.search` {"query":"TARGET <category>","sortBy":"popular"}.
- Reddit: `scrapecreators.reddit.search.posts` {"query":"TARGET","sort":"top","timeframe":"year","trim":true}.
- Hacker News: `crawl4ai.hackernews.search.stories` {"query":"TARGET","limit":50} (Show HN = launch).
- Podcasts: `exa.web.search.podcasts` {"query":"<founder> on <TARGET>","includeDomains":["exa.ai/library/podcast"],"numResults":5}.
- Label each item founder/team | creator (#ad, sponsored, #<brand>partner = paid) | user | press.
  Top 10 by engagement, dated. Every contest, quote-post campaign, waitlist or invite drop is a move.

## 7 · TARGET's own content — ~$0.05 + image reads (free)

Per handle from step 1, latest 60 posts or 6 months (endpoint ids in `references/endpoints.md`
step 7 rows; checklists and the `posts.csv` columns in `references/channels.md`) →
`posts/<channel>.csv` → `analyze.py posts --posts posts/<channel>.csv --channel <channel> --today
<today> --emit-monthly posts/<channel>-reach.csv -o posts/<channel>.json` → tiers, outlier
multiples, spread speed, and the monthly reach series. Download top-quarter and 5 bottom images at
once into `img/<channel>/`, open each, read it against the channel checklist. Write per channel:
pattern (counted), house style, 2-3 formulas, what changed after the inflection.

## 8 · Links and loops — ~$0.14

- `dataforseo.web.backlinks.summary` [{"target":"TARGET","include_subdomains":true}].
- `dataforseo.web.anchors.list` [{"target":"TARGET","limit":100,"order_by":["referring_domains,desc"]}].
- `seranking.web.backlinks.list` {target, mode:"domain", limit:500} → inbound URLs with `?via=`,
  `?ref=`, `?aff=` codes.
- `python3 $SKILL_DIR/scripts/analyze.py loops --anchors raw/8-anchors.json --referrers
  raw/8-backlinks.json --subdomains raw/4-subdomains.json --brand <brand>` → badge loops ("Edit with
  X" on thousands of domains, first_seen dates it), affiliate codes with top referrers, user-content
  subdomains, spam anchors dropped (`-o loops.json`, read by `moves-collect` in step 10).
- Read 3 pages carrying the badge with `treg.web.extract`: what it says, where it links. Save a
  screenshot-worthy host list for the badge card.

## 9 · What is next — ~$0.04

`predictleads.companies.job_openings` → openings last seen in the past 30 days; growth, SEO, paid,
lifecycle, community, devrel, partnerships, sales, content, design, video and country roles → the
channel each scales. Pair with the headcount series from step 2.

## 10 · Moves vs growth — no calls

1. Build the moves from what was saved (pass only the files you have):
   `python3 $SKILL_DIR/scripts/analyze.py moves-collect --wayback pricing-changes.csv
   --evolution raw/1-evolution.json --news raw/2-news.json --financing raw/2-financing.json
   --loops loops.json --loops-url <a page carrying the badge> --ads ads.json
   --posts-ranked posts/x.json --extra manual.csv --csv-out moves.csv -o moves-summary.json`.
   `manual.csv` (same columns) holds only moves no script reads, each with a url.
2. `python3 $SKILL_DIR/scripts/analyze.py moves --moves moves.csv --traffic traffic.csv
   --brand-demand demand.csv --peers peers/*.csv --placebo --today <today> --csv-out moves-vs-growth.csv`
   → per-cluster lift (traffic, brand demand, excess over peers), placebo p, per-channel lagged
   Spearman, and `highlight` on the top clusters.
3. With under 12 full months the script credits no lift (`credited: false`) and instead
   highlights the three highest-reach social moves as "Most views". Wording: "came right before
   growth sped up", never "caused".

## 11 · The path — no calls

One row per stage, each cell SEEN or INFERRED with links: Get noticed → Sign up → First win → Pay →
Share (what reaches non-users). Name the 1-2 dominant loops and their order over time.

## 12 · The blueprint — no calls

1. `python3 $SKILL_DIR/scripts/analyze.py costs --ledger calls.jsonl --balance-before <x>
   --balance-after <y> -o costs.json` (`treg balance > balance-after.txt` first).
2. `python3 $SKILL_DIR/scripts/blueprint.py scaffold --company "<Name>" --domain TARGET --period
   <start> <end> --traffic traffic.csv --source-url <source page> --source-date <today>
   --extra-series demand.csv:demand:"Searches for <brand>" --inflection inflection.json
   --moves moves-vs-growth.csv --calls calls.jsonl --costs costs.json --today <today>
   -o blueprint.json` → chart (+ extra series), window, lanes with lift in each move's detail, and
   the bill filled; the period widens to fit every move; channels and plays left as TODO.
3. Fill `blueprint.json` (schema and card types: `references/blueprint.md`):
   - `chart.annotations`: reported revenue, user milestones and raises (SEEN, linked).
   - `channels`: Social media, Ads, SEO / AEO (and Product loop when one exists), each with a
     one-line takeaway and up to 3 cards. Pick the visual that shows the evidence: `post` (a top
     post), `ads` (2-4 creatives + shared caption), `badge` (output-badge loop), `links`
     (affiliate codes), `ai_answer` (who AI names first + cited pages), `image`, `stat`.
     Card title = the play in 4-8 words; finding = one sentence with the number in **bold**.
   - `plays`: exactly ten, ordered by evidence × timing (before the inflection?) × lift × fit for
     the user's stage. Each: title, stage (Get noticed / Sign up / First win / Pay / Share), effort,
     first result + metric, evidence (≥1 SEEN with link), and a paste-ready prompt (2-4 sentences,
     concrete: pages to build, rules to draft, lists to find, posts to make; a prompt that would
     post or send anything asks for approval first). At least one play per channel with a pattern.
   - `skip`: 2-3 plays that look good but the evidence does not support, and why.
   - `path` (step 11): one row per stage with SEEN/INFERRED and a link, plus the 1-2 dominant
     loops with the month each started; `next` (step 9): what they are scaling next, from hires.
   - `method`: endpoints called, blocked sites, images not read, the date of every count,
     interpretations marked INFERRED, no affiliation with TARGET.
4. `python3 $SKILL_DIR/scripts/blueprint.py validate blueprint.json --strict` until OK, then
   `render blueprint.json -o blueprint.html --inline-images` and `md blueprint.json -o playbook.md`.
   Add `--offline` when the page will be viewed in a sandbox with a strict CSP (an app's artifact
   viewer): no web fonts, no remote images; download images next to blueprint.json first.
5. Check the layout: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new
   --dump-dom --virtual-time-budget=5000 "file://$PWD/blueprint.html?audit=all"` (or
   `google-chrome` on Linux) prints the page with a JSON audit of every series: label collisions,
   overflow, broken images, horizontal scroll. `?series=<id>` opens a given series, `?tab=<n>` a
   given channel tab, `?theme=dark` the dark theme. Headless Chrome will not go below 500px wide;
   for a phone check load the page in a 390px iframe. If you can view images, also take a
   `--screenshot` and look. Fix only what is broken (an empty section, an unreadable chip),
   re-render.
6. Deliver the page path (and share it if the host has a publishing tool and the user asked), the
   bill, and the first play to run this week.

## F · Free mode — $0, no treg

For "use only your own tools", or when treg is not set up. Every source is public and keyless;
`scripts/free_sources.py` fetches with a polite user agent, caches under `raw/free/`, and writes
CSVs the other scripts read. Steps 0 and 1 run as usual with free page reads
(`free_sources.py page --url <url> -o raw/1-<page>.txt`, `free_sources.py sitemap --site TARGET
-o urls.txt`, `analyze.py families`, `analyze.py wayback`). Then:
- **Dated launches** (replaces most hand-typed moves): `free_sources.py rss --discover TARGET`, then
  `free_sources.py rss --feed <feed> --since <start> --moves-out blog-moves.csv` (filter with
  `--include`/`--exclude`, e.g. launches, "launch week", pricing, funding).
- **Attention series** (pick the strongest with 6+ months; label it honestly, it is not traffic):
  `free_sources.py wikipedia --article "<Title>" --csv-out wiki.csv` (pageviews a month),
  `free_sources.py hn --query <brand> --csv-out hn.csv --moves-out hn-moves.csv` (Hacker News
  points a month + top stories as moves).
- **People series** (open-source products): `free_sources.py github-stars --repo OWNER/REPO
  --csv-out stars.csv --releases-moves releases.csv --releases-exclude "<newsletter pattern>"`
  (sampled, interpolated; say so). Some GitHub accounts cannot list stargazers (404): add
  `--wayback` to read the count from monthly Wayback captures of the repo page instead (each point
  linked to its capture) plus today's count; releases are still written.
- **Who talks**: `free_sources.py reddit --query <brand> --moves-out reddit-moves.csv` (if Reddit
  blocks, say "blocked"); web search for launches, funding and press (each with its link).
- **Not measured in free mode**, say so on the page: Google traffic and keywords, ad libraries,
  backlinks and anchors, AI answers, tech stack, hiring. Skip their lanes or leave them as "not
  read (free mode)" notes; never fill them from memory.
- `inflection --traffic <series>.csv --kind attention|people` (a running total such as stars is
  segmented on its monthly increments automatically), then `moves-collect --wayback …
  --extra blog-moves.csv --extra hn-moves.csv --extra releases.csv --extra reddit-moves.csv
  --extra manual.csv`, then `moves … --kind <same kind>` and steps 11-12.
- Scaffold for free data: `--pulled-through "<the free sources>" --series-unit points|views|stars
  --source-label "<source>"`, extra series as `CSV:ID:LABEL:SUBLABEL:UNIT`. Skip step 12.1 (no
  bill) and leave out `--calls/--costs`; `cost_usd` is 0. Give every empty lane a note ("not read
  in free mode"); `validate --strict` refuses a silent empty lane.
- Watch for the metric measuring itself: when a move's own reach is a big share of the series
  (an HN launch story inside an HN-points series), `moves` flags it "circular" and does not
  highlight it; say so rather than claiming lift.

## 13 · Content report (content mode) — no calls

Per channel: sample size and dates, pattern, house style, formulas, top 5 posts linked. Across
channels: the shared style and where one channel breaks it. For the user's company: 5 ready titles
or covers per channel and one paste-ready prompt that makes the first post in that style. Deliver
`content.md` + one-file `content.html`: a blueprint whose chart series is the brand's own monthly
reach per channel (views or engagement summed by month from `posts.csv`, partial months marked),
whose lanes are new formats and series by first date, and whose channel cards are the top posts
(`post`) and formula examples; plays are the per-channel prompts.
