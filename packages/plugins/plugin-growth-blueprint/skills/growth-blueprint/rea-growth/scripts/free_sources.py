#!/usr/bin/env python3
"""rea-growth free-mode data layer: public endpoints only, no paid API, no treg calls.

Subcommands: hn, github-stars, wikipedia, reddit, sitemap, rss, page.
Python 3.10+ standard library only. Every request goes to one named public endpoint with the polite
User-Agent "rea-growth/2 (+public research)", at most one request a second, 3 tries with backoff.
Raw responses are cached under --cache DIR (default raw/free/<sub>/); --offline reads the cache only.
No secret is ever sent: GitHub calls go through `gh api` when the gh CLI is installed (it uses its own
login; this script never reads a token) and through plain unauthenticated urllib otherwise.

Series CSVs are month,value,partial[,mentions] and feed `blueprint.py scaffold --traffic/--extra-series`
and `analyze.py inflection --traffic`. Moves CSVs are date,channel,label,platform,url,evidence,detail,reach
and feed `analyze.py moves --moves` and `analyze.py moves-collect --extra`.

Exit codes: 0 ok, 1 error / no data (message on stderr), 2 usage error, 3 blocked by the site (nothing written).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import email.utils
import gzip
import hashlib
import html
import io
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

USER_AGENT = "rea-growth/2 (+public research)"
SERIES_COLUMNS = ["month", "value", "partial"]
MOVES_COLUMNS = ["date", "channel", "label", "platform", "url", "evidence", "detail", "reach"]
MAX_SITEMAPS = 50
MAX_URLS = 50000
MAX_BODY = 60_000_000

_sleep = time.sleep          # patched in tests
_clock = time.monotonic


class FreeError(Exception):
    code = 1


class Blocked(FreeError):
    code = 3


class NotFound(FreeError):
    code = 1


class StarsUnavailable(FreeError):
    """The star series cannot be built (stargazers 404/401, no readable Wayback captures)."""


# ----------------------------------------------------------------------------
# Fetching with cache, pacing and retries
# ----------------------------------------------------------------------------

def cache_path(cache_dir, url, accept=None):
    key = hashlib.sha256(f"{url}\n{accept or ''}".encode("utf-8")).hexdigest()[:24]
    return os.path.join(cache_dir, key + ".bin")


class Fetcher:
    def __init__(self, cache_dir, offline=False, delay=1.0, retries=3, backoff=1.0, use_gh=True):
        self.cache_dir, self.offline = cache_dir, bool(offline)
        self.delay, self.retries, self.backoff = float(delay), retries, backoff
        self.use_gh = use_gh and shutil.which("gh") is not None
        self.network_calls = 0
        self._last = None

    def get(self, url, accept=None, gh=False):
        path = cache_path(self.cache_dir, url, accept)
        if os.path.exists(path):
            with open(path, "rb") as fh:
                return fh.read()
        if self.offline:
            raise FreeError(f"offline: not in cache ({url}); run once without --offline")
        body = self._network(url, accept, gh)
        os.makedirs(self.cache_dir, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(body)
        os.replace(tmp, path)
        return body

    def get_json(self, url, accept=None, gh=False):
        body = self.get(url, accept, gh)
        try:
            return json.loads(body.decode("utf-8-sig"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise FreeError(f"{url}: response is not JSON ({exc})")

    def _pace(self):
        if self._last is not None and self.delay > 0:
            wait = self.delay - (_clock() - self._last)
            if wait > 0:
                _sleep(wait)
        self._last = _clock()

    def _network(self, url, accept, gh):
        last = None
        for attempt in range(self.retries):
            self._pace()
            self.network_calls += 1
            try:
                if gh and self.use_gh and url.startswith("https://api.github.com/"):
                    return self._via_gh(url, accept)
                return self._via_urllib(url, accept)
            except _Retry as exc:
                last = exc
                if attempt + 1 < self.retries:
                    _sleep(self.backoff * (2 ** attempt))
        raise FreeError(f"{url}: failed after {self.retries} tries ({last})")

    def _via_urllib(self, url, accept):
        headers = {"User-Agent": USER_AGENT, "Accept": accept or "*/*"}
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read(MAX_BODY + 1)[:MAX_BODY]
        except urllib.error.HTTPError as exc:
            _raise_status(exc.code, url)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise _Retry(str(getattr(exc, "reason", exc)))

    def _via_gh(self, url, accept):
        endpoint = url[len("https://api.github.com/"):]
        cmd = ["gh", "api"] + (["-H", f"Accept: {accept}"] if accept else []) + [endpoint]
        try:
            res = subprocess.run(cmd, capture_output=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise _Retry(f"gh api failed: {exc}")
        if res.returncode == 0:
            return res.stdout
        text = (res.stderr + res.stdout).decode("utf-8", "replace")
        m = re.search(r"HTTP (\d{3})", text)
        if m:
            _raise_status(int(m.group(1)), url)
        raise _Retry(f"gh api exit {res.returncode}: {text.strip()[:120]}")


class _Retry(Exception):
    pass


def _raise_status(code, url):
    if code == 404:
        raise NotFound(f"not found: {url}")
    if code in (401, 403):
        raise Blocked(f"blocked: HTTP {code} from {urllib.parse.urlsplit(url).netloc}; not retrying or evading")
    if code == 429 or code >= 500:
        raise _Retry(f"HTTP {code}")
    raise FreeError(f"{url}: HTTP {code}")


# ----------------------------------------------------------------------------
# Small helpers
# ----------------------------------------------------------------------------

def parse_ym(text):
    m = re.fullmatch(r"(\d{4})-(\d{2})", text or "")
    if not m or not 1 <= int(m.group(2)) <= 12:
        raise argparse.ArgumentTypeError(f"expected YYYY-MM, got {text!r}")
    return int(m.group(1)), int(m.group(2))


def parse_day(text):
    try:
        return dt.date.fromisoformat(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"expected YYYY-MM-DD, got {text!r}")


def ym_str(ym):
    return f"{ym[0]:04d}-{ym[1]:02d}"


def ym_add(ym, n):
    i = ym[0] * 12 + ym[1] - 1 + n
    return i // 12, i % 12 + 1


def ym_range(a, b):
    out, cur = [], a
    while cur <= b:
        out.append(cur)
        cur = ym_add(cur, 1)
    return out


def month_epoch(ym):
    return int(dt.datetime(ym[0], ym[1], 1, tzinfo=dt.timezone.utc).timestamp())


def resolve_range(args, today, default_months):
    this = (today.year, today.month)
    end = args.to or this
    start = args.frm or ym_add(end, -default_months)
    if start > end:
        raise FreeError(f"--from {ym_str(start)} is after --to {ym_str(end)}")
    return start, end, this


def clip(text, n=32):
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def write_csv(path, columns, rows):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=columns, extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        for row in rows:
            w.writerow({c: ("" if row.get(c) is None else row.get(c)) for c in columns})


def emit(obj, out):
    text = json.dumps(obj, indent=2, ensure_ascii=False) + "\n"
    if out:
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)


def make_fetcher(args, sub):
    cache = args.cache or os.path.join("raw", "free", sub)
    return Fetcher(cache, offline=args.offline, delay=args.delay, use_gh=not getattr(args, "no_gh", False))


def epoch_date(ts):
    return dt.datetime.fromtimestamp(int(ts), dt.timezone.utc).date()


def maybe_gunzip(body):
    """Wayback `id_` captures and some servers hand back the original gzip bytes; unwrap them."""
    if body[:2] != b"\x1f\x8b":
        return body
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(body)) as gz:
            out = gz.read(MAX_BODY + 1)
    except (OSError, EOFError) as exc:
        raise FreeError(f"corrupt gzip body ({exc})")
    return out[:MAX_BODY]


def compile_regex(text):
    try:
        return re.compile(text, re.IGNORECASE)
    except re.error as exc:
        raise argparse.ArgumentTypeError(f"bad regular expression {text!r}: {exc}")


# ----------------------------------------------------------------------------
# 1. hn
# ----------------------------------------------------------------------------

HN_API = "https://hn.algolia.com/api/v1/search_by_date"
HN_MAX_PAGES = 5


def hn_url(query, start_ts, end_ts, page=0):
    params = {"query": query, "tags": "story",
              "numericFilters": f"created_at_i>={start_ts},created_at_i<{end_ts}", "hitsPerPage": 1000}
    if page:
        params["page"] = page
    return HN_API + "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)


def hn_month_hits(fetcher, query, ym):
    a, b = month_epoch(ym), month_epoch(ym_add(ym, 1))
    hits, page = [], 0
    while True:
        data = fetcher.get_json(hn_url(query, a, b, page))
        got = data.get("hits") if isinstance(data, dict) else None
        if not isinstance(got, list):
            raise FreeError("hn: unexpected response shape (no hits list)")
        hits.extend(h for h in got if isinstance(h, dict))
        page += 1
        if page >= int(data.get("nbPages") or 0) or page >= HN_MAX_PAGES:
            return hits


def hn_matches(hit, needle):
    return needle in (hit.get("title") or "").lower() or needle in (hit.get("url") or "").lower()


def hn_story(hit):
    oid = str(hit.get("objectID") or hit.get("story_id") or "")
    ts = int(hit.get("created_at_i") or 0)
    return {"title": hit.get("title") or "", "url": hit.get("url") or "",
            "hn_url": f"https://news.ycombinator.com/item?id={oid}", "points": int(hit.get("points") or 0),
            "comments": int(hit.get("num_comments") or 0), "date": epoch_date(ts).isoformat(), "_ts": ts}


def hn_label(story):
    kind = "Show HN" if story["title"].lower().startswith("show hn") else "HN"
    return clip(f"{kind}: {story['points']} points")


def cmd_hn(args):
    today = args.today or dt.date.today()
    start, end, this = resolve_range(args, today, 36)
    fetcher = make_fetcher(args, "hn")
    needle = args.query.lower()
    seen, stories, raw_n = set(), [], 0
    for ym in ym_range(start, end):
        for hit in hn_month_hits(fetcher, args.query, ym):
            raw_n += 1
            oid = hit.get("objectID")
            if oid in seen:
                continue
            seen.add(oid)
            if hn_matches(hit, needle):
                stories.append(hn_story(hit))
    series = {ym: [0, 0] for ym in ym_range(start, end)}
    for s in stories:
        d = epoch_date(s["_ts"])
        row = series.get((d.year, d.month))
        if row:
            row[0] += s["points"]
            row[1] += 1
    rows = [{"month": ym_str(ym), "value": v[0], "partial": 1 if ym >= this else 0, "mentions": v[1]}
            for ym, v in sorted(series.items())]
    top = sorted(stories, key=lambda s: (-s["points"], -s["comments"], s["_ts"]))[: args.top]
    if args.csv_out:
        write_csv(args.csv_out, SERIES_COLUMNS + ["mentions"], rows)
    if args.moves_out:
        write_csv(args.moves_out, MOVES_COLUMNS, [
            {"date": s["date"], "channel": "social", "label": hn_label(s), "platform": "hn", "url": s["hn_url"],
             "evidence": "SEEN", "detail": f"{s['title']} ({s['points']} points, {s['comments']} comments; "
                                           f"read {today.isoformat()})", "reach": s["points"]} for s in top])
    public = [{k: v for k, v in s.items() if k != "_ts"} for s in top]
    emit({"source": "hn.algolia.com", "query": args.query, "from": ym_str(start), "to": ym_str(end),
          "as_of": today.isoformat(), "raw_hits": raw_n, "matched": len(stories),
          "filtered_out": len(seen) - len(stories),
          "duplicates": raw_n - len(seen), "series_csv": args.csv_out, "moves_csv": args.moves_out,
          "top_stories": public,
          "note": "value = sum of points of matching stories created that month; mentions = story count; "
                  "a story counts only when its title or url contains the query"}, args.out)


# ----------------------------------------------------------------------------
# 2. github-stars
# ----------------------------------------------------------------------------

GH_API = "https://api.github.com/"
STAR_ACCEPT = "application/vnd.github.star+json"
GH_PAGE_CAP = 400


def gh_repo_url(repo):
    return f"{GH_API}repos/{repo}"


def gh_stars_url(repo, page):
    return f"{GH_API}repos/{repo}/stargazers?per_page=100&page={page}"


def gh_releases_url(repo, page):
    return f"{GH_API}repos/{repo}/releases?per_page=100&page={page}"


def pick_pages(total_pages, max_pages):
    """Evenly spread 1-based page numbers, always including the first and last."""
    if total_pages <= max_pages:
        return list(range(1, total_pages + 1))
    if max_pages < 2:
        return [1]
    out = {1 + round(i * (total_pages - 1) / (max_pages - 1)) for i in range(max_pages)}
    return sorted(out)


def parse_ts(text):
    return dt.datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()


def interpolate_stars(samples, count, today, now_ts=None):
    """samples: [(unix_ts, cumulative_stars)]. Returns [(ym, value, partial)] month-end series.

    Monotone by construction: samples are sorted, made non-decreasing, and linearly interpolated;
    the current month is the live stargazers_count.
    """
    if not samples:
        raise FreeError("no star timestamps sampled")
    pts = {}
    for ts, cum in sorted(samples):
        pts[ts] = max(cum, pts.get(ts, 0))
    ordered, run = [], 0
    for ts in sorted(pts):
        run = max(run, pts[ts])
        ordered.append((ts, min(run, count)))
    this = (today.year, today.month)
    end_of_today = now_ts if now_ts is not None else month_epoch(this) + (today.day) * 86400 - 1
    if ordered[-1][0] < end_of_today:
        ordered.append((end_of_today, count))
    first = dt.datetime.fromtimestamp(ordered[0][0], dt.timezone.utc)
    months = ym_range((first.year, first.month), this)

    def at(ts):
        if ts <= ordered[0][0]:
            return ordered[0][1]
        for (t0, c0), (t1, c1) in zip(ordered, ordered[1:]):
            if t0 <= ts <= t1:
                return c0 if t1 == t0 else c0 + (c1 - c0) * (ts - t0) / (t1 - t0)
        return ordered[-1][1]

    out, prev = [], 0
    for ym in months:
        if ym >= this:
            out.append((ym, count, 1))
            continue
        v = max(prev, int(round(at(month_epoch(ym_add(ym, 1)) - 1))))
        out.append((ym, min(v, count), 0))
        prev = v
    return out


def stars_from_stargazers(fetcher, args, count, created, today):
    """Sample stargazer pages and interpolate. Raises StarsUnavailable when GitHub will not list them."""
    notes = []
    total_pages = math.ceil(count / 100)
    sampleable = min(total_pages, GH_PAGE_CAP)
    if sampleable < total_pages:
        notes.append(f"GitHub serves only the first {GH_PAGE_CAP} stargazer pages; later stars are "
                     "interpolated to the live total")
    pages = pick_pages(sampleable, max(2, args.max_pages))
    samples, sampled = [], []
    for p in pages:
        try:
            items = fetcher.get_json(gh_stars_url(args.repo, p), accept=STAR_ACCEPT, gh=True)
        except NotFound:
            raise StarsUnavailable(f"GitHub returned 404 for the stargazers endpoint (page {p}); it needs an "
                                   "authenticated token that can read stargazers, and unauthenticated calls get 401")
        except Blocked:
            raise StarsUnavailable("GitHub refused the stargazers request (401/403); authenticate gh or wait for "
                                   "the rate limit to reset")
        if not isinstance(items, list) or not items:
            continue
        first = items[0]
        if not isinstance(first, dict) or "starred_at" not in first:
            raise FreeError("stargazers response has no starred_at (Accept header ignored?)")
        idx = (p - 1) * 100 + 1
        samples.append((parse_ts(first["starred_at"]), idx))
        sampled.append({"page": p, "index": idx, "starred_at": first["starred_at"]})
    series = interpolate_stars(samples, count, today)
    method = f"sampled {len(sampled)} of {total_pages} pages; interpolated"
    if notes:
        method += "; " + "; ".join(notes)
    if args.csv_out:
        write_csv(args.csv_out, SERIES_COLUMNS, [{"month": ym_str(ym), "value": v, "partial": p}
                                                  for ym, v, p in series])
    return {"total_pages": total_pages, "sampled_pages": sampled, "series_csv": args.csv_out,
            "method": method, "series_kind": "people"}


# --- Wayback fallback: star counts read from archived copies of github.com/OWNER/REPO -------------------

WAYBACK_CDX = "https://web.archive.org/cdx/search/cdx"


def wayback_cdx_url(target, year_from, year_to):
    params = [("url", target), ("output", "json"), ("fl", "timestamp,original"), ("filter", "statuscode:200"),
              ("collapse", "timestamp:6"), ("from", str(year_from)), ("to", str(year_to))]
    return WAYBACK_CDX + "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)


def wayback_raw_url(ts, original):
    return f"https://web.archive.org/web/{ts}id_/{original}"


def wayback_view_url(ts, original):
    return f"https://web.archive.org/web/{ts}/{original}"


def parse_cdx(body):
    """CDX JSON -> [(timestamp, original)] (the header row and malformed rows are dropped)."""
    text = maybe_gunzip(body).decode("utf-8-sig", "replace").strip()
    if not text:
        return []
    try:
        rows = json.loads(text)
    except ValueError:
        raise FreeError("wayback CDX: response is not JSON")
    if not isinstance(rows, list):
        raise FreeError("wayback CDX: unexpected response shape")
    out = []
    for row in rows:
        if (isinstance(row, list) and len(row) >= 2 and re.fullmatch(r"\d{14}", str(row[0]))
                and str(row[1]).startswith(("http://", "https://"))):
            out.append((str(row[0]), str(row[1])))
    return sorted(out)


def _count_value(num, suffix=None):
    """'1,234' -> (1234, False); '12.3k' -> (12300, True: abbreviated, so approximate)."""
    num = num.replace(",", "").replace(" ", "").strip()
    try:
        if suffix:
            return int(round(float(num) * {"k": 1_000, "m": 1_000_000}[suffix.lower()])), True
        return (int(num), False) if num.isdigit() else (None, False)
    except ValueError:
        return None, False


def parse_star_count(page, repo):
    """Read the stargazers counter from a GitHub repo page (any era of the layout).

    Returns {"value", "how", "approx"} or None. Exact sources come first (counter title/aria-label,
    embedded JSON), then the stargazers link text, then any "N stars" text; an abbreviated count ("12.3k")
    is accepted only when nothing exact exists and is flagged approx.
    """
    num = r"(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?"
    found = []                                         # (priority, how, value, approx)
    for m in re.finditer(r"<[^>]*repo-stars-counter-(?:star|unstar)[^>]*>([^<]*)", page):
        tag, inner = m.group(0), m.group(1)
        t = re.search(r'\btitle="(\d[\d,]*)"', tag)
        a = re.search(r'aria-label="(\d[\d,]*)\s+users?\s+starred', tag)
        if t or a:
            found.append((0, "counter_attr", _count_value((t or a).group(1))[0], False))
        else:
            n = re.match(r"\s*" + num + r"\s*$", inner)
            if n:
                v, approx = _count_value(n.group(1), n.group(2))
                found.append((4, "counter_text", v, approx))
    m = re.search(r'aria-label="(\d[\d,]*)\s+users?\s+starred this repository"', page)
    if m:
        found.append((1, "aria_label", _count_value(m.group(1))[0], False))
    for key in ("stargazerCount", "stargazers_count", "stargazersCount"):
        m = re.search(r'"%s"\s*:\s*(\d+)' % key, page)
        if m:
            found.append((2, "json", int(m.group(1)), False))
            break
    for m in re.finditer(r'href="[^"]*/%s/stargazers/?"[^>]*>' % re.escape(repo), page, re.IGNORECASE):
        snippet = re.sub(r"<[^>]+>", " ", page[m.end(): m.end() + 400].split("</a>")[0])
        n = re.match(r"\s*" + num + r"(?![\w.])", snippet)
        if n:
            v, approx = _count_value(n.group(1), n.group(2))
            found.append((3 if not approx else 5, "stargazers_link", v, approx))
            break
    m = re.search(r"(?<![\w.,])" + num + r"\s*(?:stars?\b|users? starred)", page)
    if m:
        v, approx = _count_value(m.group(1), m.group(2))
        found.append((6 if not approx else 7, "text", v, approx))
    found = [f for f in found if f[2] is not None]
    if not found:
        return None
    _, how, value, approx = min(found, key=lambda f: f[0])
    return {"value": value, "how": how, "approx": approx}


def stars_from_wayback(fetcher, args, count, created, today):
    """People series from archived repo pages: one capture a month, plus today's live count.

    Months without a readable capture are left out and listed; nothing is interpolated.
    """
    this = (today.year, today.month)
    target = f"github.com/{args.repo}"
    year_from = int(created[:4]) if created and created[:4].isdigit() else 2008
    try:
        captures = parse_cdx(fetcher.get(wayback_cdx_url(target, year_from, today.year)))
    except FreeError as exc:
        raise StarsUnavailable(f"Wayback CDX lookup failed: {exc}")
    by_month = {}
    for ts, original in captures:
        ym = (int(ts[:4]), int(ts[4:6]))
        if ym < this:                                  # the current month is the live count
            by_month.setdefault(ym, (ts, original))
    if not by_month:
        raise StarsUnavailable(f"no Wayback captures with status 200 for {target}")
    sys.stderr.write(f"reading {len(by_month)} Wayback captures of {target} (about {len(by_month)} s at "
                     "one request a second)\n")
    points, reasons = {}, {}
    for ym in sorted(by_month):
        ts, original = by_month[ym]
        view = wayback_view_url(ts, original)
        try:
            body = maybe_gunzip(fetcher.get(wayback_raw_url(ts, original)))
        except FreeError as exc:
            reasons[ym] = f"capture {ts} not readable: {exc}"
            continue
        reading = parse_star_count(body.decode("utf-8", "replace"), args.repo)
        if reading is None:
            reasons[ym] = f"capture {ts} has no star counter"
            continue
        point = {"month": ym_str(ym), "value": reading["value"], "partial": 0,
                 "capture_date": f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}", "capture_url": view, "evidence": "SEEN",
                 "read_from": reading["how"]}
        if reading["approx"]:
            point["approximate"] = True
        points[ym] = point
    if not points:
        raise StarsUnavailable(f"none of the {len(by_month)} Wayback captures of {target} had a readable "
                               "star counter")
    points[this] = {"month": ym_str(this), "value": count, "partial": 1, "capture_date": today.isoformat(),
                    "capture_url": gh_repo_url(args.repo), "evidence": "SEEN", "read_from": "stargazers_count"}
    start = min(min(points), min(by_month))
    missing = [{"month": ym_str(ym), "reason": reasons.get(ym, "no Wayback capture with status 200")}
               for ym in ym_range(start, ym_add(this, -1)) if ym not in points]
    ordered = [points[ym] for ym in sorted(points)]
    if args.csv_out:
        write_csv(args.csv_out, SERIES_COLUMNS, ordered)
    warnings = []
    if missing:
        warnings.append(f"{len(missing)} month(s) have no readable capture and are left out, not interpolated: "
                        + ", ".join(m["month"] for m in missing))
    if any(p.get("approximate") for p in ordered):
        warnings.append("some counts were read from abbreviated text (e.g. 12.3k) and are approximate")
    method = (f"Wayback Machine captures of https://github.com/{args.repo}: the first status-200 capture in each "
              "month, raw (id_) page, star count read from the page; the current month is today's "
              "stargazers_count from the GitHub API; months without a readable capture are left out and "
              "listed in missing_months, never interpolated")
    return {"series_csv": args.csv_out, "method": method, "series_kind": "people", "series_source": "wayback",
            "captures_found": len(by_month), "captures_read": len(points) - 1, "series": ordered,
            "missing_months": missing, "warnings": warnings}


def release_selected(rel, include, exclude):
    texts = [str(rel.get("name") or ""), str(rel.get("tag_name") or "")]
    if include and not any(include.search(t) for t in texts):
        return False
    if exclude and any(exclude.search(t) for t in texts):
        return False
    return True


def cmd_github_stars(args):
    today = args.today or dt.date.today()
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", args.repo):
        raise FreeError(f"--repo must be OWNER/REPO, got {args.repo!r}")
    fetcher = make_fetcher(args, "github-stars")
    repo = fetcher.get_json(gh_repo_url(args.repo), gh=True)
    count = int(repo.get("stargazers_count") or 0)
    created = repo.get("created_at")
    result = {"source": "api.github.com", "repo": args.repo, "created_at": created, "stars_now": count,
              "as_of": today.isoformat()}
    warnings = []
    if args.csv_out or args.wayback or not args.releases_moves:
        if count <= 0:
            raise FreeError(f"{args.repo} has no stars")
        build = stars_from_wayback if args.wayback else stars_from_stargazers
        try:
            built = build(fetcher, args, count, created, today)
        except StarsUnavailable as exc:
            if not args.releases_moves:
                raise
            warnings.append(f"star series was not built: {exc}")
            result.update({"series_built": False, "series_csv": None})
        else:
            warnings.extend(built.pop("warnings", []))
            result.update(built)
            result["series_built"] = True
    if args.releases_moves:
        rels, page = [], 1
        while page <= 5:
            chunk = fetcher.get_json(gh_releases_url(args.repo, page), gh=True)
            if not isinstance(chunk, list):
                raise FreeError("releases response is not a list")
            rels.extend(r for r in chunk if isinstance(r, dict))
            if len(chunk) < 100:
                break
            page += 1
        rows, filtered = [], 0
        for r in rels:
            if r.get("draft") or not r.get("published_at") or not r.get("html_url"):
                continue
            if not release_selected(r, args.releases_include, args.releases_exclude):
                filtered += 1
                continue
            label = r.get("name") or r.get("tag_name") or "Release"
            rows.append({"date": r["published_at"][:10], "channel": "company", "label": clip(label),
                         "platform": "github", "url": r["html_url"], "evidence": "SEEN",
                         "detail": f"GitHub release {r.get('tag_name', '')} published {r['published_at'][:10]}"
                                   f"{' (pre-release)' if r.get('prerelease') else ''}", "reach": ""})
        write_csv(args.releases_moves, MOVES_COLUMNS, rows)
        result["releases_csv"] = args.releases_moves
        result["n_releases"] = len(rows)
        result["releases_filtered_out"] = filtered
    result["warnings"] = warnings
    for w in warnings:
        sys.stderr.write(f"warning: {w}\n")
    emit(result, args.out)


# ----------------------------------------------------------------------------
# 3. wikipedia
# ----------------------------------------------------------------------------

def wiki_url(lang, title, start, end):
    t = urllib.parse.quote(title.strip().replace(" ", "_"), safe="")
    return ("https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/"
            f"{lang}.wikipedia/all-access/user/{t}/monthly/{start[0]:04d}{start[1]:02d}01/{end[0]:04d}{end[1]:02d}01")


WIKI_MIN_MONTHS = 6
WIKI_MIN_MEDIAN = 100
WIKI_TOO_SMALL = "article too small or too new to stand for the company's attention"


def wiki_warnings(rows, months_with_data):
    """Warn when the series is too short or too quiet to stand for attention. Median over complete months."""
    out = []
    if months_with_data < WIKI_MIN_MONTHS:
        out.append(f"{WIKI_TOO_SMALL}: only {months_with_data} month(s) have data (need {WIKI_MIN_MONTHS})")
    values = [r["value"] for r in rows if not r["partial"]] or [r["value"] for r in rows]
    med = statistics.median(values)
    if med < WIKI_MIN_MEDIAN:
        out.append(f"{WIKI_TOO_SMALL}: median monthly views are {med:g} (under {WIKI_MIN_MEDIAN})")
    return out


def cmd_wikipedia(args):
    today = args.today or dt.date.today()
    start, end, this = resolve_range(args, today, 24)
    fetcher = make_fetcher(args, "wikipedia")
    try:
        data = fetcher.get_json(wiki_url(args.lang, args.article, start, end))
    except NotFound:
        raise FreeError(f"no such article: {args.article!r} on {args.lang}.wikipedia "
                        f"(or no pageview data for {ym_str(start)}..{ym_str(end)})")
    items = data.get("items") if isinstance(data, dict) else None
    if not items:
        raise FreeError(f"no such article: {args.article!r} (empty pageview response)")
    by_month = {}
    for it in items:
        ts = str(it.get("timestamp", ""))
        if len(ts) >= 6 and ts[:6].isdigit():
            by_month[(int(ts[:4]), int(ts[4:6]))] = int(it.get("views") or 0)
    lo, hi = min(by_month), max(by_month)
    rows = [{"month": ym_str(ym), "value": by_month.get(ym, 0), "partial": 1 if ym >= this else 0}
            for ym in ym_range(lo, hi)]
    if args.csv_out:
        write_csv(args.csv_out, SERIES_COLUMNS, rows)
    warnings = wiki_warnings(rows, len(by_month))
    for w in warnings:
        sys.stderr.write(f"warning: {w}\n")
    complete = [r["value"] for r in rows if not r["partial"]] or [r["value"] for r in rows]
    emit({"source": "wikimedia.org", "article": args.article, "lang": args.lang, "from": rows[0]["month"],
          "to": rows[-1]["month"], "as_of": today.isoformat(), "n_months": len(rows), "series_csv": args.csv_out,
          "months_with_data": len(by_month), "median_monthly_views": statistics.median(complete),
          "warnings": warnings,
          "note": "monthly pageviews, all-access, user agents only"}, args.out)


# ----------------------------------------------------------------------------
# 4. reddit
# ----------------------------------------------------------------------------

def reddit_url(query):
    return "https://www.reddit.com/search.json?" + urllib.parse.urlencode(
        {"q": query, "sort": "top", "t": "year", "limit": 100}, quote_via=urllib.parse.quote)


def cmd_reddit(args):
    today = args.today or dt.date.today()
    fetcher = make_fetcher(args, "reddit")
    try:
        data = fetcher.get_json(reddit_url(args.query), accept="application/json")
    except Blocked as exc:
        raise Blocked("blocked: reddit refused the public JSON request (HTTP 403/401). Nothing written; "
                      "not retrying or evading. Use another source for Reddit evidence.")
    children = ((data.get("data") or {}).get("children")) if isinstance(data, dict) else None
    if not isinstance(children, list):
        raise FreeError("reddit: unexpected response shape (no data.children)")
    posts = []
    for ch in children:
        d = ch.get("data") if isinstance(ch, dict) else None
        if not isinstance(d, dict) or not d.get("permalink"):
            continue
        posts.append({"title": d.get("title") or "", "subreddit": d.get("subreddit") or "",
                      "url": "https://www.reddit.com" + d["permalink"], "link": d.get("url") or "",
                      "score": int(d.get("score") or 0), "comments": int(d.get("num_comments") or 0),
                      "date": epoch_date(d.get("created_utc") or 0).isoformat()})
    posts.sort(key=lambda p: (-p["score"], -p["comments"]))
    top = posts[: args.top]
    if args.moves_out:
        write_csv(args.moves_out, MOVES_COLUMNS, [
            {"date": p["date"], "channel": "social", "label": clip(f"r/{p['subreddit']}: {p['score']} upvotes"),
             "platform": "reddit", "url": p["url"], "evidence": "SEEN",
             "detail": f"{p['title']} ({p['score']} upvotes, {p['comments']} comments; read {today.isoformat()})",
             "reach": p["score"]} for p in top])
    emit({"source": "reddit.com/search.json", "query": args.query, "as_of": today.isoformat(),
          "n_posts": len(posts), "moves_csv": args.moves_out, "top_posts": top}, args.out)


# ----------------------------------------------------------------------------
# 5. sitemap
# ----------------------------------------------------------------------------

def normalize_domain(text):
    text = text.strip().lower()
    if "//" in text:
        text = urllib.parse.urlsplit(text).netloc
    return text.split("/")[0].split("@")[-1].rstrip(".")


def _bare(host):
    return host[4:] if host.startswith("www.") else host


def same_site(url, domain):
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return False
    host, base = _bare(parts.hostname.lower()), _bare(domain.split(":")[0])
    return host == base or host.endswith("." + base)


def robots_sitemaps(text):
    return [m.group(1) for m in re.finditer(r"(?im)^\s*sitemap\s*:\s*(\S+)", text)]


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def parse_sitemap(body):
    """-> (kind, [loc]) where kind is 'index' or 'urlset'. Page <loc> only (image:loc etc. ignored)."""
    if body[:2] == b"\x1f\x8b":
        with gzip.GzipFile(fileobj=io.BytesIO(body)) as gz:
            body = gz.read(MAX_BODY)
    head = body[:4096].lower()
    if b"<!doctype" in head or b"<!entity" in head:
        raise FreeError("sitemap contains a DOCTYPE/ENTITY declaration; refusing to parse")
    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        raise FreeError(f"invalid sitemap XML ({exc})")
    kind = "index" if _local(root.tag) == "sitemapindex" else "urlset"
    want = "sitemap" if kind == "index" else "url"
    locs = []
    for entry in root:
        if _local(entry.tag) == want:
            for c in entry:
                if _local(c.tag) == "loc" and (c.text or "").strip():
                    locs.append(c.text.strip())
    return kind, locs


def collect_sitemap_urls(fetcher, domain, warnings):
    base = f"https://{domain}"
    queue = []
    try:
        robots = fetcher.get(f"{base}/robots.txt").decode("utf-8", "replace")
        queue = [u for u in robots_sitemaps(robots) if same_site(u, domain)]
    except NotFound:
        pass
    if not queue:
        queue = [f"{base}/sitemap.xml"]
    urls, seen_urls, seen_maps, fetched = [], set(), set(), 0
    while queue:
        sm = queue.pop(0)
        if sm in seen_maps:
            continue
        seen_maps.add(sm)
        if fetched >= MAX_SITEMAPS:
            warnings.append(f"stopped after {MAX_SITEMAPS} sitemaps; {len(queue) + 1} not fetched")
            break
        fetched += 1
        try:
            kind, locs = parse_sitemap(fetcher.get(sm))
        except NotFound:
            warnings.append(f"not found: {sm}")
            continue
        except FreeError as exc:
            if fetched == 1 and not urls and not queue:
                raise
            warnings.append(f"{sm}: {exc}")
            continue
        if kind == "index":
            for loc in locs:
                if same_site(loc, domain):
                    queue.append(loc)
                else:
                    warnings.append(f"skipped off-site child sitemap: {loc}")
        else:
            for loc in locs:
                if loc not in seen_urls:
                    seen_urls.add(loc)
                    urls.append(loc)
                    if len(urls) >= MAX_URLS:
                        warnings.append(f"stopped at {MAX_URLS} URLs")
                        return urls, fetched
    return urls, fetched


def cmd_sitemap(args):
    domain = normalize_domain(args.site)
    if not re.fullmatch(r"[a-z0-9.-]+(:\d+)?", domain) or "." not in domain:
        raise FreeError(f"--site must be a domain like example.com, got {args.site!r}")
    fetcher = make_fetcher(args, "sitemap")
    warnings = []
    urls, n_maps = collect_sitemap_urls(fetcher, domain, warnings)
    if not urls:
        raise FreeError(f"no page URLs found for {domain}" + (f" ({'; '.join(warnings)})" if warnings else ""))
    text = "\n".join(urls) + "\n"
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)
    sys.stderr.write(json.dumps({"site": domain, "urls": len(urls), "sitemaps_read": n_maps,
                                 "warnings": warnings}) + "\n")


# ----------------------------------------------------------------------------
# 6. rss
# ----------------------------------------------------------------------------

FEED_PATHS = ["/rss.xml", "/feed", "/blog/rss.xml", "/atom.xml", "/feed.xml", "/blog/feed.xml", "/index.xml"]


def feed_date(text):
    text = (text or "").strip()
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", text)
    try:
        if m:
            return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        when = email.utils.parsedate_to_datetime(text)
        if when.tzinfo is not None:
            when = when.astimezone(dt.timezone.utc)
        return when.date()
    except (TypeError, ValueError, IndexError, OverflowError):
        return None


def _child_text(el, name):
    for c in el:
        if _local(c.tag) == name:
            return " ".join("".join(c.itertext()).split())
    return ""


def _item_link(el, base):
    best = None
    for c in el:
        if _local(c.tag) != "link":
            continue
        href = (c.text or "").strip() or (c.get("href") or "").strip()
        if not href:
            continue
        if c.get("rel") in (None, "", "alternate"):
            best = href
            break
        best = best or href
    if not best:
        guid = _child_text(el, "guid") or _child_text(el, "id")
        best = guid if guid.startswith(("http://", "https://")) else None
    return urllib.parse.urljoin(base, best) if best else None


def parse_feed(body, base_url=""):
    """RSS 2.0, Atom or RSS 1.0 -> {"format", "title", "items": [{"title", "url", "date"}]}."""
    body = maybe_gunzip(body)
    head = body[:4096].lower()
    if b"<!doctype html" in head or b"<html" in head:
        raise FreeError("not an RSS/Atom feed (got an HTML page)")
    if b"<!doctype" in head or b"<!entity" in head:
        raise FreeError("feed contains a DOCTYPE/ENTITY declaration; refusing to parse")
    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        raise FreeError(f"not an RSS/Atom feed (invalid XML: {exc})")
    kind = _local(root.tag)
    fmt = {"rss": "rss", "feed": "atom", "RDF": "rdf"}.get(kind)
    if fmt is None:
        raise FreeError(f"not an RSS/Atom feed (root element <{kind}>)")
    want = "entry" if fmt == "atom" else "item"
    items = []
    for el in root.iter():
        if _local(el.tag) != want:
            continue
        dates = {}
        for c in el:
            dates.setdefault(_local(c.tag).lower(), "".join(c.itertext()))
        raw = next((dates[k] for k in ("pubdate", "published", "date", "updated") if dates.get(k, "").strip()), "")
        items.append({"title": html.unescape(_child_text(el, "title")), "url": _item_link(el, base_url),
                      "date": feed_date(raw)})
    channel = next((c for c in root if _local(c.tag) == "channel"), root)
    return {"format": fmt, "title": html.unescape(_child_text(channel, "title")), "items": items}


class _FeedLinks(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.found = []

    def handle_starttag(self, tag, attrs):
        if tag != "link":
            return
        a = {k.lower(): (v or "") for k, v in attrs}
        typ = a.get("type", "").lower()
        if "alternate" in a.get("rel", "").lower().split() and a.get("href") and \
                any(k in typ for k in ("rss", "atom", "rdf")):
            self.found.append((a["href"].strip(), a.get("title", "").strip()))


def discover_feeds(fetcher, domain, warnings):
    home = f"https://{domain}/"
    cands = []
    try:
        finder = _FeedLinks()
        finder.feed(decode_html(maybe_gunzip(fetcher.get(home))))
        cands += [(urllib.parse.urljoin(home, href), "link", title) for href, title in finder.found]
    except FreeError as exc:
        warnings.append(f"home page not read: {exc}")
    cands += [(f"https://{domain}{path}", "path", "") for path in FEED_PATHS]
    feeds, seen = [], set()
    for url, source, title in cands:
        if url in seen:
            continue
        seen.add(url)
        try:
            parsed = parse_feed(fetcher.get(url), url)
        except FreeError as exc:
            if source == "link":                        # the page advertises it, so say it did not read
                feeds.append({"url": url, "source": source, "title": title, "verified": False, "error": str(exc)})
            continue
        dated = [i["date"] for i in parsed["items"] if i["date"]]
        feeds.append({"url": url, "source": source, "title": parsed["title"] or title, "verified": True,
                      "format": parsed["format"], "n_items": len(parsed["items"]),
                      "latest": max(dated).isoformat() if dated else None})
    return feeds


def cmd_rss(args):
    today = args.today or dt.date.today()
    fetcher = make_fetcher(args, "rss")
    if args.discover:
        domain = normalize_domain(args.discover)
        if not re.fullmatch(r"[a-z0-9.-]+(:\d+)?", domain) or "." not in domain:
            raise FreeError(f"--discover needs a domain like example.com, got {args.discover!r}")
        warnings = []
        feeds = discover_feeds(fetcher, domain, warnings)
        if not feeds:
            raise FreeError(f"no RSS/Atom feed found for {domain}" + (f" ({'; '.join(warnings)})" if warnings else ""))
        emit({"site": domain, "as_of": today.isoformat(), "feeds": feeds, "warnings": warnings,
              "note": "read the best one with: rss --feed <url> --since YYYY-MM --moves-out moves.csv"}, args.out)
        return
    if not args.feed.startswith(("http://", "https://")):
        raise FreeError(f"--feed must be an http(s) URL, got {args.feed!r}")
    parsed = parse_feed(fetcher.get(args.feed), args.feed)
    if not parsed["items"]:
        raise FreeError(f"feed has no items: {args.feed}")
    since = dt.date(args.since[0], args.since[1], 1) if args.since else None
    chosen, seen_urls = [], set()
    n_filtered = n_old = n_skipped = 0
    for it in parsed["items"]:
        if not it["title"] or not it["url"] or not it["date"]:
            n_skipped += 1                              # a moves row needs a title, a link and a date
            continue
        if (args.include and not args.include.search(it["title"])) or \
                (args.exclude and args.exclude.search(it["title"])):
            n_filtered += 1
        elif since and it["date"] < since:
            n_old += 1
        elif it["url"] not in seen_urls:
            seen_urls.add(it["url"])
            chosen.append(it)
    chosen.sort(key=lambda i: (i["date"], i["url"]))
    rows = [{"date": i["date"].isoformat(), "channel": args.channel, "label": clip(i["title"]),
             "platform": args.platform, "url": i["url"], "evidence": "SEEN", "detail": i["title"], "reach": ""}
            for i in chosen]
    if args.moves_out:
        write_csv(args.moves_out, MOVES_COLUMNS, rows)
    warnings = []
    if n_skipped:
        warnings.append(f"{n_skipped} item(s) lacked a title, link or parseable date and were skipped")
    if not rows:
        warnings.append("no feed item passed the filters")
    for w in warnings:
        sys.stderr.write(f"warning: {w}\n")
    emit({"source": urllib.parse.urlsplit(args.feed).netloc, "feed": args.feed, "feed_format": parsed["format"],
          "feed_title": parsed["title"], "as_of": today.isoformat(), "n_items": len(parsed["items"]),
          "n_selected": len(rows), "filtered_out": n_filtered, "before_since": n_old, "skipped": n_skipped,
          "moves_csv": args.moves_out, "warnings": warnings,
          "items": [{"date": r["date"], "title": r["detail"], "url": r["url"]} for r in rows]}, args.out)


# ----------------------------------------------------------------------------
# 7. page
# ----------------------------------------------------------------------------

PAGE_SKIP = {"script", "style", "noscript", "svg", "template", "nav", "footer", "head", "iframe"}
PAGE_BLOCKS = {"p", "div", "section", "article", "main", "aside", "header", "ul", "ol", "li", "br", "tr", "table",
               "blockquote", "pre", "form", "fieldset", "dl", "dt", "dd", "figure", "figcaption", "hr", "details",
               "summary", "h1", "h2", "h3", "h4", "h5", "h6"}
PAGE_MIN_CHARS = 200


def decode_html(body):
    head = body[:2048].decode("ascii", "ignore")
    m = re.search(r"charset\s*=\s*[\"']?([\w-]+)", head, re.IGNORECASE)
    for enc in ([m.group(1)] if m else []) + ["utf-8"]:
        try:
            return body.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
    return body.decode("utf-8", "replace")


class TextExtractor(HTMLParser):
    """Readable text: drops script/style/nav/footer, keeps headings as '# ...' and links as 'text (url)'."""

    def __init__(self, base_url=""):
        super().__init__(convert_charrefs=True)
        self.base = base_url
        self.lines, self.buf, self.skip = [], [], {}
        self.heading = self.href = None
        self.a_start, self.a_label, self.n_links = 0, "", 0

    def _skipping(self):
        return any(self.skip.values())

    def _apply_link(self):
        if self.href is None:
            return
        raw = "".join(self.buf[self.a_start:])
        text = " ".join(raw.split()) or self.a_label
        del self.buf[self.a_start:]
        if text:
            lead = " " if raw[:1].isspace() else ""
            trail = " " if raw[-1:].isspace() else ""
            self.buf.append(f"{lead}{text}{trail}" if text == self.href else f"{lead}{text} ({self.href}){trail}")
            self.n_links += text != self.href
        self.a_start = len(self.buf)

    def _break(self):
        self._apply_link()
        line = " ".join("".join(self.buf).split())
        self.buf = []
        self.a_start = 0
        if line and line != "-":
            if self.heading:
                self.lines.append("")
                line = "#" * self.heading + " " + line
            self.lines.append(line)

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "body":
            self.skip["head"] = 0                       # an unclosed <head> must not swallow the page
        if tag in PAGE_SKIP:
            self.skip[tag] = self.skip.get(tag, 0) + 1
            return
        if self._skipping():
            return
        if tag in PAGE_BLOCKS:
            self._break()
        if re.fullmatch(r"h[1-6]", tag):
            self.heading = int(tag[1])
        elif tag == "li":
            self.buf.append("- ")
        elif tag == "a" and self.href is None:
            href = a.get("href", "").strip()
            if href and not href.startswith(("#", "javascript:", "data:")):
                self.href = urllib.parse.urljoin(self.base, href)
                self.a_start, self.a_label = len(self.buf), a.get("aria-label") or a.get("title", "")
        elif tag == "img" and self.href is not None and not self.a_label:
            self.a_label = a.get("alt", "")

    def handle_endtag(self, tag):
        if tag in PAGE_SKIP:
            self.skip[tag] = max(0, self.skip.get(tag, 0) - 1)
            return
        if self._skipping():
            return
        if tag == "a" and self.href is not None:
            self._apply_link()
            self.href, self.a_label = None, ""
        elif tag in PAGE_BLOCKS:
            self._break()
            if re.fullmatch(r"h[1-6]", tag):
                self.heading = None

    def handle_data(self, data):
        if not self._skipping():
            self.buf.append(data)

    def text(self):
        self.close()
        self._break()
        out, blank = [], False
        for line in self.lines:
            if line:
                out.append(line)
                blank = False
            elif not blank and out:
                out.append("")
                blank = True
        return "\n".join(out).strip() + "\n"


def page_text(body, base_url=""):
    """-> (text, n_links). Non-HTML bodies (text/plain, markdown) come back unchanged."""
    raw = decode_html(maybe_gunzip(body))
    if not re.search(r"<\s*(!doctype|html|head|body|div|p|h[1-6]|a|ul|table|section|article|main)\b", raw[:4096],
                     re.IGNORECASE):
        return raw.strip() + "\n", 0
    ex = TextExtractor(base_url)
    ex.feed(raw)
    return ex.text(), ex.n_links


def cmd_page(args):
    if not re.match(r"https?://[^\s/]+", args.url):
        raise FreeError(f"--url must be an http(s) URL, got {args.url!r}")
    fetcher = make_fetcher(args, "page")
    text, n_links = page_text(fetcher.get(args.url), args.url)
    warnings = []
    if len(text.strip()) < PAGE_MIN_CHARS:
        warnings.append(f"only {len(text.strip())} characters of text; the page may be rendered by JavaScript, "
                        "so what is shown here may not be everything it shows")
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)
    sys.stderr.write(json.dumps({"url": args.url, "chars": len(text), "links": n_links, "warnings": warnings}) + "\n")


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def _pos_int(text):
    try:
        v = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not an integer: {text!r}")
    if v < 1:
        raise argparse.ArgumentTypeError("must be >= 1")
    return v


def build_parser():
    ap = argparse.ArgumentParser(prog="free_sources.py", description="rea-growth free-mode data layer (public endpoints only)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, fn, help_, out_help="write JSON here (default stdout)"):
        p = sub.add_parser(name, help=help_)
        p.add_argument("-o", "--out", help=out_help)
        p.add_argument("--cache", help=f"raw response cache dir (default raw/free/{name}/)")
        p.add_argument("--offline", action="store_true", help="read the cache only; never touch the network")
        p.add_argument("--delay", type=float, default=1.0, help="seconds between network requests (default 1)")
        p.set_defaults(fn=fn)
        return p

    def dates(p):
        p.add_argument("--today", type=parse_day, help="YYYY-MM-DD; this month and later count as partial")

    def months(p):
        p.add_argument("--from", dest="frm", type=parse_ym, help="first month YYYY-MM")
        p.add_argument("--to", type=parse_ym, help="last month YYYY-MM (default: this month)")

    p = add("hn", cmd_hn, "Hacker News stories by month (Algolia API)")
    p.add_argument("--query", required=True)
    months(p)
    dates(p)
    p.add_argument("--csv-out", help="month,value,partial,mentions (value = sum of points)")
    p.add_argument("--moves-out", help="moves CSV for the top stories")
    p.add_argument("--top", type=_pos_int, default=10)

    p = add("github-stars", cmd_github_stars, "stars over time from sampled stargazer pages")
    p.add_argument("--repo", required=True, help="OWNER/REPO")
    dates(p)
    p.add_argument("--csv-out", help="month,value,partial (people series, cumulative)")
    p.add_argument("--max-pages", type=_pos_int, default=40)
    p.add_argument("--releases-moves", help="write releases as a moves CSV (channel company, platform github)")
    p.add_argument("--no-gh", action="store_true", help="use unauthenticated urllib instead of the gh CLI")
    p.add_argument("--wayback", action="store_true",
                   help="build the people series from monthly Wayback captures of github.com/OWNER/REPO "
                        "(use when stargazers cannot be listed); each point links its capture, gaps are listed")
    p.add_argument("--releases-include", type=compile_regex, metavar="REGEX",
                   help="keep only releases whose name or tag matches (case-insensitive)")
    p.add_argument("--releases-exclude", type=compile_regex, metavar="REGEX",
                   help='drop releases whose name or tag matches (case-insensitive), e.g. "Developer Update"')

    p = add("wikipedia", cmd_wikipedia, "monthly pageviews of one article")
    p.add_argument("--article", required=True)
    p.add_argument("--lang", default="en")
    months(p)
    dates(p)
    p.add_argument("--csv-out", help="month,value,partial")

    p = add("reddit", cmd_reddit, "top Reddit posts for a query (public JSON; exit 3 when blocked)")
    p.add_argument("--query", required=True)
    dates(p)
    p.add_argument("--top", type=_pos_int, default=25)
    p.add_argument("--moves-out", help="moves CSV for the top posts")

    p = add("sitemap", cmd_sitemap, "page URL list from robots.txt / sitemap.xml",
            out_help="write the URL list here (default stdout)")
    p.add_argument("--site", required=True, help="DOMAIN, e.g. example.com")

    p = add("rss", cmd_rss, "dated posts from an RSS/Atom feed as moves, or find a site's feeds")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--feed", help="feed URL (RSS 2.0, Atom or RSS 1.0)")
    g.add_argument("--discover", metavar="SITE", help="find feed URLs: <link rel=alternate> on the home page "
                                                      "and common paths (/rss.xml, /feed, /blog/rss.xml, /atom.xml)")
    dates(p)
    p.add_argument("--include", type=compile_regex, metavar="REGEX", help="keep items whose title matches")
    p.add_argument("--exclude", type=compile_regex, metavar="REGEX", help="drop items whose title matches")
    p.add_argument("--channel", default="company", help="moves channel (default company)")
    p.add_argument("--platform", default="news", help="moves platform (default news)")
    p.add_argument("--since", type=parse_ym, metavar="YYYY-MM", help="drop items before this month")
    p.add_argument("--moves-out", help="moves CSV: one row per item (label <= 32 chars, detail = full title)")

    p = add("page", cmd_page, "a public page as readable text (free page read)",
            out_help="write the text here (default stdout)")
    p.add_argument("--url", required=True, help="http(s) page URL")
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        args.fn(args)
    except FreeError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return exc.code
    except (ValueError, OSError) as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1
    except Exception as exc:  # never a traceback
        sys.stderr.write(f"error: unexpected {type(exc).__name__}: {exc}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
