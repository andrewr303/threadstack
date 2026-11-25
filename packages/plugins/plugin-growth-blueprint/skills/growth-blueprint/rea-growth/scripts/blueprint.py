#!/usr/bin/env python3
"""rea-growth blueprint tool: validate | render | md | scaffold | demo.

The blueprint is one JSON file (schema "rea-growth/blueprint@1"). `render` injects it into
assets/blueprint.template.html and writes ONE self-contained HTML page; `md` writes the same
content as Markdown (playbook.md). Standard library only.
"""
from __future__ import annotations

import argparse
import base64
import csv
import datetime as _dt
import json
import math
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "assets" / "blueprint.template.html"
DEMO = ROOT / "examples" / "acme" / "blueprint.json"
SCHEMA = "rea-growth/blueprint@1"
SLOT = '<script id="blueprint-data" type="application/json"></script>'

EVIDENCE = {"SEEN", "INFERRED"}
VISUAL_TYPES = {"post", "ads", "badge", "links", "ai_answer", "image", "stat"}
STAGE_ORDER = ["Get noticed", "Sign up", "First win", "Pay", "Share"]
STAGES = set(STAGE_ORDER)
MODES = {"growth", "content"}
PLAY_COUNT = 10  # a growth blueprint carries exactly this many plays (not in content mode)
SKIP_RANGE = (2, 3)
IMAGE_EXT = {".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"}
MIME = {".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif"}
# keys whose string values are image references
IMAGE_KEYS = {"logo", "avatar", "media", "src", "brand_icon", "icon"}
# keys whose string values are links (relative ones are rebased on render)
LINK_KEYS = {"url"}
LANE_LABELS = {"seo": "SEO / AEO", "aeo": "SEO / AEO", "ads": "Ads", "paid": "Ads", "social": "Social media",
               "product": "Product loop", "loop": "Product loop", "pr": "PR / press", "community": "Community",
               "company": "Company"}
LANE_NOTES = {"company": "launches, funding, hires"}
# SKILL.md step numbers -> readable names for the cost table (ledger "step" may be a bare number)
STEP_LABELS = {0: "Setup", 1: "Site", 2: "Stack and news", 3: "Traffic and peers", 4: "Search and AI", 5: "Ads",
               6: "Mentions", 7: "Own content", 8: "Links and loops", 9: "Hiring", 10: "Moves", 12: "Blueprint"}

MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
DAY_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])-\d{2}$")
SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:")
BAD_SCHEME_RE = re.compile(r"^(javascript|vbscript):", re.I)
MD_LINK_RE = re.compile(r"\]\(\s*([^)\s]+)")
# the same markdown-lite link shape the template renders: [label](target)
MD_FULL_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")
SURROGATE_RE = re.compile("[\ud800-\udfff]")


# --------------------------------------------------------------------------------------------
# helpers

def load_json(path: Path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def dump_json(data, path: Path | None):
    text = json.dumps(data, indent=1, ensure_ascii=False) + "\n"
    if path is None:
        sys.stdout.write(text)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


def is_month(s) -> bool:
    return isinstance(s, str) and bool(MONTH_RE.match(s))


def is_day(s) -> bool:
    if not (isinstance(s, str) and DAY_RE.match(s)):
        return False
    try:
        _dt.date.fromisoformat(s)
        return True
    except ValueError:
        return False


def is_date(s) -> bool:
    return is_month(s) or is_day(s)


def month_key(s: str) -> int:
    return int(s[:4]) * 12 + int(s[5:7]) - 1


def date_pos(s: str) -> float:
    """Fractional month index (month start for YYYY-MM)."""
    base = month_key(s)
    if len(s) == 10:
        d = _dt.date.fromisoformat(s)
        nxt = _dt.date(d.year + (d.month == 12), d.month % 12 + 1, 1)
        days = (nxt - _dt.date(d.year, d.month, 1)).days
        return base + (d.day - 1) / days
    return float(base)


def date_end(s: str) -> float:
    """Fractional month index of the END of a YYYY-MM or YYYY-MM-DD date."""
    if len(s) == 10:
        d = _dt.date.fromisoformat(s)
        nxt = _dt.date(d.year + (d.month == 12), d.month % 12 + 1, 1)
        days = (nxt - _dt.date(d.year, d.month, 1)).days
        return month_key(s) + d.day / days
    return month_key(s) + 1.0


def is_local_ref(s) -> bool:
    return isinstance(s, str) and s != "" and not SCHEME_RE.match(s) and not s.startswith(("#", "/", "//"))


def looks_like_image_path(key: str, s) -> bool:
    if not isinstance(s, str) or not s:
        return False
    if key == "icon":  # "icon" may be a platform name like "google_ads"
        return "/" in s or "." in s
    return True


def strip_ws(s: str) -> str:
    return re.sub(r"[\x00-\x20\x7f]+", "", s)


def walk(node, path=""):
    """Yield (path, key, value) for every scalar in a JSON tree."""
    if isinstance(node, dict):
        for k, v in node.items():
            p = f"{path}.{k}" if path else k
            if isinstance(v, (dict, list)):
                yield from walk(v, p)
            else:
                yield p, k, v
    elif isinstance(node, list):
        for i, v in enumerate(node):
            p = f"{path}[{i}]"
            if isinstance(v, (dict, list)):
                yield from walk(v, p)
            else:
                yield p, None, v


# --------------------------------------------------------------------------------------------
# validate

class Report:
    def __init__(self):
        self.items: list[tuple[str, str, str]] = []

    def err(self, path, msg):
        if any(lvl == "ERROR" and p == path for lvl, p, _ in self.items):
            return  # one problem per path is enough
        self.items.append(("ERROR", path, msg))

    def warn(self, path, msg):
        self.items.append(("WARN", path, msg))

    def note(self, path, msg):
        """Information for the author; never an error, not even under --strict."""
        self.items.append(("NOTE", path, msg))

    def errors(self, strict=False):
        return [i for i in self.items if i[0] == "ERROR" or (strict and i[0] == "WARN")]

    def warnings(self):
        return [i for i in self.items if i[0] == "WARN"]

    def notes(self):
        return [i for i in self.items if i[0] == "NOTE"]


def is_num(v) -> bool:
    """A real, finite JSON number (not a bool, not NaN/Infinity)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _list(r: Report, v, path) -> list:
    """The value as a list; None counts as empty, anything else that is not a list is an error."""
    if v is None:
        return []
    if not isinstance(v, list):
        r.err(path, "must be a list")
        return []
    return v


def _opt_str(r: Report, obj, key, path) -> None:
    """If present (not null), the field must be a string."""
    v = obj.get(key) if isinstance(obj, dict) else None
    if v is not None and not isinstance(v, str):
        r.err(f"{path}.{key}" if path else key, "must be a string")


def _opt_num(r: Report, obj, key, path, minimum=None) -> None:
    v = obj.get(key) if isinstance(obj, dict) else None
    if v is None:
        return
    p = f"{path}.{key}" if path else key
    if not is_num(v):
        r.err(p, "must be a finite number")
    elif minimum is not None and v < minimum:
        r.err(p, f"must be >= {minimum}")


def _req(r: Report, obj, key, path, kind=str):
    v = obj.get(key) if isinstance(obj, dict) else None
    if v is None or (kind is str and (not isinstance(v, str) or not v.strip())):
        r.err(f"{path}.{key}" if path else key, "required")
        return None
    if kind is not str and not isinstance(v, kind):
        r.err(f"{path}.{key}" if path else key, f"must be a {kind.__name__}")
        return None
    return v


def _evidence(r: Report, item, path, url_value, url_path=None):
    ev = item.get("evidence")
    if not isinstance(ev, str) or ev not in EVIDENCE:
        r.err(f"{path}.evidence", "must be SEEN or INFERRED")
    elif ev == "SEEN" and not (isinstance(url_value, str) and url_value.strip()):
        r.err(url_path or f"{path}.url", "a SEEN item needs a non-empty url")


def _image(r: Report, base: Path | None, value, path):
    if not isinstance(value, str) or not value:
        return
    if value.startswith("data:"):
        if not value.startswith("data:image/"):
            r.err(path, "only data:image/ URIs are allowed for images")
        return
    if is_local_ref(value) and base is not None and not (base / value).is_file():
        r.err(path, f"image not found: {value}")


def validate(data, base: Path | None = None) -> Report:
    """Check a blueprint dict. `base` is the directory of the json (for local image paths).

    Never raises: a malformed tree is reported as problems with JSON paths. If a check still
    trips over an unexpected shape, that is reported as one ERROR instead of a traceback."""
    r = Report()
    try:
        _validate(r, data, base)
    except Exception as e:  # last line of defence; every known shape is type-checked first
        r.err("$", f"could not check this blueprint ({type(e).__name__}: {e}); fix the types above")
    return r


def _deep_checks(r: Report, node, path="$"):
    """Whole-tree checks: finite numbers, valid Unicode, no javascript: URLs, TODO markers."""
    if isinstance(node, dict):
        for k, v in node.items():
            p = k if path == "$" else f"{path}.{k}"
            if isinstance(k, str) and SURROGATE_RE.search(k):
                r.err(p, "key contains invalid Unicode (a lone surrogate)")
            _deep_checks(r, v, p)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _deep_checks(r, v, f"{path}[{i}]")
    elif isinstance(node, float):
        if not math.isfinite(node):
            r.err(path, "must be a finite number (NaN and Infinity are not valid JSON)")
    elif isinstance(node, str):
        if SURROGATE_RE.search(node):
            r.err(path, "contains invalid Unicode (a lone surrogate)")
        if BAD_SCHEME_RE.match(strip_ws(node)):
            r.err(path, "javascript: and vbscript: URLs are not allowed")
        else:
            for m in MD_LINK_RE.finditer(node):
                if BAD_SCHEME_RE.match(strip_ws(m.group(1))):
                    r.err(path, "javascript: link inside text")
        if "TODO" in node:
            r.warn(path, "TODO marker left in")


def _validate(r: Report, data, base: Path | None) -> None:
    if not isinstance(data, dict):
        r.err("$", "blueprint must be a JSON object")
        return
    if data.get("schema") != SCHEMA:
        r.err("schema", f'must be "{SCHEMA}"')
    _opt_str(r, data, "title", "")
    _opt_str(r, data, "pulled_through", "")
    mode = data.get("mode")
    if mode is not None and (not isinstance(mode, str) or mode not in MODES):
        r.err("mode", f"must be one of {', '.join(sorted(MODES))} (or left out)")
    content_mode = mode == "content"

    company = data.get("company")
    if not isinstance(company, dict):
        r.err("company", "required object")
        company = {}
    else:
        _req(r, company, "name", "company")
        _opt_str(r, company, "domain", "company")
        _opt_str(r, company, "logo", "company")
        if company.get("logo"):
            _image(r, base, company["logo"], "company.logo")
    domain = company.get("domain") if isinstance(company.get("domain"), str) else ""
    if domain.lower().endswith(".example") and data.get("example") is not True:
        r.err("example", "company.domain ends with .example, so example must be true")

    period = data.get("period")
    pstart = pend = None
    if not isinstance(period, dict):
        r.err("period", "required object with start and end (YYYY-MM)")
    else:
        for k in ("start", "end"):
            v = period.get(k)
            if not is_month(v):
                r.err(f"period.{k}", "must be YYYY-MM")
        if is_month(period.get("start")) and is_month(period.get("end")):
            pstart, pend = month_key(period["start"]), month_key(period["end"])
            if pstart > pend:
                r.err("period", "start must not be after end")
    if data.get("as_of") is not None and not is_day(data.get("as_of")):
        r.err("as_of", "must be YYYY-MM-DD")
    _opt_num(r, data, "cost_usd", "", minimum=0)

    def in_period(s, path):
        if pstart is None or not is_date(s):
            return
        k = month_key(s)
        if k < pstart or k > pend:
            r.warn(path, f"{s} is outside the period")

    def ref_id(obj, key, path, known, what):
        """An optional reference to an id: must be a string naming a known id (warn if unknown)."""
        v = obj.get(key)
        if v is None:
            return
        if not isinstance(v, str):
            r.err(f"{path}.{key}", "must be a string id")
        elif v not in known:
            r.warn(f"{path}.{key}", f"no {what} with id {v!r}")

    # chart
    chart = data.get("chart")
    series_ids: set[str] = set()
    if not isinstance(chart, dict):
        r.err("chart", "required object")
        chart = {}
    series = chart.get("series")
    if not isinstance(series, list) or not series:
        r.err("chart.series", "needs at least one series")
        series = []
    for i, s in enumerate(series):
        p = f"chart.series[{i}]"
        if not isinstance(s, dict):
            r.err(p, "must be an object")
            continue
        sid = _req(r, s, "id", p)
        _req(r, s, "label", p)
        for k in ("sublabel", "short_label", "unit", "leaves_out"):
            _opt_str(r, s, k, p)
        if sid:
            if sid in series_ids:
                r.err(f"{p}.id", f"duplicate series id {sid!r}")
            series_ids.add(sid)
        pts = s.get("points")
        if not isinstance(pts, list):
            r.err(f"{p}.points", "must be a list")
            pts = []
        if not pts:
            r.warn(f"{p}.points", "TODO: no data points yet")
        seen_months = set()
        for j, pt in enumerate(pts):
            pp = f"{p}.points[{j}]"
            if not isinstance(pt, dict):
                r.err(pp, "must be an object")
                continue
            if not is_month(pt.get("month")):
                r.err(f"{pp}.month", "must be YYYY-MM")
            else:
                if pt["month"] in seen_months:
                    r.err(f"{pp}.month", f"duplicate month {pt['month']}")
                seen_months.add(pt["month"])
                in_period(pt["month"], f"{pp}.month")
            v = pt.get("value")
            if not is_num(v) or v < 0:
                r.err(f"{pp}.value", "must be a finite number >= 0")
        src = s.get("source")
        if src is not None and not isinstance(src, dict):
            r.err(f"{p}.source", "must be an object")
        elif isinstance(src, dict):
            for k in ("label", "url"):
                _opt_str(r, src, k, f"{p}.source")
            if src.get("date") is not None and not is_date(src.get("date")):
                r.err(f"{p}.source.date", "must be YYYY-MM or YYYY-MM-DD")
    dflt = chart.get("default")
    if dflt is not None and (not isinstance(dflt, str) or dflt not in series_ids):
        r.err("chart.default", f"no series with id {dflt!r}")

    for i, a in enumerate(_list(r, chart.get("annotations"), "chart.annotations")):
        p = f"chart.annotations[{i}]"
        if not isinstance(a, dict):
            r.err(p, "must be an object")
            continue
        if not is_date(a.get("date")):
            r.err(f"{p}.date", "must be YYYY-MM or YYYY-MM-DD")
        else:
            in_period(a["date"], f"{p}.date")
        _req(r, a, "text", p)
        for k in ("detail", "url"):
            _opt_str(r, a, k, p)
        _opt_num(r, a, "priority", p)
        _evidence(r, a, p, a.get("url"))
        ref_id(a, "series", p, series_ids, "series")

    for i, w in enumerate(_list(r, chart.get("windows"), "chart.windows")):
        p = f"chart.windows[{i}]"
        if not isinstance(w, dict):
            r.err(p, "must be an object")
            continue
        ok = True
        for k in ("start", "end"):
            if not is_date(w.get(k)):
                r.err(f"{p}.{k}", "must be YYYY-MM or YYYY-MM-DD")
                ok = False
        if ok:
            if date_pos(w["start"]) >= date_pos(w["end"]):
                r.err(p, "start must be before end")
            if pstart is not None and (date_pos(w["start"]) < pstart or date_end(w["end"]) > pend + 1):
                r.err(p, "window must sit inside the period")
        _opt_str(r, w, "label", p)
        ref_id(w, "series", p, series_ids, "series")

    # lanes
    lanes = data.get("lanes")
    if not isinstance(lanes, list):
        r.err("lanes", "must be a list")
        lanes = []
    if not lanes:
        r.warn("lanes", "TODO: no lanes of moves yet")
    lane_ids: set[str] = set()
    for i, ln in enumerate(lanes):
        p = f"lanes[{i}]"
        if not isinstance(ln, dict):
            r.err(p, "must be an object")
            continue
        lid = _req(r, ln, "id", p)
        _req(r, ln, "label", p)
        _opt_str(r, ln, "note", p)
        if lid:
            if lid in lane_ids:
                r.err(f"{p}.id", f"duplicate lane id {lid!r}")
            lane_ids.add(lid)
        for j, mv in enumerate(_list(r, ln.get("moves"), f"{p}.moves")):
            mp = f"{p}.moves[{j}]"
            if not isinstance(mv, dict):
                r.err(mp, "must be an object")
                continue
            if not is_date(mv.get("date")):
                r.err(f"{mp}.date", "must be YYYY-MM or YYYY-MM-DD")
            else:
                in_period(mv["date"], f"{mp}.date")
            _req(r, mv, "label", mp)
            for k in ("platform", "url", "detail", "icon"):
                _opt_str(r, mv, k, mp)
            _evidence(r, mv, mp, mv.get("url"))
            if mv.get("icon") and looks_like_image_path("icon", mv.get("icon")):
                _image(r, base, mv["icon"], f"{mp}.icon")

    # channels
    channels = data.get("channels")
    if not isinstance(channels, list):
        r.err("channels", "must be a list")
        channels = []
    if not channels:
        r.warn("channels", "TODO: no channel cards yet")
    ch_ids: set[str] = set()
    for i, ch in enumerate(channels):
        p = f"channels[{i}]"
        if not isinstance(ch, dict):
            r.err(p, "must be an object")
            continue
        cid = _req(r, ch, "id", p)
        _req(r, ch, "label", p)
        _opt_str(r, ch, "takeaway", p)
        for j, ic in enumerate(_list(r, ch.get("icons"), f"{p}.icons")):
            if not isinstance(ic, str):
                r.err(f"{p}.icons[{j}]", "must be a platform name")
        if cid:
            if cid in ch_ids:
                r.err(f"{p}.id", f"duplicate channel id {cid!r}")
            ch_ids.add(cid)
        cards = _list(r, ch.get("cards"), f"{p}.cards")
        if len(cards) > 3:
            r.warn(f"{p}.cards", f"{len(cards)} cards; only the first 3 are shown")
        if not cards:
            r.warn(f"{p}.cards", "TODO: no cards in this channel")
        for j, c in enumerate(cards):
            cp = f"{p}.cards[{j}]"
            if not isinstance(c, dict):
                r.err(cp, "must be an object")
                continue
            _req(r, c, "title", cp)
            _opt_str(r, c, "finding", cp)
            src = c.get("source")
            if src is not None and not isinstance(src, dict):
                r.err(f"{cp}.source", "must be an object")
            src = src if isinstance(src, dict) else {}
            for k in ("label", "url"):
                _opt_str(r, src, k, f"{cp}.source")
            if src.get("date") is not None and not is_date(src.get("date")):
                r.err(f"{cp}.source.date", "must be YYYY-MM or YYYY-MM-DD")
            _evidence(r, c, cp, src.get("url"), f"{cp}.source.url")
            _visual(r, base, c.get("visual"), f"{cp}.visual")

    # plays
    plays = data.get("plays")
    items = plays.get("items") if isinstance(plays, dict) else None
    if not isinstance(items, list):
        r.err("plays.items", "must be a list")
        items = []
    if not items:
        r.warn("plays.items", "TODO: no plays yet")
    if isinstance(plays, dict) and plays.get("show") is not None and (
            not isinstance(plays["show"], int) or isinstance(plays["show"], bool) or plays["show"] < 0):
        r.err("plays.show", "must be a whole number >= 0")
    for i, pl in enumerate(items):
        p = f"plays.items[{i}]"
        if not isinstance(pl, dict):
            r.err(p, "must be an object")
            continue
        _req(r, pl, "title", p)
        for k in ("effort", "first_result", "metric"):
            _opt_str(r, pl, k, p)
        if not (isinstance(pl.get("prompt"), str) and pl["prompt"].strip()):
            r.err(f"{p}.prompt", "every play needs a paste-ready prompt")
        stage = pl.get("stage")
        if stage is not None:
            if not isinstance(stage, str):
                r.err(f"{p}.stage", "must be a string")
            elif stage not in STAGES:
                r.warn(f"{p}.stage", f"stage should be one of {', '.join(sorted(STAGES))}")
        chn = pl.get("channel")
        if chn is not None:
            if not isinstance(chn, str):
                r.err(f"{p}.channel", "must be a string id")
            elif ch_ids and chn not in ch_ids and chn not in lane_ids:
                r.warn(f"{p}.channel", f"no channel or lane with id {chn!r}")
        seen_linked = False
        for j, e in enumerate(_list(r, pl.get("evidence"), f"{p}.evidence")):
            if not isinstance(e, dict) or not isinstance(e.get("kind"), str) or e.get("kind") not in EVIDENCE:
                r.err(f"{p}.evidence[{j}].kind", "must be SEEN or INFERRED")
            elif not isinstance(e.get("text"), str):
                r.err(f"{p}.evidence[{j}].text", "must be a string")
            elif e["kind"] == "SEEN" and MD_FULL_LINK_RE.search(e["text"]):
                seen_linked = True
        if not content_mode:
            # play rules (references/blueprint.md): warnings, so --strict turns them into errors
            if not (isinstance(stage, str) and stage.strip()):
                r.warn(f"{p}.stage", "every play names a stage (" + ", ".join(STAGE_ORDER) + ")")
            for k in ("effort", "metric"):
                if not (isinstance(pl.get(k), str) and pl[k].strip()):
                    r.warn(f"{p}.{k}", f"every play needs {'an effort' if k == 'effort' else 'a metric to watch'}")
            if not seen_linked:
                r.warn(f"{p}.evidence", "needs at least one SEEN item whose text has a [label](url) link")
    if not content_mode and items and len(items) != PLAY_COUNT:
        r.warn("plays.items", f"{len(items)} plays; a blueprint has exactly {PLAY_COUNT}")

    skips = _list(r, data.get("skip"), "skip")
    for i, s in enumerate(skips):
        if not isinstance(s, dict) or not isinstance(s.get("title"), str) or not s["title"].strip():
            r.err(f"skip[{i}].title", "required")
        else:
            _opt_str(r, s, "why", f"skip[{i}]")
    if not content_mode and not SKIP_RANGE[0] <= len(skips) <= SKIP_RANGE[1]:
        r.warn("skip", f"{len(skips)} item(s); list {SKIP_RANGE[0]}-{SKIP_RANGE[1]} plays the evidence does not support")

    _path(r, data.get("path"))
    _next(r, data.get("next"))

    calls = data.get("calls")
    if calls is not None and not isinstance(calls, dict):
        r.err("calls", "must be an object")
    elif isinstance(calls, dict):
        _opt_str(r, calls, "footnote", "calls")
        total = 0.0
        for i, it in enumerate(_list(r, calls.get("items"), "calls.items")):
            ip = f"calls.items[{i}]"
            if not isinstance(it, dict):
                r.err(ip, "must be an object")
                continue
            _opt_str(r, it, "label", ip)
            c = it.get("cost_usd")
            if not is_num(c):
                r.err(f"{ip}.cost_usd", "must be a finite number")
            else:
                total += c
            for j, ep in enumerate(_list(r, it.get("endpoints"), f"{ip}.endpoints")):
                ep_p = f"{ip}.endpoints[{j}]"
                if not isinstance(ep, dict):
                    r.err(ep_p, "must be an object with id and calls")
                    continue
                if not isinstance(ep.get("id"), str) or not ep["id"].strip():
                    r.err(f"{ep_p}.id", "required")
                _opt_num(r, ep, "calls", ep_p, minimum=0)
                _opt_num(r, ep, "cost_usd", ep_p, minimum=0)
        tu = calls.get("total_usd")
        if tu is not None and not is_num(tu):
            r.err("calls.total_usd", "must be a finite number")
        elif is_num(tu) and abs(tu - total) > 0.005:
            r.warn("calls.total_usd", f"{tu} differs from the sum of items {round(total, 4)}")

    for i, m in enumerate(_list(r, data.get("method"), "method")):
        if not isinstance(m, str):
            r.err(f"method[{i}]", "must be a string (markdown-lite)")

    _leftover_checks(r, data, series, lanes)
    _deep_checks(r, data)


# hosts of the free sources (free_sources.py, Wayback): data from them is not DataForSEO's
FREE_SOURCE_HOSTS = ("hn.algolia.com", "news.ycombinator.com", "github.com", "api.github.com", "web.archive.org",
                     "wikipedia.org", "wikimedia.org", "reddit.com")
# local file names that plausibly hold a DataForSEO export (traffic history, rank overview, search demand)
DFS_FILE_RE = re.compile(r"traffic|history|rank|hro|demand|keyword|volume|search|serp|dataforseo", re.I)


def _url_host(u: str) -> str:
    m = re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*://([^/?#:]+)", u.strip())
    return m.group(1).lower() if m else ""


def _is_local_file_url(u: str) -> bool:
    u = u.strip()
    return bool(u) and (u.lower().startswith("file:") or not SCHEME_RE.match(u)) and not u.startswith(("#", "//"))


def _leftover_checks(r: Report, data, series, lanes) -> None:
    """Scaffold defaults left in by mistake (free mode, renamed series) and things hidden on the page."""
    pt = data.get("pulled_through")
    calls = data.get("calls")
    has_calls = isinstance(calls, dict) and bool(calls.get("items"))
    cost = data.get("cost_usd")
    if isinstance(pt, str) and re.search(r"\btreg\b", pt, re.I) and not has_calls and (cost is None or (is_num(cost) and cost == 0)):
        r.warn("pulled_through", f"says {pt!r} but cost_usd is {0 if cost is None else cost} and there is no calls block; "
                                 "a free-mode run names its sources instead (scaffold --pulled-through)")
    for i, ln in enumerate(lanes if isinstance(lanes, list) else []):
        if not isinstance(ln, dict) or not isinstance(ln.get("moves", []), (list, type(None))):
            continue
        note = ln.get("note")
        if not ln.get("moves") and not (isinstance(note, str) and note.strip()):
            r.warn(f"lanes[{i}].note", "an empty lane must say why in its note, e.g. \"not read (free mode)\"")
    for i, s in enumerate(series if isinstance(series, list) else []):
        src = s.get("source") if isinstance(s, dict) else None
        if not isinstance(src, dict) or not isinstance(src.get("label"), str) or "dataforseo" not in src["label"].lower():
            continue
        url = src.get("url") if isinstance(src.get("url"), str) else ""
        host = _url_host(url)
        name = re.split(r"[\\/]", url.split("?")[0].split("#")[0])[-1]
        if _is_local_file_url(url) and name and not DFS_FILE_RE.search(name):
            r.warn(f"chart.series[{i}].source.label", f"{src['label']!r} on data from {name!r}; is this the scaffold's "
                                                       "default label? (scaffold --source-label)")
        elif host and any(host == h or host.endswith("." + h) for h in FREE_SOURCE_HOSTS):
            r.warn(f"chart.series[{i}].source.label", f"{src['label']!r} on data from {host}; is this the scaffold's "
                                                       "default label? (scaffold --source-label)")
    # annotations / windows bound to a series other than the default are drawn only when it is shown
    chart = data.get("chart") if isinstance(data.get("chart"), dict) else {}
    ids = [s.get("id") for s in series if isinstance(s, dict) and isinstance(s.get("id"), str)] if isinstance(series, list) else []
    if not ids:
        return
    dflt = chart.get("default") if chart.get("default") in ids else ids[0]
    for key, what in (("annotations", "annotation"), ("windows", "window")):
        hidden: dict[str, list[str]] = {}
        items = chart.get(key) if isinstance(chart.get(key), list) else []
        for j, a in enumerate(items):
            if isinstance(a, dict) and isinstance(a.get("series"), str) and a["series"] != dflt and a["series"] in ids:
                hidden.setdefault(a["series"], []).append(f"[{j}] " + str(a.get("text") or a.get("label") or a.get("date") or ""))
        for sid, names in hidden.items():
            r.note(f"chart.{key}", f"{len(names)} {what}(s) bound to series {sid!r} stay hidden until that series is shown "
                                   f"(default {dflt!r}; audit with ?series={sid} or ?audit=all): " + "; ".join(names))


def _sourced(r: Report, item, path):
    """evidence SEEN|INFERRED and an optional url; SEEN needs the url or a [label](url) link in text."""
    _opt_str(r, item, "url", path)
    ev = item.get("evidence")
    if not isinstance(ev, str) or ev not in EVIDENCE:
        r.err(f"{path}.evidence", "must be SEEN or INFERRED")
    elif ev == "SEEN":
        url = item.get("url")
        text = item.get("text") if isinstance(item.get("text"), str) else ""
        if not (isinstance(url, str) and url.strip()) and not MD_FULL_LINK_RE.search(text):
            r.err(f"{path}.url", "a SEEN item needs a url (or a [label](url) link in its text)")


def _path(r: Report, path_obj):
    """Optional "path": {stages: [{stage, text, evidence, url?}], loops: [{name, text, since?}]}."""
    if path_obj is None:
        return
    if not isinstance(path_obj, dict):
        r.err("path", "must be an object with stages (and optional loops)")
        return
    stages = _list(r, path_obj.get("stages"), "path.stages")
    if not stages:
        r.warn("path.stages", "TODO: no stages yet (one per stage: " + ", ".join(STAGE_ORDER) + ")")
    named = []
    for i, st in enumerate(stages):
        p = f"path.stages[{i}]"
        if not isinstance(st, dict):
            r.err(p, "must be an object")
            continue
        name = st.get("stage")
        if not isinstance(name, str) or name not in STAGES:
            r.err(f"{p}.stage", "must be one of " + ", ".join(STAGE_ORDER))
        else:
            if name in named:
                r.warn(f"{p}.stage", f"{name!r} appears twice; one cell per stage")
            named.append(name)
        _req(r, st, "text", p)
        _sourced(r, st, p)
    missing = [s for s in STAGE_ORDER if s not in named]
    if stages and missing:
        r.warn("path.stages", "missing stage(s): " + ", ".join(missing))
    loops = _list(r, path_obj.get("loops"), "path.loops")
    for i, lp in enumerate(loops):
        p = f"path.loops[{i}]"
        if not isinstance(lp, dict):
            r.err(p, "must be an object")
            continue
        _req(r, lp, "name", p)
        _req(r, lp, "text", p)
        if lp.get("since") is not None and not is_date(lp.get("since")):
            r.err(f"{p}.since", "must be YYYY-MM or YYYY-MM-DD")
    if len(loops) > 2:
        r.warn("path.loops", f"{len(loops)} loops; name the 1-2 dominant ones")


def _next(r: Report, items):
    """Optional "next": [{text, evidence, url?}] = what they are scaling next."""
    if items is None:
        return
    items = _list(r, items, "next")
    for i, it in enumerate(items):
        p = f"next[{i}]"
        if not isinstance(it, dict):
            r.err(p, "must be an object")
            continue
        _req(r, it, "text", p)
        _sourced(r, it, p)
    if len(items) > 5:
        r.warn("next", f"{len(items)} items; keep the list short (3-5)")


def _visual(r: Report, base, v, p):
    if v is None:
        return
    if not isinstance(v, dict):
        r.err(p, "must be an object")
        return
    t = v.get("type")
    if not isinstance(t, str) or t not in VISUAL_TYPES:
        r.err(f"{p}.type", f"must be one of {', '.join(sorted(VISUAL_TYPES))}")
        return
    if t == "post":
        for k in ("platform", "author", "handle", "avatar", "text", "highlight", "url"):
            _opt_str(r, v, k, p)
        # media / media_alt: one string, or a list of strings (a carousel)
        for k in ("media", "media_alt"):
            mv = v.get(k)
            if isinstance(mv, list):
                if k == "media" and not mv:
                    r.err(f"{p}.media", "an empty list; leave media out instead")
                for j, x in enumerate(mv):
                    if not isinstance(x, str) or (k == "media" and not x):
                        r.err(f"{p}.{k}[{j}]", "must be a non-empty string" if k == "media" else "must be a string")
                    elif k == "media":
                        _image(r, base, x, f"{p}.media[{j}]")
            elif mv is not None and not isinstance(mv, str):
                r.err(f"{p}.{k}", "must be a string or a list of strings")
        text = v.get("text") if isinstance(v.get("text"), str) else ""
        hl = v.get("highlight")
        if isinstance(hl, str) and hl and hl not in text:
            r.err(f"{p}.highlight", "must be a substring of text")
        if v.get("date") is not None and not is_date(v.get("date")):
            r.err(f"{p}.date", "must be YYYY-MM or YYYY-MM-DD")
        for k in ("avatar", "media"):
            if isinstance(v.get(k), str):
                _image(r, base, v.get(k), f"{p}.{k}")
        m = v.get("metrics")
        if m is not None and not isinstance(m, dict):
            r.err(f"{p}.metrics", "must be an object")
        elif isinstance(m, dict):
            for k, mv in m.items():
                if mv is not None and not isinstance(mv, str) and not is_num(mv):
                    r.err(f"{p}.metrics.{k}", "must be a finite number or a string")
    elif t == "ads":
        for k in ("quote", "network"):
            _opt_str(r, v, k, p)
        ims = _list(r, v.get("images"), f"{p}.images")
        if not 1 <= len(ims) <= 4:
            r.warn(f"{p}.images", "show 2-4 creatives")
        for j, im in enumerate(ims):
            if not isinstance(im, dict) or not isinstance(im.get("src"), str) or not im["src"]:
                r.err(f"{p}.images[{j}].src", "required")
                continue
            for k in ("alt", "caption"):
                _opt_str(r, im, k, f"{p}.images[{j}]")
            _image(r, base, im["src"], f"{p}.images[{j}].src")
            if not im.get("alt"):
                r.warn(f"{p}.images[{j}].alt", "add alt text")
    elif t == "badge":
        if not isinstance(v.get("brand"), str) or not v["brand"]:
            r.err(f"{p}.brand", "required")
        for k in ("badge_text", "brand_icon", "note"):
            _opt_str(r, v, k, p)
        if isinstance(v.get("brand_icon"), str) and v["brand_icon"] and looks_like_image_path("icon", v["brand_icon"]):
            _image(r, base, v["brand_icon"], f"{p}.brand_icon")
        for j, w in enumerate(_list(r, v.get("windows"), f"{p}.windows")):
            if not isinstance(w, dict):
                r.err(f"{p}.windows[{j}]", "must be an object with host (and optional src)")
                continue
            for k in ("host", "src"):
                _opt_str(r, w, k, f"{p}.windows[{j}]")
            if w.get("src"):
                _image(r, base, w["src"], f"{p}.windows[{j}].src")
    elif t == "links":
        rows = _list(r, v.get("rows"), f"{p}.rows")
        if not rows:
            r.err(f"{p}.rows", "needs at least one row")
        for j, row in enumerate(rows):
            if not isinstance(row, dict) or not isinstance(row.get("domain"), str) or not row["domain"]:
                r.err(f"{p}.rows[{j}].domain", "required")
                continue
            for k in ("param", "value", "url"):
                _opt_str(r, row, k, f"{p}.rows[{j}]")
    elif t == "ai_answer":
        for k in ("engine", "question", "target"):
            _opt_str(r, v, k, p)
        ranked = _list(r, v.get("ranked"), f"{p}.ranked")
        if not ranked:
            r.err(f"{p}.ranked", "needs at least one name")
        names = []
        for j, x in enumerate(ranked):
            if not isinstance(x, dict) or not isinstance(x.get("name"), str) or not x["name"].strip():
                r.err(f"{p}.ranked[{j}]", 'must be an object with a non-empty name ({"name": "…"})')
                continue
            names.append(x["name"])
            _opt_str(r, x, "icon", f"{p}.ranked[{j}]")
            if isinstance(x.get("icon"), str) and x["icon"] and looks_like_image_path("icon", x["icon"]):
                _image(r, base, x["icon"], f"{p}.ranked[{j}].icon")
        tgt = v.get("target")
        if isinstance(tgt, str) and tgt and tgt not in names:
            r.warn(f"{p}.target", f"{tgt!r} is not in the ranked list")
        for j, u in enumerate(_list(r, v.get("pages"), f"{p}.pages")):
            if not isinstance(u, str):
                r.err(f"{p}.pages[{j}]", "must be a URL string")
    elif t == "image":
        if not isinstance(v.get("src"), str) or not v["src"]:
            r.err(f"{p}.src", "required")
        else:
            _image(r, base, v["src"], f"{p}.src")
        if not isinstance(v.get("alt"), str) or not v["alt"]:
            r.err(f"{p}.alt", "required")
    elif t == "stat":
        val = v.get("value")
        if val in (None, "") or not (isinstance(val, str) or is_num(val)):
            r.err(f"{p}.value", "required (a string or a finite number)")
        _opt_str(r, v, "label", p)
        _opt_str(r, v, "kicker", p)
        bar = v.get("bar")
        if bar is not None and not isinstance(bar, dict):
            r.err(f"{p}.bar", 'must be an object like {"value": 0.42, "max": 1}')
        elif isinstance(bar, dict):
            for k in ("value", "max"):
                if not is_num(bar.get(k)):
                    r.err(f"{p}.bar.{k}", "required, a finite number")
            if is_num(bar.get("max")) and bar["max"] <= 0:
                r.err(f"{p}.bar.max", "must be > 0")
            if is_num(bar.get("value")) and bar["value"] < 0:
                r.err(f"{p}.bar.value", "must be >= 0")
            for k in ("min_label", "max_label"):
                _opt_str(r, bar, k, f"{p}.bar")


def counts(data) -> str:
    lanes = data.get("lanes") or []
    moves = sum(len(l.get("moves") or []) for l in lanes if isinstance(l, dict))
    chans = data.get("channels") or []
    cards = sum(len(c.get("cards") or []) for c in chans if isinstance(c, dict))
    chart = data.get("chart") or {}
    plays = len((data.get("plays") or {}).get("items") or [])
    out = (f"{len(chart.get('series') or [])} series, {len(chart.get('annotations') or [])} annotations, "
           f"{len(chart.get('windows') or [])} windows, {len(lanes)} lanes, {moves} moves, {len(chans)} channels, "
           f"{cards} cards, {plays} plays")
    path = data.get("path") if isinstance(data.get("path"), dict) else {}
    if path.get("stages"):
        out += f", {len(path['stages'])} path stages, {len(path.get('loops') or [])} loops"
    if isinstance(data.get("next"), list) and data["next"]:
        out += f", {len(data['next'])} next"
    if data.get("mode") == "content":
        out += " (content mode)"
    return out


def print_report(rep: Report, strict: bool, data) -> int:
    errs = rep.errors(strict)
    for level, path, msg in rep.items:
        if level == "WARN" and not strict:
            print(f"WARN {path}: {msg}", file=sys.stderr)
        elif level == "NOTE":
            print(f"NOTE {path}: {msg}", file=sys.stderr)
    if errs:
        for level, path, msg in errs:
            print(f"ERROR {path}: {msg}", file=sys.stderr)
        print(f"{len(errs)} problem(s)", file=sys.stderr)
        return 1
    print(f"OK {counts(data)}" + (f" ({len(rep.warnings())} warning(s))" if rep.warnings() else ""))
    return 0


# --------------------------------------------------------------------------------------------
# render

_SVG_DIM_RE = re.compile(r"<svg\b[^>]*>", re.S)


def _svg_attr(tag: str, name: str):
    m = re.search(r"\s" + name + r"\s*=\s*[\"']([^\"']*)[\"']", tag)
    return m.group(1) if m else None


def image_size(path: Path):
    """(width, height) of a local SVG/PNG/GIF/JPEG/WebP file, or None. Header-only, no decoding."""
    try:
        ext = path.suffix.lower()
        if ext == ".svg":
            m = _SVG_DIM_RE.search(path.read_text(encoding="utf-8", errors="replace")[:4096])
            if not m:
                return None
            tag = m.group(0)
            vb = _svg_attr(tag, "viewBox")
            if vb:
                parts = [float(x) for x in re.split(r"[\s,]+", vb.strip()) if x]
                if len(parts) == 4 and parts[2] > 0 and parts[3] > 0:
                    return parts[2], parts[3]
            w, h = _svg_attr(tag, "width"), _svg_attr(tag, "height")
            if w and h:
                w, h = float(re.sub(r"px$", "", w)), float(re.sub(r"px$", "", h))
                return (w, h) if w > 0 and h > 0 else None
            return None
        with open(path, "rb") as fh:
            head = fh.read(64 * 1024)
        if head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR":
            return int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")
        if head[:6] in (b"GIF87a", b"GIF89a"):
            return int.from_bytes(head[6:8], "little"), int.from_bytes(head[8:10], "little")
        if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            kind = head[12:16]
            if kind == b"VP8X":
                return 1 + int.from_bytes(head[24:27], "little"), 1 + int.from_bytes(head[27:30], "little")
            if kind == b"VP8 ":
                return int.from_bytes(head[26:28], "little") & 0x3FFF, int.from_bytes(head[28:30], "little") & 0x3FFF
            if kind == b"VP8L":
                b = int.from_bytes(head[21:25], "little")
                return (b & 0x3FFF) + 1, ((b >> 14) & 0x3FFF) + 1
            return None
        if head[:2] == b"\xff\xd8":
            i = 2
            while i + 9 < len(head):
                if head[i] != 0xFF:
                    i += 1
                    continue
                marker = head[i + 1]
                if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                    i += 2
                    continue
                seg = int.from_bytes(head[i + 2:i + 4], "big")
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    return int.from_bytes(head[i + 7:i + 9], "big"), int.from_bytes(head[i + 5:i + 7], "big")
                i += 2 + seg
        return None
    except (OSError, ValueError):
        return None


def _rewrite(node, json_dir: Path, out_dir: Path, inline: bool, max_bytes: int, notes: list[str], key=None):
    if isinstance(node, dict):
        out = {k: _rewrite(v, json_dir, out_dir, inline, max_bytes, notes, k) for k, v in node.items()}
        # intrinsic size of each local image, so the page can reserve its box before it loads
        for k, v in node.items():
            if (k in IMAGE_KEYS and f"{k}_size" not in node and isinstance(v, str) and is_local_ref(v)
                    and looks_like_image_path(k, v)):
                size = image_size(json_dir / v)
                if size and all(math.isfinite(x) and x > 0 for x in size):
                    out[f"{k}_size"] = [round(size[0], 2), round(size[1], 2)]
        return out
    if isinstance(node, list):
        return [_rewrite(v, json_dir, out_dir, inline, max_bytes, notes, key) for v in node]
    if not isinstance(node, str):
        return node
    is_img = key in IMAGE_KEYS and looks_like_image_path(key, node)
    if not is_img and key not in LINK_KEYS:
        # markdown-lite text: rebase relative [label](target) links the same way as `url` keys
        if "](" not in node:
            return node
        return MD_FULL_LINK_RE.sub(lambda m: f"[{m.group(1)}]({_rebase(m.group(2), json_dir, out_dir)})", node)
    if not is_local_ref(node):
        return node
    src = (json_dir / node).resolve()
    if is_img and inline and src.suffix.lower() in IMAGE_EXT and src.is_file():
        size = src.stat().st_size
        if size > max_bytes:
            notes.append(f"WARN not inlined (over {max_bytes // 1024} KB): {node}")
        else:
            mime = MIME[src.suffix.lower()]
            return f"data:{mime};base64," + base64.b64encode(src.read_bytes()).decode("ascii")
    rel = os.path.relpath(src, out_dir.resolve())
    return Path(rel).as_posix()


def _rebase(target: str, json_dir: Path, out_dir: Path) -> str:
    """A json-relative link target made relative to the output file's directory (others unchanged)."""
    if not is_local_ref(target):
        return target
    path, sep, frag = target.partition("#")
    if not path:
        return target
    rel = os.path.relpath((json_dir / path).resolve(), out_dir.resolve())
    return Path(rel).as_posix() + sep + frag


def embed(data) -> str:
    """JSON for a <script type=application/json> block: <, > and & escaped so text can't close it.
    NaN/Infinity raise ValueError (they are not JSON and would blank the page)."""
    s = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    s = s.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return s.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


REMOTE_FONT_LINK = re.compile(
    r'[ \t]*<link\b[^>]*\bhref="https://fonts\.(?:googleapis|gstatic)\.com[^"]*"[^>]*>\s*\n?', re.I)
REMOTE_TAG = re.compile(r'<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)="(?:https?:)?//', re.I)
IMAGE_KEYS = {"src", "avatar", "media", "logo", "icon", "brand_icon"}


def _remote_images(node, path="$"):
    """Yield (json_path, url) for every image field that still points at the network."""
    if isinstance(node, dict):
        for k, v in node.items():
            p = f"{path}.{k}"
            vals = v if isinstance(v, list) else [v]
            if k in IMAGE_KEYS:
                for i, u in enumerate(vals):
                    if isinstance(u, str) and re.match(r"(?:https?:)?//", u, re.I):
                        yield (p if len(vals) == 1 and not isinstance(v, list) else f"{p}[{i}]"), u
            if isinstance(v, (dict, list)):
                yield from _remote_images(v, p)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _remote_images(v, f"{path}[{i}]")


def render_html(data, json_dir: Path, out_path: Path, inline_images=False, max_image_kb=400,
                template: Path = TEMPLATE, offline: bool = False) -> tuple[str, list[str]]:
    notes: list[str] = []
    data = _rewrite(data, json_dir, out_path.parent, inline_images, max_image_kb * 1024, notes)
    tpl = template.read_text(encoding="utf-8")
    if offline:
        # Sandboxed viewers (strict CSP) block every remote load: drop the web-font links
        # (the system font fallbacks are designed for this) and refuse remote images.
        tpl = REMOTE_FONT_LINK.sub("", tpl)
        remote = list(_remote_images(data))
        if remote:
            raise ValueError("--offline: remote images would be blocked: " + ", ".join(
                f"{p} = {u}" for p, u in remote[:5]) + (" …" if len(remote) > 5 else "")
                + " (download them next to blueprint.json and use relative paths)")
        if REMOTE_TAG.search(tpl):
            raise ValueError("--offline: the template still loads a remote resource")
    if tpl.count(SLOT) != 1:
        raise SystemExit(f"template {template} must contain the data slot exactly once")
    html = tpl.replace(SLOT, SLOT[:-len("</script>")] + embed(data) + "</script>", 1)
    company = data.get("company") if isinstance(data.get("company"), dict) else {}
    title = default_title(data)
    title = str(title).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    html = html.replace("<title>Growth blueprint</title>", f"<title>{title}</title>", 1)
    return html, notes


def cmd_render(args) -> int:
    src = Path(args.blueprint)
    data = _load_or_die(src)
    rep = validate(data, src.parent)
    if rep.errors(False):
        print_report(rep, False, data)
        print("render aborted: fix the errors above", file=sys.stderr)
        return 1
    for level, path, msg in rep.warnings() + rep.notes():
        print(f"{level} {path}: {msg}", file=sys.stderr)
    out = Path(args.out)
    try:
        html, notes = render_html(data, src.parent, out, args.inline_images, args.max_image_kb,
                                  offline=getattr(args, "offline", False))
    except ValueError as e:  # e.g. a non-finite number that slipped past validation
        print(f"ERROR $: cannot embed the blueprint: {e}", file=sys.stderr)
        print("render aborted: fix the errors above", file=sys.stderr)
        return 1
    for n in notes:
        print(n, file=sys.stderr)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out} ({len(html.encode('utf-8')) // 1024} KB)")
    return 0


def _load_or_die(path: Path):
    try:
        return load_json(path)
    except FileNotFoundError:
        print(f"ERROR $: file not found: {path}", file=sys.stderr)
        raise SystemExit(1)
    except json.JSONDecodeError as e:
        print(f"ERROR $: invalid JSON in {path}: {e}", file=sys.stderr)
        raise SystemExit(1)


# --------------------------------------------------------------------------------------------
# markdown

MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def fmt_date(s) -> str:
    if not isinstance(s, str) or not is_date(s):
        return str(s or "")
    y, m = int(s[:4]), int(s[5:7])
    return (f"{int(s[8:10])} " if len(s) == 10 else "") + f"{MON[m - 1]} {y}"


def fmt_num(n) -> str:
    if not isinstance(n, (int, float)):
        return str(n)
    if float(n).is_integer():
        return f"{int(n):,}"
    return f"{n:,.2f}"


def money(n) -> str:
    """$0.58, $0.105, $0.001, $12.00, $1,250: up to 4 decimals, trailing zeros trimmed, at least 2."""
    if not isinstance(n, (int, float)):
        return ""
    if n >= 100:
        return f"${n:,.0f}"
    s = f"{n:.4f}".rstrip("0")
    whole, _, frac = s.partition(".")
    return f"${whole}.{frac.ljust(2, '0')}"


def cell(s) -> str:
    return str(s if s is not None else "").replace("|", "\\|").replace("\n", " ")


def fence_for(text: str) -> str:
    longest = max([len(m) for m in re.findall(r"`{3,}", text)] or [2])
    return "`" * max(3, longest + 1)


def default_title(data) -> str:
    c = data.get("company") if isinstance(data.get("company"), dict) else {}
    kind = "content report" if data.get("mode") == "content" else "growth blueprint"
    return data.get("title") or f"{c.get('name', 'Company')}'s {kind}"


def _stage_rank(name) -> int:
    return STAGE_ORDER.index(name) if name in STAGE_ORDER else len(STAGE_ORDER)


def to_markdown(data) -> str:
    c = data.get("company") or {}
    title = default_title(data)
    per = data.get("period") or {}
    L: list[str] = [f"# {title}", ""]
    if data.get("example"):
        L += ["> Example data: fictional company. Every number below is synthetic.", ""]
    meta = [f"{fmt_date(per.get('start'))} → {fmt_date(per.get('end'))}"]
    if c.get("domain"):
        meta.insert(0, f"`{c['domain']}`")
    if data.get("pulled_through"):
        meta.append(f"every number pulled through {data['pulled_through']}"
                    + (f", {money(data['cost_usd'])} of data" if data.get("cost_usd") is not None else ""))
    if data.get("as_of"):
        meta.append(f"as of {fmt_date(data['as_of'])}")
    L += [" · ".join(meta), ""]

    chart = data.get("chart") or {}
    L += ["## The curve", ""]
    for s in chart.get("series") or []:
        L += [f"### {s.get('label', s.get('id'))}" + (f" ({s['sublabel']})" if s.get("sublabel") else ""), ""]
        src = s.get("source") or {}
        if src.get("label"):
            L += [f"Source: {src['label']}" + (f", {fmt_date(src.get('date'))}" if src.get("date") else "")
                  + (f" ({src['url']})" if src.get("url") else ""), ""]
        L += ["| Month | Value |", "|---|---:|"]
        for p in sorted(s.get("points") or [], key=lambda p: p.get("month", "")):
            L.append(f"| {fmt_date(p.get('month'))}{' (partial)' if p.get('partial') else ''} | {fmt_num(p.get('value'))} |")
        L.append("")
        if s.get("leaves_out"):
            L += [f"Leaves out: {s['leaves_out']}", ""]
    if chart.get("annotations"):
        L += ["**Annotations**", ""]
        for a in sorted(chart["annotations"], key=lambda a: a.get("date", "")):
            link = f" ([source]({a['url']}))" if a.get("url") else ""
            L.append(f"- {fmt_date(a.get('date'))}: **{a.get('text', '')}**"
                     + (f", {a['detail']}" if a.get("detail") else "") + f" [{a.get('evidence', '')}]{link}")
        L.append("")
    if chart.get("windows"):
        L += ["**Fastest stretch**", ""]
        for w in chart["windows"]:
            L.append(f"- {fmt_date(w.get('start'))} → {fmt_date(w.get('end'))}: {w.get('label', '')}")
        L.append("")

    moves = []
    for ln in data.get("lanes") or []:
        for mv in ln.get("moves") or []:
            moves.append((mv.get("date", ""), ln.get("label", ln.get("id")), mv))
    if moves:
        L += ["## Moves, by date", "", "| Date | Lane | Move | Evidence | Detail | Link |", "|---|---|---|---|---|---|"]
        for d, lane, mv in sorted(moves, key=lambda t: t[0]):
            label = mv.get("label", "") + (" ★" if mv.get("highlight") else "")
            link = f"[open]({mv['url']})" if mv.get("url") else ""
            L.append(f"| {fmt_date(d)} | {cell(lane)} | {cell(label)} | {mv.get('evidence', '')} | {cell(mv.get('detail', ''))} | {link} |")
        L += ["", "★ = moved with growth.", ""]

    chans = data.get("channels") or []
    if chans:
        L += ["## Channel by channel", ""]
        for ch in chans:
            L += [f"### {ch.get('label', ch.get('id'))}", ""]
            if ch.get("takeaway"):
                L += [f"→ {ch['takeaway']}", ""]
            for i, card in enumerate((ch.get("cards") or [])[:3], 1):
                L += [f"#### {i:02d} {card.get('title', '')}", ""]
                if card.get("finding"):
                    L += [card["finding"], ""]
                src = card.get("source") or {}
                bits = [b for b in (src.get("label"), fmt_date(src.get("date")) if src.get("date") else None) if b]
                srcline = " · ".join(bits)
                if src.get("url"):
                    srcline = f"[{srcline or 'source'}]({src['url']})"
                L += [f"Source: {srcline} [{card.get('evidence', '')}]", ""]
                v = card.get("visual") or {}
                if v.get("type") == "post" and v.get("text"):
                    L += ["> " + v["text"].replace("\n", "\n> "), ""]
                elif v.get("type") == "ai_answer" and v.get("ranked"):
                    L += [f"{v.get('engine', 'AI')}: “{v.get('question', '')}” → "
                          + ", ".join(f"{j}. {x.get('name')}" for j, x in enumerate(v["ranked"], 1)), ""]
                elif v.get("type") == "links" and v.get("rows"):
                    L += [", ".join(f"`{x.get('domain')}` {x.get('param', '')}{x.get('value', '')}" for x in v["rows"]), ""]
                elif v.get("type") == "stat":
                    L += [f"**{v.get('value')}** {v.get('label', '')}", ""]

    plays = (data.get("plays") or {}).get("items") or []
    if plays:
        L += ["## Copy these plays", ""]
        for i, p in enumerate(plays, 1):
            L += [f"### {i}. {p.get('title', '')}", ""]
            meta = [f"{k}: {p[f]}" for k, f in (("Stage", "stage"), ("Effort", "effort"),
                                                  ("First result", "first_result"), ("Watch", "metric")) if p.get(f)]
            if meta:
                L += [" · ".join(meta), ""]
            for e in p.get("evidence") or []:
                L.append(f"- **{e.get('kind', '')}** {e.get('text', '')}")
            if p.get("evidence"):
                L.append("")
            if p.get("prompt"):
                f = fence_for(p["prompt"])
                L += [f"{f}text", p["prompt"], f, ""]

    path = data.get("path") if isinstance(data.get("path"), dict) else {}
    stages = sorted(path.get("stages") or [], key=lambda s: _stage_rank(s.get("stage")))
    if stages or path.get("loops"):
        L += ["## The path", ""]
        if stages:
            L += ["| Stage | What happens | Evidence |", "|---|---|---|"]
            for s in stages:
                ev = s.get("evidence", "") + (f" [source]({s['url']})" if s.get("url") else "")
                L.append(f"| {cell(s.get('stage', ''))} | {cell(s.get('text', ''))} | {cell(ev)} |")
            L.append("")
        if path.get("loops"):
            L += ["**Dominant loops**", ""]
            for lp in path["loops"]:
                since = f" (since {fmt_date(lp['since'])})" if lp.get("since") else ""
                L.append(f"- **{lp.get('name', '')}**{since}: {lp.get('text', '')}")
            L.append("")

    nxt = data.get("next") if isinstance(data.get("next"), list) else []
    if nxt:
        L += ["## What they are scaling next", ""]
        for it in nxt:
            link = f" ([source]({it['url']}))" if it.get("url") else ""
            L.append(f"- **{it.get('evidence', '')}** {it.get('text', '')}{link}")
        L.append("")

    if data.get("skip"):
        L += ["## Things to skip", ""]
        for s in data["skip"]:
            L.append(f"- **{s.get('title', '')}**: {s.get('why', '')}")
        L.append("")

    calls = data.get("calls") or {}
    if calls.get("items"):
        L += ["## What it cost", "", "| Step | Endpoints | Calls | Cost |", "|---|---|---:|---:|"]
        total_calls = 0
        for it in calls["items"]:
            eps = it.get("endpoints") or []
            n = sum(int(e.get("calls") or 0) for e in eps)
            total_calls += n
            ep_list = ", ".join("`" + str(e.get("id", "")) + "`" for e in eps)
            L.append(f"| {cell(it.get('label', ''))} | {ep_list} | {n} | {money(it.get('cost_usd'))} |")
        total = calls.get("total_usd", sum(float(i.get("cost_usd") or 0) for i in calls["items"]))
        L += [f"| **Total** | | {total_calls} | **{money(total)}** |", ""]
        if calls.get("footnote"):
            L += [calls["footnote"], ""]

    if data.get("method"):
        L += ["## How this was made", ""]
        for m in data["method"]:
            L += [m, ""]
    L += ["---", "", f"Not affiliated with {c.get('name', 'this company')}. Public data only.", ""]
    return "\n".join(L)


def cmd_md(args) -> int:
    src = Path(args.blueprint)
    data = _load_or_die(src)
    rep = validate(data, src.parent)
    if rep.errors(False):
        print_report(rep, False, data)
        return 1
    text = to_markdown(data)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        sys.stdout.write(text)
    return 0


# --------------------------------------------------------------------------------------------
# scaffold

TRUTHY = {"1", "true", "yes", "y", "partial", "t"}


def _csv_rows(path: Path) -> list[dict]:
    with open(path, newline="", encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


def read_traffic(path: Path) -> list[dict]:
    """CSV month,value[,partial] (a header row is skipped) -> sorted chart points."""
    with open(path, newline="", encoding="utf-8-sig") as fh:
        rows = [r for r in csv.reader(fh) if r and any(x.strip() for x in r)]
    pts = []
    for row in rows:
        m = row[0].strip()
        if not is_month(m):
            continue  # header or junk
        try:
            v = float(row[1])
        except (IndexError, ValueError):
            continue
        if not math.isfinite(v):
            continue
        v = round(v, 4)  # drop float noise such as 982.0000000000001
        p = {"month": m, "value": int(v) if v.is_integer() else v}
        if len(row) > 2 and row[2].strip().lower() in TRUTHY:
            p["partial"] = True
        pts.append(p)
    return sorted(pts, key=lambda p: p["month"])


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "lane"


def _num(text):
    try:
        v = float(str(text).strip())
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def lift_detail(row: dict) -> str:
    """'lift +12.3 pp, placebo p 0.08' from a moves-vs-growth row (empty when neither is present)."""
    bits = []
    lift = _num(row.get("lift_pp"))
    if lift is not None:
        bits.append(f"lift {lift:+.1f} pp")
    pv = _num(row.get("placebo_p"))
    if pv is not None:
        bits.append("placebo p <0.01" if 0 < pv < 0.01 else f"placebo p {pv:.2f}")
    return ", ".join(bits)


def read_moves(path: Path) -> list[dict]:
    """moves.csv or analyze.py's moves-vs-growth.csv -> lanes of moves.

    Columns: date, channel, label, platform, url, evidence, detail, highlight, and optionally
    lift_pp / placebo_p (copied into detail) and most_views (a top post: highlighted, "Most views")."""
    lanes: dict[str, dict] = {}
    for row in _csv_rows(path):
        row = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
        if not row.get("date"):
            continue
        ch = row.get("channel") or "other"
        lid = slugify(ch)
        if lid not in lanes:
            lanes[lid] = {"id": lid, "label": LANE_LABELS.get(lid, ch.replace("_", " ").capitalize())}
            if lid in LANE_NOTES:
                lanes[lid]["note"] = LANE_NOTES[lid]
            lanes[lid]["moves"] = []
        lane = lanes[lid]
        ev = row.get("evidence", "").upper()
        mv = {"date": row["date"][:10], "label": row.get("label") or "TODO label",
              "platform": row.get("platform") or "web", "url": row.get("url", ""),
              "evidence": ev if ev in EVIDENCE else "INFERRED"}
        most = row.get("most_views", "").lower() in TRUTHY
        own = (row.get("detail") or "").strip()
        if most:  # analyze.py moves already prefixes "Most views · "; say it once
            own = re.sub(r"^\s*Most views\s*(?:·|;|:|-)?\s*", "", own)
        own = own.rstrip(" .;")
        detail = [d for d in ("Most views" if most else "", own, lift_detail(row)) if d]
        if detail:
            mv["detail"] = (" · " if most else "; ").join(detail[:2]) + ("; " + detail[2] if len(detail) > 2 else "")
        if row.get("highlight", "").lower() in TRUTHY or most:
            mv["highlight"] = True
        lane["moves"].append(mv)
    for lane in lanes.values():
        lane["moves"].sort(key=lambda m: m["date"])
    return list(lanes.values())


def step_label(step) -> str:
    """A bare SKILL.md step number ("3") -> "3 · Traffic and peers"; anything else unchanged."""
    s = str(step).strip()
    if re.fullmatch(r"\d{1,2}", s):
        n = int(s)
        return f"{n} · {STEP_LABELS[n]}" if n in STEP_LABELS else f"Step {n}"
    return s


def read_calls(path: Path) -> dict:
    steps: dict[str, dict] = {}
    with open(path, encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                raise SystemExit(f"ERROR {path}:{n}: not JSON")
            step = str(rec.get("step") if rec.get("step") is not None else "other")
            st = steps.setdefault(step, {"label": step_label(step), "endpoints": {}, "cost_usd": 0.0})
            ep = st["endpoints"].setdefault(str(rec.get("endpoint") or "?"), {"id": str(rec.get("endpoint") or "?"), "calls": 0, "cost_usd": 0.0})
            ep["calls"] += int(rec.get("calls") or 1)
            cost = float(rec.get("cost_usd") or 0)
            ep["cost_usd"] += cost
            st["cost_usd"] += cost
    items = []
    for st in steps.values():
        eps = [dict(e, cost_usd=round(e["cost_usd"], 6)) for e in st["endpoints"].values()]
        items.append({"label": st["label"], "endpoints": eps, "cost_usd": round(st["cost_usd"], 6)})
    return {"total_usd": round(sum(i["cost_usd"] for i in items), 6), "items": items}


def read_costs(path: Path) -> dict:
    """costs.json from `analyze.py costs` -> {items, footnote, spent}. spent is the balance difference
    (the bill) when both balances were given, else None."""
    data = load_json(path)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: not a costs.json object")
    items = []
    for it in data.get("items") or []:
        if not isinstance(it, dict):
            continue
        eps = [{"id": str(e.get("id", "?")), "calls": int(e.get("calls") or 0), "cost_usd": float(e.get("cost_usd") or 0)}
               for e in it.get("endpoints") or [] if isinstance(e, dict)]
        items.append({"label": step_label(it.get("label", "other")), "endpoints": eps,
                      "cost_usd": round(float(it.get("cost_usd") or 0), 6)})
    bal = data.get("balance") if isinstance(data.get("balance"), dict) else {}
    spent = _num(bal.get("spent")) if bal else None
    foot = data.get("footnote") if isinstance(data.get("footnote"), str) else ""
    return {"items": items, "footnote": foot.strip(), "spent": None if spent is None else round(spent, 6)}


EXTRA_SUBLABEL = "a month"
# a field separator is a colon NOT followed by whitespace and not escaped: "Searches for: acme" stays one label
_EXTRA_SPLIT_RE = re.compile(r"(?<!\\):(?!\s)")


def parse_extra_series(spec: str) -> tuple[str, str, str, str, str | None]:
    """CSV:ID:LABEL[:SUBLABEL[:UNIT]] -> (csv, id, label, sublabel, unit or None).

    A colon followed by a space ("Searches for: acme") is part of the text, as is an escaped one
    ("ratio 1\\:2"); every other colon separates fields. SUBLABEL defaults to "a month"."""
    parts = [p.replace("\\:", ":").strip() for p in _EXTRA_SPLIT_RE.split(spec)]
    usage = "expected CSV:ID:LABEL[:SUBLABEL[:UNIT]] (write \\: for a colon inside a field)"
    if not 3 <= len(parts) <= 5 or not all(parts[:3]):
        raise ValueError(f"--extra-series {spec!r}: {usage}")
    csv_path, sid, label = parts[:3]
    sublabel = parts[3] if len(parts) > 3 and parts[3] else EXTRA_SUBLABEL
    unit = parts[4] if len(parts) > 4 and parts[4] else None
    return csv_path, sid, label, sublabel, unit


DEFAULT_PULLED_THROUGH = "treg"
DEFAULT_SERIES_UNIT = "visits"
DEFAULT_SOURCE_LABEL = "DataForSEO historical rank overview"


def scaffold(company, domain, start, end, traffic=None, inflection=None, moves=None, calls=None, today=None,
             costs=None, series_id="google", series_label="Google visits", series_sublabel="a month, US est.",
             extra_series=None, source_url=None, source_date=None, pulled_through=DEFAULT_PULLED_THROUGH,
             series_unit=DEFAULT_SERIES_UNIT, source_label=DEFAULT_SOURCE_LABEL) -> dict:
    """extra_series items: (csv, id, label) or (csv, id, label, sublabel[, unit])."""
    pts = read_traffic(Path(traffic)) if traffic else []
    src = {"label": source_label,
           "url": source_url if source_url is not None else (str(traffic) if traffic else "")}
    if source_date:
        src["date"] = source_date
    series = [{"id": series_id, "label": series_label, "sublabel": series_sublabel, "unit": series_unit,
               "source": src, "points": pts}]
    for spec in extra_series or []:
        csv_path, sid, label = spec[:3]
        sublabel = spec[3] if len(spec) > 3 and spec[3] else EXTRA_SUBLABEL
        unit = spec[4] if len(spec) > 4 else None
        s = {"id": sid, "label": label, "sublabel": sublabel}
        if unit:
            s["unit"] = unit
        s["points"] = read_traffic(Path(csv_path))
        series.append(s)
    data = {
        "schema": SCHEMA,
        "company": {"name": company, "domain": domain},
        "period": {"start": start, "end": end},
        "pulled_through": pulled_through,
        "example": domain.lower().endswith(".example"),
        "chart": {
            "default": series_id,
            "series": series,
            "annotations": [],
            "windows": [],
        },
        "lanes": read_moves(Path(moves)) if moves else [],
        "channels": [],
        "plays": {"show": 3, "items": []},
        "skip": [],
        "method": ["TODO: say what is SEEN vs INFERRED and the date every count was pulled."],
    }
    if today:
        data["as_of"] = today
    if inflection:
        inf = load_json(Path(inflection))
        w = inf.get("window") if isinstance(inf, dict) else None
        if isinstance(w, dict) and w.get("start") and w.get("end"):
            data["chart"]["windows"].append({"start": w["start"], "end": w["end"],
                                             "label": w.get("label") or "TODO label", "series": series_id})
    if calls:
        data["calls"] = read_calls(Path(calls))
        data["cost_usd"] = data["calls"]["total_usd"]
    if costs:
        c = read_costs(Path(costs))
        if "calls" not in data:  # no ledger given: the cost table comes from costs.json
            data["calls"] = {"total_usd": round(sum(i["cost_usd"] for i in c["items"]), 6), "items": c["items"]}
            data["cost_usd"] = data["calls"]["total_usd"]
        if c["footnote"]:
            data["calls"]["footnote"] = c["footnote"]
        if c["spent"] is not None:
            data["cost_usd"] = c["spent"]  # the bill is the balance difference; calls.total_usd stays the ledger sum
    # Widen the period so every point, move and window sits inside it (validate refuses strays).
    months = [p["month"] for s in series for p in s["points"] if isinstance(p, dict) and p.get("month")]
    months += [m["date"][:7] for lane in data["lanes"] for m in lane["moves"] if m.get("date")]
    months += [w[k] for w in data["chart"]["windows"] for k in ("start", "end")]
    months = [m for m in months if re.fullmatch(r"\d{4}-\d{2}", str(m))]
    if months:
        data["period"] = {"start": min([start] + months), "end": max([end] + months)}
    return data


def cmd_scaffold(args) -> int:
    for s in args.period:
        if not is_month(s):
            print(f"ERROR period: {s!r} must be YYYY-MM", file=sys.stderr)
            return 2
    if args.source_date and not is_date(args.source_date):
        print(f"ERROR --source-date: {args.source_date!r} must be YYYY-MM or YYYY-MM-DD", file=sys.stderr)
        return 2
    extra = []
    ids = {args.series_id}
    for spec in args.extra_series or []:
        try:
            parsed = parse_extra_series(spec)
        except ValueError as e:
            print(f"ERROR {e}", file=sys.stderr)
            return 2
        sid = parsed[1]
        if sid in ids:
            print(f"ERROR --extra-series: duplicate series id {sid!r}", file=sys.stderr)
            return 2
        ids.add(sid)
        extra.append(parsed)
    for flag, val in (("--pulled-through", args.pulled_through), ("--series-unit", args.series_unit),
                      ("--source-label", args.source_label)):
        if not val.strip():
            print(f"ERROR {flag}: must not be empty", file=sys.stderr)
            return 2
    for f in (args.traffic, args.inflection, args.moves, args.calls, args.costs, *(e[0] for e in extra)):
        if f and not Path(f).is_file():
            print(f"ERROR $: file not found: {f}", file=sys.stderr)
            return 1
    try:
        data = scaffold(args.company, args.domain, args.period[0], args.period[1], args.traffic,
                        args.inflection, args.moves, args.calls, args.today, costs=args.costs,
                        series_id=args.series_id, series_label=args.series_label,
                        series_sublabel=args.series_sublabel, extra_series=extra,
                        source_url=args.source_url, source_date=args.source_date,
                        pulled_through=args.pulled_through.strip(), series_unit=args.series_unit.strip(),
                        source_label=args.source_label.strip())
    except (ValueError, OSError) as e:  # includes json.JSONDecodeError
        print(f"ERROR $: {e}", file=sys.stderr)
        return 1
    if (data["period"]["start"], data["period"]["end"]) != (args.period[0], args.period[1]):
        print(f"NOTE period widened to {data['period']['start']} .. {data['period']['end']} "
              "so every point, move and window fits", file=sys.stderr)
    out = Path(args.out) if args.out else None
    dump_json(data, out)
    rep = validate(data, out.parent if out else Path.cwd())
    n = len(rep.warnings())
    if out:
        print(f"wrote {out}; {n} TODO/warning(s) left (validate --strict lists them)", file=sys.stderr)
    return 1 if rep.errors(False) else 0


# --------------------------------------------------------------------------------------------
# CLI

def cmd_validate(args) -> int:
    src = Path(args.blueprint)
    data = _load_or_die(src)
    return print_report(validate(data, src.parent), args.strict, data)


def cmd_demo(args) -> int:
    ns = argparse.Namespace(blueprint=str(DEMO), out=args.out, inline_images=True, max_image_kb=args.max_image_kb)
    return cmd_render(ns)


PAGE_PARAMS = """\
query parameters of the rendered page (blueprint.html?...; combine with &):
  ?series=<id>  open on that chart series; annotations and windows bound to a series
                ("series": "<id>") are drawn only while it is shown
  ?tab=<n>      open channel tab n (0-based)
  ?theme=dark   force the dark (or light) theme
  ?audit=1      write a JSON layout self-check of the shown series into pre#bp-audit
                (also postMessage {bpAudit} to a parent frame)
  ?audit=all    the same for every series in turn (labels prefixed "[id] ", bySeries per series)
  ?data=<url>   load blueprint JSON from an http(s) or relative URL

layout check: Chrome --headless=new --dump-dom --virtual-time-budget=5000 "file://$PWD/blueprint.html?audit=all";
headless Chrome is at least 500px wide, so for a phone load the page in a 390px iframe and read {bpAudit}."""


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="blueprint.py", description=__doc__.splitlines()[0], epilog=PAGE_PARAMS,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("validate", help="check a blueprint.json")
    p.add_argument("blueprint")
    p.add_argument("--strict", action="store_true", help="treat warnings (incl. TODO markers) as errors")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("render", help="write the one-file HTML page", epilog=PAGE_PARAMS,
                       formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("blueprint")
    p.add_argument("-o", "--out", required=True)
    p.add_argument("--inline-images", action="store_true", help="embed local images as data URIs")
    p.add_argument("--max-image-kb", type=int, default=400)
    p.add_argument("--offline", action="store_true",
                   help="no remote loads at all (drop web-font links, refuse remote images); "
                        "for sandboxed viewers with a strict CSP. Use with --inline-images.")
    p.set_defaults(func=cmd_render)

    p = sub.add_parser("md", help="write the same content as Markdown (playbook.md)")
    p.add_argument("blueprint")
    p.add_argument("-o", "--out")
    p.set_defaults(func=cmd_md)

    p = sub.add_parser("scaffold", help="build a skeleton blueprint.json from analysis outputs")
    p.add_argument("--company", required=True)
    p.add_argument("--domain", required=True)
    p.add_argument("--period", nargs=2, metavar=("START", "END"), required=True)
    p.add_argument("--traffic", help="CSV month,value[,partial]")
    p.add_argument("--inflection", help="JSON from analyze.py inflection (uses its window)")
    p.add_argument("--moves", help="CSV date,channel,label,platform,url,evidence,detail,highlight"
                                    "[,lift_pp,placebo_p,most_views] (analyze.py moves --csv-out); "
                                    'channel "company" = launches, funding, hires')
    p.add_argument("--calls", help="calls ledger JSONL")
    p.add_argument("--costs", help="costs.json from analyze.py costs: adds calls.footnote and sets cost_usd "
                                   "to the balance difference (calls.total_usd stays the ledger sum)")
    p.add_argument("--series-id", default="google", help="id of the --traffic series (default: google)")
    p.add_argument("--series-label", default="Google visits", help="label of the --traffic series")
    p.add_argument("--series-sublabel", default="a month, US est.", help="sublabel of the --traffic series")
    p.add_argument("--source-url", help="source url of the --traffic series (default: the --traffic path)")
    p.add_argument("--source-date", help="YYYY-MM[-DD] the --traffic series was pulled")
    p.add_argument("--series-unit", default=DEFAULT_SERIES_UNIT,
                   help=f"unit of the --traffic series (default: {DEFAULT_SERIES_UNIT}; e.g. points, stars)")
    p.add_argument("--source-label", default=DEFAULT_SOURCE_LABEL,
                   help=f'source label of the --traffic series (default: "{DEFAULT_SOURCE_LABEL}"; '
                        'free mode: e.g. "Hacker News via Algolia")')
    p.add_argument("--pulled-through", default=DEFAULT_PULLED_THROUGH,
                   help=f'what every number was pulled through (default: "{DEFAULT_PULLED_THROUGH}"; free mode: '
                        'name the public sources, e.g. "free public sources (HN Algolia, GitHub API)")')
    p.add_argument("--extra-series", action="append", metavar="CSV:ID:LABEL[:SUBLABEL[:UNIT]]",
                   help="another chart series from a month,value[,partial] CSV (brand demand, post reach); "
                        f'SUBLABEL defaults to "{EXTRA_SUBLABEL}" (say "cumulative" for a running total); a colon '
                        "followed by a space stays in the text, \\: escapes one; repeatable")
    p.add_argument("--today", help="YYYY-MM-DD written as as_of")
    p.add_argument("-o", "--out")
    p.set_defaults(func=cmd_scaffold)

    p = sub.add_parser("demo", help="render the fictional Acme Draw example")
    p.add_argument("-o", "--out", required=True)
    p.add_argument("--max-image-kb", type=int, default=400)
    p.set_defaults(func=cmd_demo)
    return ap


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
