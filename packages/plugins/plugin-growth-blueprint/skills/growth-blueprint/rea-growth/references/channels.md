# Channel checklists (step 5 ads, step 7 own content)

## Ads (step 5)

- Per network: active count, oldest still running, hook, offer, landing page (read it with
  `treg.web.extract`), language and country of the landing page (e.g. `/pt-br/`).
- **Days running = last seen − first seen**, not today − start. 30+ days is a survival heuristic
  ("probably not losing money"), discounted for always-on brand or retargeting ads, language
  variants, dynamic/catalogue ads and small advertisers who never switch ads off.
- **Iterated variants** (same concept, new hook, crop or creator, launched over several weeks) are
  the strongest public sign of a winner. Count captions: "72 of their 90 top ads run on 2 captions".
- **Absence proves nothing**: libraries are incomplete and ads disappear from them. Say "not seen
  in the X library on DATE", never "they don't run X ads".
- Never compare ad counts across libraries (each counts differently). Google's library is
  searchable only by advertiser name or domain; Meta's default view is active ads only.
- Spend, results and targeting are not public for commercial ads: anything about "what works" in
  ads is INFERRED.

## Own content (step 7)

`posts/<channel>.csv`, one row per post, built from the scraper's saved JSON: `id,date,url` plus
the metric columns the channel has (`views,likes,comments,shares,saves,reactions,score`), and
optionally `title,text,image,kind,length`. The ranking metric per channel: views (YouTube, TikTok,
X), likes + comments (Instagram), reactions (LinkedIn), score (Reddit).

Ranking: `python3 scripts/analyze.py posts --posts posts/<channel>.csv --channel <channel> --today
<today> --emit-monthly posts/<channel>-reach.csv -o posts/<channel>.json` (drops posts under 7 days,
tiers top quarter / bottom half, outlier multiple vs the channel median, spread speed per day,
monthly reach series). Compare only within a channel. Under 20 settled posts: report them, call no
pattern.

Read each top-quarter image and 5 bottom images (downloaded at once; TikTok and Instagram links
expire within hours). An image that does not download is "not read", never described from its
caption.

- **YouTube.** Title: length, number or money, first person ("I built…"), question, brackets, the
  promise. Thumbnail: face and its emotion, words on it (count; ≤ 4 is usual), product or outcome
  shown, before/after split, contrast and main colour, logo. Do title and thumbnail repeat or add to
  each other? Shorts vs long, length.
- **TikTok.** Cover: the frame chosen, the words on it. Hook: first line of the description,
  on-screen text of the opening. Format: talking head, screen recording, slideshow, skit, green
  screen. Sound: trending or original. Length, hashtag count, posting rhythm.
- **Instagram.** Mix of reels, carousels, photos, and which kind wins. Cover or first slide:
  headline size, words, template. Carousels: slide count, what the last slide asks. Caption: the
  line before "more". The grid as a whole: repeated colours, fonts, frames, logo's place.
- **X.** The first line (before "Show more"), length, thread or single, media: none, product
  screenshot, chart or metric card, video, meme. Founder vs brand account: which outperforms; do
  numbers (revenue, users) drive the best posts? Where is the link: in the post or in a reply?
- **LinkedIn.** The two lines before "see more", format (text, image, document carousel, video),
  people vs product in the image, company page vs staff posts promoted (match against step 5's
  LinkedIn ads).
- **Reddit.** Title pattern (question, story, "I made…"), subreddits, self vs link, whether the
  account says who it works for.

Write up per channel:
- **Pattern.** 3-5 traits the top quarter shares and the bottom half lacks, each counted ("8 of 9
  top thumbnails show a face, 2 of 12 bottom ones").
- **House style.** Colours (hex read off the images), fonts or lettering, templates, logo's place,
  recurring formats or series.
- **Formulas.** 2-3 fill-in templates behind the top titles, covers or hooks, one real example each.
- **What changed** before vs after the inflection, where the dates allow.
