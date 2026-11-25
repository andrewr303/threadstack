# Methods: how numbers become claims

Every number shown comes from a script's output, never typed by hand, and every count carries the
date it was read. These rules decide what the blueprint may say.

## Traffic estimates are ordinal

Third-party traffic estimates (DataForSEO, Similarweb, Semrush) are biased in level but rank sites
well (one peer-reviewed comparison found rank correlations of about .95 against Google Analytics for
visits, with levels about 19% low). So:
- Compare by **shape and order** (when it rose, how fast, against peers), not absolute level.
- Label every series "est." and name its source; never "calibrate" a competitor from one site whose
  real numbers you know.
- Small sites have the largest errors. A series that peaks under 1,000 a month is drawn and called
  small in plain words, not dramatised.

## The inflection (`analyze.py inflection`)

- Changepoints: penalised optimal partitioning (PELT) on log(1 + monthly value), L2 cost, minimum
  segment 3 months, run at 4 penalties. A break kept at 3-4 penalties is "stable"; at 1-2 "weak".
- The inflection is the start of the largest sustained step up.
- The shaded window ("11× in 6 months") is drawn only with 6+ months of data, a window of 3+ whole
  months, no partial end month, and a first month of at least 1,000 (attention series) or 100
  (people series: stars, sign-ups, followers).
- Partial months are drawn dashed and never used in a fit or a multiple.

## Peers are the control group

Growth that the whole category shared is not the target's doing. Pull 2-3 organic competitors of
similar size (`competitors-domain`), their historical traffic when the cap allows, and brand demand
for the target and peers in one Google Trends call. `inflection --peers` and `moves --peers` then
report **excess growth** (target index ÷ peer median index). When peers rose with the target in
the inflection month, say "market tailwind" and credit no single move.

## Moves vs growth (`analyze.py moves`)

- A move's lift = average month-over-month growth in the move's month and the 2 after, minus the
  2 months before (percentage points), on traffic, on brand demand, and on excess growth.
- Moves under 30 days apart form one cluster; credit the cluster, never one move in it.
- Placebo test: the same lift computed at every other eligible month. `placebo_p` = (1 + count of
  placebo lifts ≥ the real one) ÷ (N + 1). Only clusters with lift > 0 and placebo_p ≤ 0.2 are
  highlighted (green chips).
- **Lift is credited only with 12+ months of a full series.** With less, highlight the three
  most-viewed posts as "Most views" and list the moves without crediting them.
- Per channel: Spearman correlation of monthly move counts against growth at lags 0-2, refused
  under 12 months or 5 moves.
- Wording: "came right before growth sped up", "consistent with", never "caused". Moves overlap,
  data is monthly, and estimates are noisy. A counterfactual is only as good as its controls, and a
  peer the move also affected is not a control.

## Dates are bounds

Wayback captures, website-evolution first-seen dates, tech detections and ad first-seen dates are
when a crawler noticed something: the real change happened on or before that date. Write "by
9 Feb 2025", not "on 9 Feb 2025". A single detection (first seen = last seen) is low confidence.

## Loops

Name the 1-2 dominant loops and their order over time, not every loop that could exist. Signatures:
- **Output badge loop**: one anchor ("Edit with X", "Made with X", "Powered by X") on thousands of
  referring domains, many on the product's user-content subdomains; first_seen dates it.
- **Affiliate / referral loop**: `?via=`, `?ref=`, `?aff=`, `?fpr=` codes on inbound links, plus
  Rewardful / FirstPromoter / Impact / PartnerStack in the stack.
- **Programmatic SEO loop**: one URL template with 50+ pages (`/templates/{slug}`,
  `/{a}-vs-{b}`), ranking for many non-brand keywords.
- **UGC / public output loop**: user pages indexed on a shared domain (`*.TARGET.app`) that rank.
- **Integration / marketplace loop**: listings in other products' app stores and partner pages
  (`connections`, `/integrations/` family).
- **Founder / creator loop**: founder milestone posts and creator videos that lead brand demand by
  0-2 months.

## SEEN and INFERRED

- **SEEN**: a call result, page or image shows it, and it is linked (with the date read).
- **INFERRED**: reasoned from what was seen; say from what.
- Nothing seen → "not seen", never a guess. Missing ads, posts or pages prove nothing on their own.
