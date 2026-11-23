# Endpoints (prices read with `treg catalog get` on 2026-11-18)

Prices drift. Before an endpoint's first call in a run, `treg catalog get <id>` it again, quote the
price, check it fits the cap, and log the call to `calls.jsonl`. Every DataForSEO endpoint takes a
JSON array body holding exactly one task: `[{…}]`.

| Step | Job | Endpoint id | Price | Notes |
|---|---|---|---|---|
| 1 | site map, page reads, search | `treg.web.map`, `treg.web.extract`, `treg.web.search` | ~free | header `X-Treg-Route-Prefer: tinyfish` |
| 1 | new subpages, dated | `predictleads.companies.website_evolution` | $0.04 | `company_id_or_domain`, `limit` up to 1000 at no extra cost; `category` (pricing, careers, security…) + first/last seen |
| 1 | page history | Wayback CDX (no treg) | free | `scripts/analyze.py wayback` (only network call the scripts make) |
| 2 | tech stack | `predictleads.companies.technology_detections` | $0.04 | keep score ≥ 0.9, not behind_firewall; a single detection is low confidence |
| 2 | partners, investors | `predictleads.companies.connections` | $0.04 | |
| 2 | news, funding | `predictleads.companies.news_events`, `predictleads.companies.financing_events` | $0.04 each | revenue in news is "reported" |
| 2 | headcount over time | `fiber-ai.linkedin.company.profile` | $0.04 | `{"type":"slug","value":"<li-slug>","getHistoricalHeadcount":true}` |
| 3 | monthly organic + paid traffic | `dataforseo.x.dataforseo-labs-google-historical-rank-overview-live` | $0.12 + $0.0012/month | 24 months ≈ $0.15; narrow `date_from` to stay under the cap |
| 3 | organic competitors (peers) | `dataforseo.x.dataforseo-labs-google-competitors-domain-live` | $0.0124 | pick 2-3 peers of similar size; never the target's own subdomains |
| 3 | brand demand, target vs peers | `dataforseo.x.keywords-data-dataforseo-trends-explore-live` | $0.0012 | up to 5 keywords in one call: the target's brand + up to 4 peers' brands |
| 3 | channel split | `akta.x.website-traffic` | $0.075 | needs the team's own Akta key, else "unavailable" |
| 4 | ranked keywords | `dataforseo.google.domain.ranked_keywords` | $0.012+ | `limit` 1000, order by etv desc |
| 4 | user-content subdomains | `dataforseo.x.dataforseo-labs-google-subdomains-live` | $0.0124 | also run on the app's user domain (e.g. `*.TARGET-app.com`) |
| 4 | ChatGPT answer | `cloro.ai-search.chatgpt.scrape` | $0.0028 | `{"prompt":…,"country":"US"}` |
| 4 | Gemini answer | `cloro.ai-search.gemini.scrape` | $0.0024 | `{"prompt":…,"country":"US","include":{"markdown":true}}` |
| 4 | Google AI Mode answer | `crawl4ai.google.serp.ai_mode` | $0.00015 | `--query q=… --query deep=0` |
| 5 | Meta ads | `scrapecreators.x.v1-facebook-adlibrary-search-companies` → `scrapecreators.x.v1-facebook-adlibrary-company-ads` | $0.00188 each | `status` ACTIVE, `trim` true |
| 5 | Google ads | `serpapi.google.ads.transparency` | $0.015 | searchable by advertiser name or domain only |
| 5 | LinkedIn ads | `adyntel.linkedin.search.ads.company` | $0.011 | |
| 5 | TikTok ads | `anyapi.tiktok.ad_library_search` | $0.0012 | no region with `advertiserName` |
| 6 | X search | `anyapi.x.search.posts` | $0.00075 | |
| 6 | YouTube search | `anyapi.youtube.search` | $0.0012 | |
| 6 | Reddit search | `scrapecreators.reddit.search.posts` | $0.00188 | page with `after` |
| 6 | Hacker News | `crawl4ai.hackernews.search.stories` | $0.00015 | `{"query":"TARGET","limit":50,"sort":"relevance"}`; Show HN = launch move |
| 6 | podcasts | `exa.web.search.podcasts` | $0.007 for ≤10 results | `includeDomains` must be `["exa.ai/library/podcast"]` |
| 7 | YouTube channel | `scrapecreators.x.v1-youtube-channel-videos` | $0.00188 | page with `continuationToken` |
| 7 | TikTok videos | `crawl4ai.tiktok.user.videos` | $0.0005 | `limit` up to 100 |
| 7 | Instagram posts | `scrapecreators.instagram.user.posts` | $0.00188 | page with `next_max_id` |
| 7 | X timeline / media | `anyapi.x.user.posts.timeline`, `tikhub.x.twitter-web-fetch-user-media` | $0.00075, $0.001 | page with `cursor` |
| 7 | LinkedIn page posts | `harvestapi.linkedin.company.posts` | $0.004 | `scrapePostedLimit` "6months", page by `paginationToken` |
| 8 | backlinks summary | `dataforseo.web.backlinks.summary` | $0.024 | `include_subdomains` true |
| 8 | anchors | `dataforseo.web.anchors.list` | $0.024 | order by referring_domains desc, limit 40-100 |
| 8 | backlink rows (affiliate codes) | `seranking.web.backlinks.list` | $0.000179/row | `limit` is the cost dial: 500 rows ≈ $0.09 |
| 9 | job openings | `predictleads.companies.job_openings` | $0.04 | keep last seen in the past 30 days |
| opt | reviews | `crawl4ai.trustpilot.business.reviews`, `litescrape.app_store.reviews` | ~$0.001 | what users praise or complain about |
