#!/usr/bin/env python3
"""rea-growth analysis CLI.

Subcommands: inflection, moves, moves-collect, posts, families, loops, wayback, ai, ads, trends, costs.
Python 3.10+ standard library only. Only `wayback` touches the network
(https://web.archive.org/ only) and never when --offline is given.

Exit codes: 0 ok, 1 analysis/validation error (message on stderr), 2 usage error.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from html.parser import HTMLParser
from urllib.parse import parse_qsl, quote, urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rea_math as rm  # noqa: E402


class AnalysisError(Exception):
    pass


# ----------------------------------------------------------------------------
# I/O helpers
# ----------------------------------------------------------------------------

def read_csv(path):
    try:
        with open(path, newline="", encoding="utf-8-sig") as fh:
            reader = csv.DictReader(fh)
            rows = []
            for row in reader:
                if None in row:
                    raise AnalysisError(
                        f"{path}: line {reader.line_num} has more fields than the header "
                        "(unquoted comma in a field?)")
                rows.append({(k or "").strip().lower(): (v or "").strip() for k, v in row.items()})
            return rows
    except OSError as exc:
        raise AnalysisError(f"cannot read {path}: {exc}")
    except csv.Error as exc:
        raise AnalysisError(f"{path}: malformed CSV ({exc})")


def read_json(path):
    try:
        with open(path, encoding="utf-8-sig") as fh:
            return json.load(fh)
    except OSError as exc:
        raise AnalysisError(f"cannot read {path}: {exc}")
    except json.JSONDecodeError as exc:
        raise AnalysisError(f"{path}: invalid JSON ({exc})")


def write_csv(path, columns, rows):
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=columns, extrasaction="ignore")
        w.writeheader()
        for row in rows:
            w.writerow({c: ("" if row.get(c) is None else row.get(c)) for c in columns})


def emit(obj, out):
    try:
        text = json.dumps(obj, indent=1, ensure_ascii=False, allow_nan=False) + "\n"
    except ValueError:
        raise AnalysisError("internal error: non-finite number in output")
    if out:
        parent = os.path.dirname(os.path.abspath(out))
        os.makedirs(parent, exist_ok=True)
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)


def extract_items(obj):
    """Find the items[] list in a raw DataForSEO response (or a bare list / {items: []})."""
    if isinstance(obj, list):
        return obj
    if isinstance(obj, dict):
        if isinstance(obj.get("items"), list):
            return obj["items"]
        items = []
        tasks = obj.get("tasks")
        for task in tasks if isinstance(tasks, list) else []:
            results = task.get("result") if isinstance(task, dict) else None
            for res in results if isinstance(results, list) else []:
                sub = res.get("items") if isinstance(res, dict) else None
                items.extend(sub if isinstance(sub, list) else [])
        if items:
            return items
        results = obj.get("result")
        for res in results if isinstance(results, list) else []:
            sub = res.get("items") if isinstance(res, dict) else None
            items.extend(sub if isinstance(sub, list) else [])
        return items
    return []


def load_rows(path):
    """CSV -> list of dicts; JSON -> items[]."""
    if str(path).lower().endswith(".json"):
        return extract_items(read_json(path))
    return read_csv(path)


def truthy(v):
    return str(v).strip().lower() in {"1", "true", "yes", "y", "t", "partial"}


def parse_num(v):
    """'1,234' '1.5K' '2M' -> float. Empty/invalid -> None."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    s = str(v).strip().replace(",", "").replace("_", "")
    if not s:
        return None
    mult = 1.0
    if s[-1:].lower() in "kmb":
        mult = {"k": 1e3, "m": 1e6, "b": 1e9}[s[-1].lower()]
        s = s[:-1]
    try:
        out = float(s) * mult
    except ValueError:
        return None
    return out if math.isfinite(out) else None


def parse_today(text):
    return rm.parse_day(text) if text else dt.date.today()


def r2(x, nd=2):
    return None if x is None else round(x, nd)


# ----------------------------------------------------------------------------
# Time series container
# ----------------------------------------------------------------------------

class Grid:
    """Dense monthly grid. values[i] is None for partial or missing months."""

    def __init__(self, raw, today=None):
        # raw: {(y, m): (value or None, partial bool)}
        if not raw:
            raise AnalysisError("series is empty")
        self.notes = []
        first, last = min(raw), max(raw)
        self.months = rm.month_range(first, last)
        self.raw = {}
        self.values, self.partial, self.missing = [], [], []
        cutoff = (today.year, today.month) if today else None
        for ym in self.months:
            value, part = raw.get(ym, (None, False))
            if cutoff and ym >= cutoff:
                part = True
            self.raw[ym] = value
            self.partial.append(bool(part))
            self.missing.append(ym not in raw)
            self.values.append(None if (part or value is None) else value)
        self.index = {ym: i for i, ym in enumerate(self.months)}

    def clean(self):
        return [(i, v) for i, v in enumerate(self.values) if v is not None]


def load_series(path, today=None):
    raw, notes = {}, []
    rows = read_csv(path)
    if not rows:
        raise AnalysisError(f"{path}: no data rows (header only or empty file)")
    if "month" not in rows[0]:
        raise AnalysisError(f"{path}: no 'month' column (columns: {', '.join(k for k in rows[0] if k)})")
    skipped = 0
    for r in rows:
        if not r.get("month"):
            skipped += 1
            continue
        try:
            ym = rm.parse_month(r["month"])
        except ValueError as exc:
            raise AnalysisError(f"{path}: {exc}")
        v = parse_num(r.get("value"))
        if v is not None and v < 0:
            raise AnalysisError(f"{path}: negative value {v:g} for {r['month']}")
        if ym in raw:
            notes.append(f"duplicate month {rm.month_str(ym)} in {os.path.basename(str(path))}; kept the last value")
        raw[ym] = (v, truthy(r.get("partial", "")))
    if skipped:
        notes.append(f"{skipped} row(s) skipped in {os.path.basename(str(path))}: empty month")
    if not raw:
        raise AnalysisError(f"{path}: no usable rows (every month cell is empty)")
    grid = Grid(raw, today)
    grid.notes = notes
    return grid


def load_dataforseo_series(path, today=None):
    """DataForSEO historical_rank_overview raw JSON -> (Grid over total, rows with organic/paid)."""
    items = extract_items(read_json(path))
    raw, split = {}, {}
    for it in items:
        try:
            ym = (int(it["year"]), int(it["month"]))
        except (KeyError, TypeError, ValueError):
            continue
        if not 1 <= ym[1] <= 12:
            raise AnalysisError(f"{path}: invalid month {ym[1]} in year {ym[0]}")
        if not isinstance(it, dict):
            continue
        metrics = it.get("metrics") if isinstance(it.get("metrics"), dict) else {}
        org_m = metrics.get("organic") if isinstance(metrics.get("organic"), dict) else {}
        paid_m = metrics.get("paid") if isinstance(metrics.get("paid"), dict) else {}
        org = parse_num(org_m.get("etv")) or 0.0
        paid = parse_num(paid_m.get("etv")) or 0.0
        split[ym] = (org, paid)
        raw[ym] = (org + paid, False)
    if not raw:
        raise AnalysisError(f"{path}: no items[] with year/month/metrics found")
    return Grid(raw, today), split


# ----------------------------------------------------------------------------
# 1. inflection
# ----------------------------------------------------------------------------

def peer_alignment(target, peers):
    """Index every series to its value at the first common clean month.

    Returns dict with months, target_index, peer_median_index, excess (aligned to target grid),
    or None when fewer than 3 common months.
    """
    common = []
    for i, ym in enumerate(target.months):
        if target.values[i] is None or target.values[i] <= 0:
            continue
        ok = True
        for p in peers:
            j = p.index.get(ym)
            if j is None or p.values[j] is None or p.values[j] <= 0:
                ok = False
                break
        if ok:
            common.append(ym)
    if len(common) < 3:
        return None
    base = common[0]
    t_base = target.values[target.index[base]]
    p_base = [p.values[p.index[base]] for p in peers]
    n = len(target.months)
    t_idx, p_idx, excess = [None] * n, [None] * n, [None] * n
    for ym in common:
        i = target.index[ym]
        t_idx[i] = target.values[i] / t_base
        p_idx[i] = rm.median([p.values[p.index[ym]] / b for p, b in zip(peers, p_base)])
        excess[i] = t_idx[i] / p_idx[i] if p_idx[i] else None
    return {"base_month": rm.month_str(base), "common": common, "target_index": t_idx,
            "peer_median_index": p_idx, "excess": excess}


# The headline-window rule (references/methods.md, "The inflection").
WINDOW_MIN_DATA_MONTHS = 6      # full (non-partial) months of data before any window is drawn
WINDOW_MIN_SPAN_MONTHS = 3      # the window must span this many whole months
WINDOW_BASE_FLOOR = {"attention": 1000.0, "people": 100.0}  # first-month value, by series kind


def is_cumulative(values, min_points=6):
    """True for a running total: at least `min_points` complete months, never decreasing, and rising overall."""
    clean = [v for v in values if v is not None]
    if len(clean) < min_points:
        return False
    return all(b >= a for a, b in zip(clean, clean[1:])) and clean[-1] > clean[0]


def monthly_increments(values):
    """Month-over-month differences of a cumulative series: None where either month is missing/partial."""
    out = [None] * len(values)
    for i in range(1, len(values)):
        if values[i] is not None and values[i - 1] is not None:
            out[i] = max(values[i] - values[i - 1], 0.0)
    return out


def analyze_inflection(grid, max_window=6, min_base_frac=0.01, min_seg=3, peers=None, peer_names=None,
                       split=None, penalty_ks=(1, 2, 4, 8), primary_k=2, kind="attention", cumulative=None):
    """cumulative: True = the series is a running total, False = it is not, None = auto-detect for
    kind "people" (a non-decreasing series). On a cumulative series the change-points are searched on
    the month-over-month increments (a running total always splits), while the headline window stays
    on the cumulative values."""
    if kind not in WINDOW_BASE_FLOOR:
        raise AnalysisError(f"kind must be one of {', '.join(sorted(WINDOW_BASE_FLOOR))}, not {kind!r}")
    warnings = list(getattr(grid, "notes", []))
    cum_source = "flag" if cumulative else None
    if cumulative is None and kind == "people" and is_cumulative(grid.values):
        cumulative, cum_source = True, "auto-detected (non-decreasing people series)"
    cumulative = bool(cumulative)
    g = rm.mom_growth(grid.values)
    inc = monthly_increments(grid.values) if cumulative else None
    g_cp = rm.mom_growth(inc) if cumulative else g   # growth of the series the change-points run on
    accel = [None] * len(g)
    for i in range(1, len(g)):
        if g[i] is not None and g[i - 1] is not None:
            accel[i] = g[i] - g[i - 1]
    months = []
    for i, ym in enumerate(grid.months):
        row = {"month": rm.month_str(ym), "value": r2(grid.raw[ym], 4), "partial": grid.partial[i],
               "mom": r2(g[i], 4), "acceleration": r2(accel[i], 4)}
        if split and ym in split:
            row["organic"], row["paid"] = r2(split[ym][0], 4), r2(split[ym][1], 4)
        if cumulative:
            row["increment"] = r2(inc[i], 4)
        months.append(row)

    clean = grid.clean()
    cp_clean = [(i, v) for i, v in enumerate(inc) if v is not None] if cumulative else clean
    if cumulative:
        warnings.append("cumulative series: change-points run on month-over-month increments, not the running "
                        "total; the window stays on the cumulative values")
    if len(cp_clean) < 2 * min_seg:
        warnings.append(f"only {len(cp_clean)} complete months; need {2 * min_seg} for change-point search")
    if any(grid.missing):
        warnings.append("series has missing months; change-point search skips them")
    if any(grid.partial):
        warnings.append("partial months excluded from fits: " + ", ".join(
            rm.month_str(m) for m, p in zip(grid.months, grid.partial) if p))

    logs = [math.log1p(v) for _, v in cp_clean]
    sweep = rm.penalty_sweep(logs, min_seg, penalty_ks)
    primary = next((r for r in sweep["runs"] if r["k"] == primary_k), sweep["runs"][0])
    bounds_cache = []
    cps = []
    for c in primary["changepoints"]:
        bounds_cache.append(c)
    edges = [0] + bounds_cache + [len(logs)]
    for n_, c in enumerate(bounds_cache):
        left, right = logs[edges[n_]:c], logs[c:edges[n_ + 2]]
        lm, rmean = sum(left) / len(left), sum(right) / len(right)
        gi = cp_clean[c][0]
        cps.append({
            "index": gi, "month": rm.month_str(grid.months[gi]),
            "mean_before": r2(math.expm1(lm), 2), "mean_after": r2(math.expm1(rmean), 2),
            "step_log": r2(rmean - lm, 4), "multiple": r2(math.exp(rmean - lm), 2),
            "direction": "up" if rmean > lm else "down",
            "stability": rm.stability(c, sweep["runs"]), "stability_of": len(sweep["runs"]),
        })

    ups = [c for c in cps if c["direction"] == "up"]
    inflection = None
    if ups:
        top = max(ups, key=lambda c: (c["step_log"], -c["index"]))
        inflection = {k: top[k] for k in ("index", "month", "step_log", "multiple", "stability", "stability_of")}
        gi = top["index"]
        inflection["mom_at_inflection"] = r2(g_cp[gi], 4)

    peak = None
    if clean:
        pi, pv = max(clean, key=lambda t: (t[1], -t[0]))
        peak = {"month": rm.month_str(grid.months[pi]), "value": r2(pv, 4)}
    window, window_reason = None, None
    base_floor = WINDOW_BASE_FLOOR[kind]
    if not peak:
        window_reason = "no complete month in the series"
    elif len(clean) < WINDOW_MIN_DATA_MONTHS:
        window_reason = (f"only {len(clean)} full months of data; the window rule needs "
                         f"{WINDOW_MIN_DATA_MONTHS}+")
    elif max_window < WINDOW_MIN_SPAN_MONTHS:
        window_reason = f"max window of {max_window} months is under the {WINDOW_MIN_SPAN_MONTHS}-month minimum"
    else:
        floor = max(min_base_frac * peak["value"], base_floor)
        wstats = {}
        win = rm.best_window(grid.values, max_window, floor, WINDOW_MIN_SPAN_MONTHS, sustained=True, stats=wstats)
        if win:
            window = {"start": rm.month_str(grid.months[win["start_idx"]]),
                      "end": rm.month_str(grid.months[win["end_idx"]]),
                      "start_value": r2(grid.values[win["start_idx"]], 4),
                      "end_value": r2(grid.values[win["end_idx"]], 4),
                      "multiple": r2(win["multiple"], 3), "months": win["months"], "label": win["label"]}
        else:
            window_reason = (f"no rise over {WINDOW_MIN_SPAN_MONTHS}-{max_window} whole months that starts at "
                             f">= {floor:,.0f} ({kind} series) and ends on a full month")
            if wstats.get("rejected"):
                window_reason += (f"; {wstats['rejected']} of {wstats['candidates']} candidate windows rejected as not "
                                  f"a sustained rise (a month fell below the window's first month, or the end month "
                                  f"was under {rm.SUSTAINED_END_FRAC:.0%} of the window maximum)")

    result = {
        "months": months,
        "params": {"max_window": max_window, "min_base_frac": min_base_frac, "min_seg": min_seg,
                   "penalty_ks": list(penalty_ks), "primary_k": primary_k, "kind": kind,
                   "window_base_floor": base_floor, "window_min_span": WINDOW_MIN_SPAN_MONTHS,
                   "window_min_data_months": WINDOW_MIN_DATA_MONTHS,
                   "window_sustained_end_frac": rm.SUSTAINED_END_FRAC,
                   "cumulative": cumulative, "cumulative_source": cum_source,
                   "changepoints_on": ("month-over-month increments (series is cumulative)" if cumulative
                                       else "the series values")},
        "sweep": {"sigma2": r2(sweep["sigma2"], 6), "runs": [
            {"k": r["k"], "penalty": r2(r["penalty"], 4),
             "changepoints": [rm.month_str(grid.months[cp_clean[c][0]]) for c in r["changepoints"]]}
            for r in sweep["runs"]]},
        "changepoints": cps,
        "inflection": inflection,
        "window": window,
        "window_reason": window_reason,
        "peak": peak,
        "warnings": warnings,
    }

    if peers:
        al = peer_alignment(grid, peers)
        if al is None:
            result["peers"] = None
            warnings.append("peers share fewer than 3 clean months with the target; no peer comparison")
        else:
            rows = [{"month": rm.month_str(grid.months[i]), "target_index": r2(al["target_index"][i], 4),
                     "peer_median_index": r2(al["peer_median_index"][i], 4), "excess": r2(al["excess"][i], 4)}
                    for i in range(len(grid.months)) if al["target_index"][i] is not None]
            tail = {"flag": None, "reason": "no inflection"}
            if inflection:
                gi = inflection["index"]
                ym = grid.months[gi]
                t_mom = g[gi]
                p_moms = []
                for p in peers:
                    j = p.index.get(ym)
                    if j is None:
                        continue
                    pg = rm.mom_growth(p.values)[j]
                    if pg is not None:
                        p_moms.append(pg)
                if t_mom is None or t_mom <= 0 or not p_moms:
                    tail = {"flag": None, "reason": "no month-on-month growth for target or peers at the inflection"}
                else:
                    pm = rm.median(p_moms)
                    tail = {"flag": pm >= 0.5 * t_mom, "target_mom": r2(t_mom, 4), "peer_median_mom": r2(pm, 4),
                            "reason": "peer median MoM at the inflection month is >= 50% of the target's"
                            if pm >= 0.5 * t_mom else "peers did not move like the target"}
            result["peers"] = {"names": peer_names or [], "base_month": al["base_month"],
                               "market_tailwind": tail, "months": rows}
    return result


def cmd_inflection(args):
    today = parse_today(args.today) if args.today else None
    split = None
    if args.from_dataforseo:
        grid, split = load_dataforseo_series(args.from_dataforseo, today)
        src = "dataforseo"
    elif args.traffic:
        grid, src = load_series(args.traffic, today), "csv"
    else:
        raise AnalysisError("give --traffic CSV or --from-dataforseo FILE")
    peers, names = [], []
    for p in args.peers or []:
        peers.append(load_series(p, today))
        names.append(os.path.splitext(os.path.basename(p))[0])
    if args.emit_csv:
        rows = []
        for i, ym in enumerate(grid.months):
            rows.append({"month": rm.month_str(ym), "value": grid.raw[ym], "partial": 1 if grid.partial[i] else 0,
                         "organic": (split or {}).get(ym, ("", ""))[0], "paid": (split or {}).get(ym, ("", ""))[1]})
        write_csv(args.emit_csv, ["month", "value", "partial", "organic", "paid"], rows)
    res = analyze_inflection(grid, args.max_window, args.min_base_frac, args.min_seg, peers or None, names, split,
                             kind=args.kind, cumulative=args.cumulative)
    res["source"] = src
    emit(res, args.out)


# ----------------------------------------------------------------------------
# 2. moves
# ----------------------------------------------------------------------------

MOVES_COLUMNS = ["date", "channel", "label", "platform", "url", "evidence", "detail", "highlight", "reach",
                 "month", "cluster", "before_pct", "after_pct", "lift_pp", "brand_lift_pp", "excess_lift_pp",
                 "cluster_lift_pp", "placebo_p", "n_placebo", "flags", "most_views", "credited"]

MIN_CREDIT_MONTHS = 12      # full months of traffic before any lift is credited to a move
LIFT_CAP_PP = 999.0         # displayed lift is clamped to +-this many percentage points
BASE_MAX_FRAC = 0.05        # a before-window mean under this share of the series max is "base too small"
CIRCULAR_FRAC = 0.30        # a move whose own reach is >= this share of the series value in its month is circular
FLAG_BASE_SMALL = "base too small"
FLAG_CIRCULAR = "circular"
FLAG_LIFT_CAPPED = f"lift capped at ±{LIFT_CAP_PP:g} pp"
MOST_VIEWS_N = 3
MOST_VIEWS_PREFIX = "Most views · "
UNCREDITED_WARNING = "under 12 full months: lift not credited"


def lift_row(series, idx, before, after):
    if idx is None:
        return {"ok": False, "reason": "outside_series"}
    return rm.event_lift(series, idx, before, after)


def mark_most_views(rows, n=MOST_VIEWS_N):
    """Highlight the n social moves with the highest numeric reach. Returns the marked rows."""
    cand = []
    for r in rows:
        if str(r.get("channel", "")).strip().lower() != "social":
            continue
        reach = parse_num(r.get("reach"))
        if reach is not None and reach > 0:
            cand.append((-reach, r["date"], r.get("label", ""), r))
    cand.sort(key=lambda t: t[:3])
    chosen = [t[3] for t in cand[:n]]
    for r in chosen:
        r["highlight"] = "true"
        r["most_views"] = "true"
        detail = r.get("detail") or ""
        if not detail.startswith(MOST_VIEWS_PREFIX):
            r["detail"] = MOST_VIEWS_PREFIX + detail if detail else MOST_VIEWS_PREFIX.rstrip(" ·")
    return chosen


def cap_lift(x, cap=LIFT_CAP_PP):
    """Clamp a lift (pp) to +-cap. Returns (value, was_capped)."""
    if x is None:
        return None, False
    if x > cap:
        return cap, True
    if x < -cap:
        return -cap, True
    return x, False


def analyze_moves(moves, traffic, before=2, after=2, cluster_days=30, brand=None, excess=None, placebo=False,
                  min_credit_months=MIN_CREDIT_MONTHS, kind="attention"):
    """Returns (rows, clusters).

    With fewer than `min_credit_months` full (non-partial) months of traffic no lift is credited:
    every cluster has highlight false and credited false, the per-row lift columns are blank, and the
    three social moves with the highest numeric reach are marked "Most views" instead.

    Lift guards (only when lift is creditable at all), each making a cluster credited=false and
    highlight=false, with the lift columns of its rows blank and a flag:
      - "base too small": the mean of the `before` months ahead of the cluster is under the series
        kind's floor (attention 1000, people 100) or under 5% of the series maximum. A growth rate off
        a base that small is noise (+6007 pp off a base of 9).
      - "circular": a move's own reach is >= 30% of the series value in its month, i.e. the move IS
        the metric being measured (an HN story in an HN-points series). The move is never highlighted.
    Displayed lifts are clamped to +-999 pp and flagged "lift capped at ±999 pp"; the uncapped value
    stays in the cluster's lift_pp_uncapped. Ranking and placebo p-values use the uncapped value.
    """
    if kind not in WINDOW_BASE_FLOOR:
        raise AnalysisError(f"kind must be one of {', '.join(sorted(WINDOW_BASE_FLOOR))}, not {kind!r}")
    n = len(traffic.months)
    credited = len(traffic.clean()) >= min_credit_months
    clean_vals = [v for v in traffic.values if v is not None]
    base_floor = max(WINDOW_BASE_FLOOR[kind], BASE_MAX_FRAC * max(clean_vals)) if clean_vals else WINDOW_BASE_FLOOR[kind]
    series = {"traffic": traffic.values}
    if brand is not None:
        series["brand"] = [brand.values[brand.index[ym]] if ym in brand.index else None for ym in traffic.months]
    if excess is not None:
        series["excess"] = excess
    dates = [rm.parse_day(m["date"]) for m in moves]
    cids = rm.cluster_dates(dates, cluster_days)

    rows = []
    for m, d, cid in zip(moves, dates, cids):
        ym = (d.year, d.month)
        idx = traffic.index.get(ym)
        flags = []
        row = dict(m)
        row.update({"month": rm.month_str(ym), "cluster": cid})
        for name, vals in series.items():
            res = lift_row(vals, idx, before, after)
            if res["ok"]:
                if name == "traffic":
                    row["before_pct"], row["after_pct"] = r2(res["before_pct"]), r2(res["after_pct"])
                    row["lift_pp"] = r2(res["lift_pp"])
                else:
                    row[f"{name}_lift_pp"] = r2(res["lift_pp"])
            else:
                flags.append(f"{name}:{res['reason']}")
        reach, level = parse_num(m.get("reach")), traffic.raw.get(ym)
        if credited and reach and level and reach >= CIRCULAR_FRAC * level:
            flags.append(FLAG_CIRCULAR)
        row["flags"] = ";".join(flags)
        rows.append(row)

    # cluster level
    clusters = []
    for cid in sorted(set(cids)):
        members = [r for r, c in zip(rows, cids) if c == cid]
        mdates = sorted(rm.parse_day(r["date"]) for r in members)
        first = mdates[0]
        idx = traffic.index.get((first.year, first.month))
        res = lift_row(series["traffic"], idx, before, after)
        cl = {"cluster": cid, "start": mdates[0].isoformat(), "end": mdates[-1].isoformat(),
              "n_moves": len(members), "channels": sorted({r.get("channel", "") for r in members}),
              "labels": [r.get("label", "") for r in members], "month": rm.month_str((first.year, first.month)),
              "lift_pp": None, "before_pct": None, "after_pct": None, "placebo_p": None, "n_placebo": 0,
              "flags": [], "highlight": False, "base_mean": None}
        if credited and any(FLAG_CIRCULAR in r["flags"].split(";") for r in members):
            cl["flags"].append(FLAG_CIRCULAR)
        extra = {}
        for name in ("brand", "excess"):
            if name in series:
                e = lift_row(series[name], idx, before, after)
                extra[name] = r2(e["lift_pp"]) if e["ok"] else None
        cl["brand_lift_pp"], cl["excess_lift_pp"] = extra.get("brand"), extra.get("excess")
        if res["ok"]:
            cl["lift_pp"] = r2(res["lift_pp"])
            cl["before_pct"], cl["after_pct"] = r2(res["before_pct"]), r2(res["after_pct"])
            base = rm.mean(traffic.values[idx - before:idx])
            cl["base_mean"] = r2(base)
            if credited and base < base_floor:
                cl["flags"].append(FLAG_BASE_SMALL)
            if placebo:
                pl = []
                for j in range(n):
                    if j == idx:
                        continue
                    pr = rm.event_lift(series["traffic"], j, before, after)
                    if pr["ok"]:
                        pl.append(pr["lift_pp"])
                cl["n_placebo"] = len(pl)
                if pl:
                    cl["placebo_p"] = r2(rm.placebo_p(res["lift_pp"], pl), 4)
                else:
                    cl["flags"].append("no_placebo_months")
        else:
            cl["flags"].append(f"traffic:{res['reason']}")
        clusters.append(cl)

    for c in clusters:
        c["credited"] = credited and FLAG_BASE_SMALL not in c["flags"] and FLAG_CIRCULAR not in c["flags"]
    elig = [c for c in clusters if c["credited"] and c["placebo_p"] is not None and c["placebo_p"] <= 0.2
            and c["lift_pp"] is not None and c["lift_pp"] > 0]
    elig.sort(key=lambda c: (-c["lift_pp"], c["start"]))
    top = {c["cluster"] for c in elig[:3]}
    by_id = {c["cluster"]: c for c in clusters}
    for c in clusters:
        c["highlight"] = c["cluster"] in top
    for r in rows:
        c = by_id[r["cluster"]]
        r["cluster_lift_pp"], r["placebo_p"], r["n_placebo"] = c["lift_pp"], c["placebo_p"], c["n_placebo"]
        r["highlight"] = "true" if c["highlight"] and FLAG_CIRCULAR not in r["flags"].split(";") else "false"
        r["most_views"] = "false"
        r["credited"] = "true" if c["credited"] else "false"
        if not c["credited"]:  # numbers stay in the cluster summary; no row carries a lift it may not claim
            r["lift_pp"] = r["cluster_lift_pp"] = r["placebo_p"] = None
            if credited and FLAG_BASE_SMALL in c["flags"]:
                r["flags"] = ";".join(f for f in (r["flags"], FLAG_BASE_SMALL) if f)
    # display cap: clamp every lift column, keep the true value where a summary holds it
    for c in clusters:
        c["lift_pp_uncapped"] = c["lift_pp"]
        for key in ("lift_pp", "brand_lift_pp", "excess_lift_pp"):
            c[key], hit = cap_lift(c[key])
            if hit and FLAG_LIFT_CAPPED not in c["flags"]:
                c["flags"].append(FLAG_LIFT_CAPPED)
    for r in rows:
        for key in ("lift_pp", "cluster_lift_pp", "brand_lift_pp", "excess_lift_pp"):
            if r.get(key) is not None:
                r[key], hit = cap_lift(r[key])
                if hit and FLAG_LIFT_CAPPED not in r["flags"].split(";"):
                    r["flags"] = ";".join(f for f in (r["flags"], FLAG_LIFT_CAPPED) if f)
    if not credited:
        mark_most_views(rows)
    rank = sorted([c for c in clusters if c["lift_pp"] is not None], key=lambda c: -c["lift_pp_uncapped"])
    for i, c in enumerate(rank, 1):
        c["lift_rank"] = i
    rows.sort(key=lambda r: (r["date"], r.get("label", "")))
    return rows, clusters


def channel_correlation(moves, traffic, max_lag=2, min_months=12, min_moves=5):
    growth = rm.mom_growth(traffic.values)
    n = len(growth)
    n_growth = sum(1 for g in growth if g is not None)
    by_channel = defaultdict(lambda: [0] * n)
    totals = Counter()
    for m in moves:
        d = rm.parse_day(m["date"])
        i = traffic.index.get((d.year, d.month))
        ch = m.get("channel") or "(none)"
        totals[ch] += 1
        totals["(all moves)"] += 1
        if i is not None:
            by_channel[ch][i] += 1
            by_channel["(all moves)"][i] += 1
    out = {}
    for ch in sorted(totals):
        if n_growth < min_months:
            out[ch] = {"moves": totals[ch], "lags": None,
                       "reason": f"fewer than {min_months} months of growth data ({n_growth})"}
            continue
        if totals[ch] < min_moves:
            out[ch] = {"moves": totals[ch], "lags": None, "reason": f"fewer than {min_moves} moves ({totals[ch]})"}
            continue
        lags = {}
        for lag in range(max_lag + 1):
            xs, ys = [], []
            for i in range(n - lag):
                if growth[i + lag] is not None:
                    xs.append(by_channel[ch][i])
                    ys.append(growth[i + lag])
            rho = rm.spearman(xs, ys)
            lags[str(lag)] = {"rho": r2(rho, 4), "n": len(xs),
                              **({} if rho is not None else {"reason": "no variation in counts or growth"})}
        out[ch] = {"moves": totals[ch], "lags": lags, "reason": None}
    return out


def cmd_moves(args):
    today = parse_today(args.today) if args.today else None
    traffic = load_series(args.traffic, today)
    moves = read_csv(args.moves)
    if not moves:
        raise AnalysisError(f"{args.moves}: no rows")
    for i, m in enumerate(moves, 2):
        try:
            rm.parse_day(m.get("date", ""))
        except ValueError as exc:
            raise AnalysisError(f"{args.moves} line {i}: {exc}")
    brand = load_series(args.brand_demand, today) if args.brand_demand else None
    excess = None
    warnings = list(traffic.notes)
    if args.peers:
        peers = [load_series(p, today) for p in args.peers]
        al = peer_alignment(traffic, peers)
        if al is None:
            warnings.append("peers share fewer than 3 clean months with the target; excess growth skipped")
        else:
            excess = al["excess"]
    rows, clusters = analyze_moves(moves, traffic, args.before, args.after, args.cluster_days, brand, excess,
                                   args.placebo, kind=args.kind)
    credited = len(traffic.clean()) >= MIN_CREDIT_MONTHS
    if not credited:
        warnings.append(UNCREDITED_WARNING)
    elif not args.placebo:
        warnings.append("--placebo not set: no placebo p-values, so no highlights")
    write_csv(args.csv_out, MOVES_COLUMNS, rows)
    summary = {
        "params": {"before": args.before, "after": args.after, "cluster_days": args.cluster_days,
                   "placebo": bool(args.placebo), "kind": args.kind,
                   "base_floor": WINDOW_BASE_FLOOR[args.kind], "base_max_frac": BASE_MAX_FRAC,
                   "circular_frac": CIRCULAR_FRAC, "lift_cap_pp": LIFT_CAP_PP},
        "n_moves": len(rows), "n_clusters": len(clusters), "csv": args.csv_out,
        "credited": credited, "n_full_months": len(traffic.clean()),
        "most_views": sorted(({"date": r["date"], "label": r.get("label", ""), "reach": parse_num(r.get("reach"))}
                              for r in rows if r.get("most_views") == "true"),
                             key=lambda m: (-m["reach"], m["date"], m["label"])),
        "clusters": clusters,
        "highlight_clusters": [c["cluster"] for c in clusters if c["highlight"]],
        "channels": channel_correlation(moves, traffic),
        "warnings": warnings,
    }
    emit(summary, args.out)


# ----------------------------------------------------------------------------
# 3. posts
# ----------------------------------------------------------------------------

def engagement_for(row, channel):
    """Return (engagement or None, metric label)."""
    def num(k):
        return parse_num(row.get(k))
    if channel in ("x", "youtube", "tiktok"):
        return num("views"), "views"
    if channel == "instagram":
        likes, comments = num("likes"), num("comments")
        if likes is None and comments is None:
            return None, "likes+comments"
        return (likes or 0.0) + (comments or 0.0), "likes+comments"
    if channel == "linkedin":
        return num("reactions"), "reactions"
    if channel == "reddit":
        return num("score"), "score"
    return None, "?"


def resolve_metric(rows, channel):
    """Pick the engagement column for a channel. Returns (fallback column or None, label, warnings)."""
    warnings = []
    header = set()
    for r in rows:
        header.update(r.keys())
    primary_cols = {"x": ["views"], "youtube": ["views"], "tiktok": ["views"], "instagram": ["likes", "comments"],
                    "linkedin": ["reactions"], "reddit": ["score"]}[channel]
    metric = None
    if not any(c in header for c in primary_cols):
        for fb in ("views", "likes", "score"):
            if fb in header:
                metric = fb
                warnings.append(f"no {'/'.join(primary_cols)} column for {channel}; fell back to '{fb}'")
                break
        if metric is None:
            raise AnalysisError(f"no engagement column found for {channel} (looked for {primary_cols} and views/likes/score)")
    label = metric or {"x": "views", "youtube": "views", "tiktok": "views", "instagram": "likes+comments",
                       "linkedin": "reactions", "reddit": "score"}[channel]
    return metric, label, warnings


def monthly_reach(rows, channel, today):
    """Monthly sum of the channel engagement metric over ALL posts, settled or not.

    Returns (rows [{month, value, partial}], label, warnings). Months with no posts between the first and
    last post count as 0. The current month (and any later one) is partial.
    """
    metric, label, warnings = resolve_metric(rows, channel)
    sums, bad = defaultdict(float), 0
    for r in rows:
        try:
            d = rm.parse_day(r.get("date", ""))
        except ValueError:
            bad += 1
            continue
        eng = parse_num(r.get(metric)) if metric else engagement_for(r, channel)[0]
        if eng is None:
            bad += 1
            continue
        sums[(d.year, d.month)] += eng
    if bad:
        warnings.append(f"{bad} rows skipped in the monthly sum (bad date or no engagement value)")
    if not sums:
        raise AnalysisError("no post has a usable date and engagement value; nothing to sum by month")
    cutoff = (today.year, today.month)
    out = []
    for ym in rm.month_range(min(sums), max(sums)):
        out.append({"month": rm.month_str(ym), "value": round(sums.get(ym, 0.0), 4),
                    "partial": 1 if ym >= cutoff else 0})
    return out, label, warnings


def analyze_posts(rows, channel, today, settle_days=7, min_posts=20):
    if not rows:
        raise AnalysisError("posts file has no data rows (header only or empty)")
    metric, label, warnings = resolve_metric(rows, channel)
    posts, dropped_young, dropped_bad = [], 0, 0
    for r in rows:
        try:
            d = rm.parse_day(r.get("date", ""))
        except ValueError:
            dropped_bad += 1
            continue
        eng = parse_num(r.get(metric)) if metric else engagement_for(r, channel)[0]
        if eng is None:
            dropped_bad += 1
            continue
        age = (today - d).days
        if age < settle_days:
            dropped_young += 1
            continue
        posts.append({"id": r.get("id", ""), "date": d.isoformat(), "url": r.get("url", ""),
                      "engagement": eng, "age_days": age})
    if dropped_bad:
        warnings.append(f"{dropped_bad} rows skipped (bad date or no engagement value)")
    out = {"channel": channel, "metric": label, "today": today.isoformat(), "settle_days": settle_days,
           "n_rows": len(rows), "n_settled": len(posts), "dropped_young": dropped_young, "warnings": warnings}
    if not posts:
        out.update({"pattern": "too few posts to call a pattern", "posts": [], "median": None, "mad": None})
        return out
    engs = [p["engagement"] for p in posts]
    med, md = rm.median(engs), rm.mad(engs)
    order = sorted(range(len(posts)), key=lambda i: (-posts[i]["engagement"], posts[i]["date"], posts[i]["id"]))
    for rank, i in enumerate(order, 1):
        posts[i]["rank"] = rank
    for p in posts:
        p["per_day"] = p["engagement"] / max(p["age_days"], 1)
        p["multiple"] = (p["engagement"] / med) if med else None
        p["robust_z"] = rm.robust_z(p["engagement"], med, md)
        if med:
            p["outlier"] = bool(p["multiple"] is not None and p["multiple"] >= 3)
        else:
            p["outlier"] = p["engagement"] > 0  # median 0: any positive post stands out
    pd_order = sorted(range(len(posts)), key=lambda i: (-posts[i]["per_day"], posts[i]["id"]))
    for rank, i in enumerate(pd_order, 1):
        posts[i]["per_day_rank"] = rank
    n = len(posts)
    enough = n >= min_posts
    top_n, bottom_n = math.ceil(n / 4), n // 2
    for p in posts:
        if not enough:
            p["tier"] = None
        elif p["rank"] <= top_n:
            p["tier"] = "top"
        elif p["rank"] > n - bottom_n:
            p["tier"] = "bottom"
        else:
            p["tier"] = "middle"
    tied = max(engs) == min(engs)
    if tied:
        for p in posts:
            p["tier"] = None
        warnings.append("all engagement values are equal; tiers not assigned")
    posts.sort(key=lambda p: p["rank"])
    for p in posts:
        for k in ("engagement", "per_day", "multiple", "robust_z"):
            p[k] = r2(p[k], 3)
    out.update({"median": r2(med, 2), "mad": r2(md, 2), "posts": posts})
    if not enough:
        out["pattern"] = "too few posts to call a pattern"
    elif tied:
        out["pattern"] = "all settled posts have the same engagement; no pattern"
        out["n_outliers"] = 0
        out["tier_counts"] = {"top": 0, "middle": 0, "bottom": 0}
    else:
        outliers = sum(1 for p in posts if p["outlier"])
        top_med = rm.median([p["engagement"] for p in posts if p["tier"] == "top"])
        bot_med = rm.median([p["engagement"] for p in posts if p["tier"] == "bottom"])
        ratio = (top_med / bot_med) if bot_med else None
        if med:
            rule = f">= 3x the channel median of {r2(med, 1)} {label}"
        else:
            rule = f"any post above the channel median of 0 {label}; the 3x multiple is undefined"
        out["pattern"] = (f"{outliers} of {n} settled posts are outliers ({rule}); top-quarter median is "
                          f"{'n/a' if ratio is None else format(ratio, '.1f') + 'x'} the bottom-half median")
        out["n_outliers"] = outliers
        out["tier_counts"] = {t: sum(1 for p in posts if p["tier"] == t) for t in ("top", "middle", "bottom")}
    return out


def cmd_posts(args):
    rows = read_csv(args.posts)
    today = parse_today(args.today)
    res = analyze_posts(rows, args.channel, today, args.settle_days)
    if args.emit_monthly:
        monthly, label, notes = monthly_reach(rows, args.channel, today)
        write_csv(args.emit_monthly, ["month", "value", "partial"], monthly)
        res["monthly_csv"] = args.emit_monthly
        res["monthly_metric"] = label
        res["warnings"].extend(n for n in notes if n not in res["warnings"])
    emit(res, args.out)


# ----------------------------------------------------------------------------
# 4. families
# ----------------------------------------------------------------------------

LANGS = set("en es fr de it pt nl ru ja ko zh ar tr pl sv da no nb fi cs el he hi id th vi uk ro hu bg hr sk sl sr "
            "lt lv et ms fa bn ta te ur ca eu gl".split())


def locale_of(seg):
    s = seg.lower().replace("_", "-")
    parts = s.split("-")
    if parts[0] not in LANGS or len(parts) > 2:
        return None
    if len(parts) == 2 and not re.fullmatch(r"[a-z]{2}|[a-z]{4}|\d{3}", parts[1]):
        return None
    return s


# Language codes that are also ordinary path words; trusted only when another locale mirrors the page.
AMBIGUOUS_LANGS = {"id", "no", "it", "te", "hi", "he", "ca", "et", "el", "sl", "sr", "ur", "ta", "ms", "th", "bn"}


def url_path(u):
    u = u.strip()
    if not u:
        return None
    if "//" in u:
        path = urlsplit(u).path
    elif u.startswith("/"):
        path = urlsplit("x://h" + u).path
    else:
        first = u.split("/")[0]
        path = urlsplit("//" + u).path if "." in first else urlsplit("x://h/" + u).path
    return path or "/"


def split_locale(path):
    segs = [s for s in path.split("/") if s]
    loc = None
    if segs:
        loc = locale_of(segs[0])
        if loc:
            segs = segs[1:]
    return loc, "/" + "/".join(segs)


def load_urls(path):
    try:
        with open(path, encoding="utf-8-sig") as fh:
            text = fh.read()
    except OSError as exc:
        raise AnalysisError(f"cannot read {path}: {exc}")
    warnings = []
    if text.lstrip().startswith("<"):
        try:
            root = ET.fromstring(text)
        except ET.ParseError as exc:
            raise AnalysisError(f"{path}: invalid XML ({exc})")
        if root.tag.endswith("sitemapindex"):
            warnings.append("file is a sitemap index: its <loc> entries are child sitemaps, not pages")
        urls = []
        for entry in root:  # only <url><loc> / <sitemap><loc>; image:loc and video:* children are not pages
            if entry.tag.split("}")[-1] in ("url", "sitemap"):
                urls.extend((c.text or "").strip() for c in entry if c.tag.split("}")[-1] == "loc")
    else:
        urls = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    return [u for u in urls if u], warnings


VS_RE = re.compile(r"-vs-|-versus-|alternative", re.I)


def family_of(path):
    segs = [s for s in path.split("/") if s]
    return segs[0] if segs else "/"


def analyze_families(urls, min_family=3, pseo_min=50, keywords=None, brands=None):
    locales = Counter()
    fam_paths = defaultdict(list)
    vs_total = 0
    parsed = []
    mirrors = defaultdict(set)  # stripped remainder -> locale prefixes seen with it
    for u in urls:
        p = url_path(u)
        if p is None:
            continue
        loc, bare = split_locale(p)
        parsed.append((p, loc, bare))
        if loc:
            mirrors[bare].add(loc)
    for p, loc, bare in parsed:
        if loc in AMBIGUOUS_LANGS and not (mirrors[bare] - {loc}):
            loc, bare = None, p  # '/id/1000' is a path family, not Indonesian
        if loc:
            locales[loc] += 1
        fam_paths[family_of(bare)].append(bare)
        if VS_RE.search(bare):
            vs_total += 1
    total = sum(len(v) for v in fam_paths.values())
    families, misc = [], {"count": 0, "families": 0, "examples": []}
    big = {f for f, v in fam_paths.items() if len(v) >= min_family}
    for fam, paths in sorted(fam_paths.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        if fam not in big:
            misc["count"] += len(paths)
            misc["families"] += 1
            if len(misc["examples"]) < 10:
                misc["examples"].append(paths[0])
            continue
        tpls = rm.url_template(paths)
        families.append({
            "family": fam, "count": len(paths), "share": r2(len(paths) / total, 4) if total else None,
            "templates": [{"template": t["template"], "count": t["count"], "examples": t["paths"][:3]}
                          for t in tpls[:20]],
            "pseo": any(t["count"] >= pseo_min for t in tpls),
            "pseo_templates": [t["template"] for t in tpls if t["count"] >= pseo_min],
            "vs_pages": sum(1 for p in paths if VS_RE.search(p)),
        })
    out = {"total_urls": total, "locales": dict(sorted(locales.items())), "families": families, "misc": misc,
           "pseo_families": [f["family"] for f in families if f["pseo"]], "vs_pages_total": vs_total,
           "params": {"min_family": min_family, "pseo_min": pseo_min}}
    if keywords is not None:
        out["keywords"] = family_keywords(keywords, [f["family"] for f in families], brands or [])
    return out


def load_keywords(path):
    """DataForSEO ranked_keywords raw JSON or CSV keyword,url,position,etv,volume -> list of dicts."""
    out = []
    if str(path).lower().endswith(".json"):
        for it in extract_items(read_json(path)):
            kd = it.get("keyword_data") or {}
            serp = (it.get("ranked_serp_element") or {}).get("serp_item") or {}
            kw = kd.get("keyword") or it.get("keyword")
            if not kw:
                continue
            url = serp.get("url") or serp.get("relative_url") or it.get("url") or ""
            out.append({"keyword": kw, "url": url,
                        "position": parse_num(serp.get("rank_absolute", serp.get("rank_group", it.get("position")))),
                        "etv": parse_num(serp.get("etv", it.get("etv"))) or 0.0,
                        "volume": parse_num((kd.get("keyword_info") or {}).get("search_volume", it.get("volume")))})
    else:
        for r in read_csv(path):
            if r.get("keyword"):
                out.append({"keyword": r["keyword"], "url": r.get("url", ""), "position": parse_num(r.get("position")),
                            "etv": parse_num(r.get("etv")) or 0.0, "volume": parse_num(r.get("volume"))})
    return out


def family_keywords(kws, families, brands):
    fam_set = set(families)
    per = defaultdict(list)
    for k in kws:
        p = url_path(k["url"]) if k["url"] else None
        fam = "(unmapped)"
        if p is not None:
            _, bare = split_locale(p)
            f = family_of(bare)
            fam = f if f in fam_set else "(other)"
        per[fam].append(k)
    total_etv = sum(k["etv"] for k in kws) or 0.0
    terms = [b.lower() for b in brands]

    def is_brand(k):
        kw = k["keyword"].lower()
        return any(t in kw for t in terms)
    rows = []
    for fam, items in per.items():
        etv = sum(k["etv"] for k in items)
        top = sorted(items, key=lambda k: (-k["etv"], k["keyword"]))[:5]
        rows.append({"family": fam, "keywords": len(items), "etv": r2(etv, 2),
                     "etv_share": r2(etv / total_etv, 4) if total_etv else None,
                     "top_keywords": [{"keyword": k["keyword"], "etv": r2(k["etv"], 2), "position": k["position"],
                                       "url": k["url"]} for k in top]})
    rows.sort(key=lambda r: (-(r["etv"] or 0), r["family"]))
    brand_etv = sum(k["etv"] for k in kws if is_brand(k))
    res = {"total_keywords": len(kws), "total_etv": r2(total_etv, 2), "families": rows}
    if terms:
        res["brand"] = {"terms": brands, "brand_etv": r2(brand_etv, 2), "non_brand_etv": r2(total_etv - brand_etv, 2),
                        "brand_share": r2(brand_etv / total_etv, 4) if total_etv else None,
                        "non_brand_share": r2(1 - brand_etv / total_etv, 4) if total_etv else None,
                        "brand_keywords": sum(1 for k in kws if is_brand(k))}
    return res


def cmd_families(args):
    urls, warnings = load_urls(args.urls)
    kws = load_keywords(args.keywords) if args.keywords else None
    res = analyze_families(urls, args.min_family, args.pseo_min, kws, args.brand)
    res["warnings"] = warnings
    emit(res, args.out)


# ----------------------------------------------------------------------------
# 5. loops
# ----------------------------------------------------------------------------

AFFILIATE_PARAMS = ("via", "ref", "aff", "affiliate", "fpr", "partner", "rfsn", "irclickid")


def analyze_anchors(rows, brand):
    anchors = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        text = r.get("anchor")
        if text is None:
            continue
        anchors.append({
            "anchor": text, "class": rm.classify_anchor(text, brand),
            "referring_domains": int(parse_num(r.get("referring_domains")) or 0),
            "backlinks": int(parse_num(r.get("backlinks")) or 0),
            "first_seen": str(r.get("first_seen") or "")[:10] or None,
            **({"url": str(r.get("url") or r.get("url_from") or "")} if (r.get("url") or r.get("url_from")) else {})})
    anchors.sort(key=lambda a: (-a["referring_domains"], a["anchor"]))
    summary = {}
    for a in anchors:
        s = summary.setdefault(a["class"], {"anchors": 0, "referring_domains": 0, "backlinks": 0})
        s["anchors"] += 1
        s["referring_domains"] += a["referring_domains"]
        s["backlinks"] += a["backlinks"]
    loops = [a for a in anchors if a["class"] == "badge"]
    return {"by_class": summary, "loops": loops, "anchors": anchors}


def host_of(u):
    s = str(u or "")
    if "//" not in s:
        s = "//" + s
    return (urlsplit(s).hostname or "").lower()


def analyze_referrers(rows):
    params = defaultdict(lambda: {"domains": set(), "pairs": Counter()})
    scanned = 0
    for r in rows:
        if not isinstance(r, dict):
            continue
        url_to, url_from = str(r.get("url_to") or ""), r.get("url_from") or ""
        if not url_to:
            continue
        scanned += 1
        q = parse_qsl(urlsplit(url_to if "//" in url_to else "//x" + (url_to if url_to.startswith("/") else "/" + url_to)).query,
                      keep_blank_values=True)
        dom = host_of(url_from)
        if dom.startswith("www."):
            dom = dom[4:]
        for k, v in q:
            kl = k.lower()
            name = None
            if kl in AFFILIATE_PARAMS:
                name = kl
            elif kl == "utm_medium" and v.lower() == "affiliate":
                name = "utm_medium=affiliate"
            if name and dom:
                params[name]["domains"].add(dom)
                params[name]["pairs"][(dom, v)] += 1
    out = {}
    for name, d in sorted(params.items(), key=lambda kv: -len(kv[1]["domains"])):
        out[name] = {"referring_domains": len(d["domains"]),
                     "top": [{"domain": dom, "value": val, "count": c}
                             for (dom, val), c in sorted(d["pairs"].items(), key=lambda kv: (-kv[1], kv[0]))[:10]]}
    return {"rows_scanned": scanned, "params": out}


_PS_FIRST = {"co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go"}


def _is_public_suffix(suffix):
    """Tiny heuristic for two-label public suffixes such as co.uk / com.au; single labels count too."""
    parts = suffix.split(".")
    return len(parts) < 2 or (len(parts) == 2 and parts[0] in _PS_FIRST and len(parts[1]) == 2)


def analyze_subdomains(obj):
    hosts = []
    if isinstance(obj, dict) and isinstance(obj.get("subdomains"), list):
        obj = obj["subdomains"]
    for it in extract_items(obj) if not (isinstance(obj, list) and obj and isinstance(obj[0], str)) else obj:
        if not isinstance(it, (str, dict)):
            continue
        h = it if isinstance(it, str) else (it.get("subdomain") or it.get("host") or it.get("domain") or "")
        h = host_of(h)
        if h:
            hosts.append(h)
    hosts = sorted(set(hosts))
    suffix_hosts = defaultdict(set)  # candidate parent suffix -> hosts strictly below it
    for h in hosts:
        parts = h.split(".")
        for i in range(1, len(parts) - 1):
            suf = ".".join(parts[i:])
            if not _is_public_suffix(suf):
                suffix_hosts[suf].add(h)
    parents = defaultdict(list)
    for h in hosts:
        parts = h.split(".")
        cands = [".".join(parts[i:]) for i in range(1, len(parts) - 1)]
        cands = [c for c in cands if c in suffix_hosts]
        if cands:  # most shared suffix wins; ties go to the longest (most specific)
            best = max(cands, key=lambda c: (len(suffix_hosts[c]), len(c)))
            parents[best].append(h)
    groups = sorted(parents.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    top = groups[0] if groups else None
    return {"count": len(hosts), "user_content_parent": top[0] if top else None,
            "user_content_hosts": len(top[1]) if top else 0,
            "parents": [{"parent": p, "count": len(v), "examples": v[:3]} for p, v in groups[:5]]}


def cmd_loops(args):
    out = {"anchors": None, "referrers": None, "subdomains": None}
    out["anchors"] = analyze_anchors(load_rows(args.anchors), args.brand)
    if args.referrers:
        out["referrers"] = analyze_referrers(load_rows(args.referrers))
    if args.subdomains:
        out["subdomains"] = analyze_subdomains(read_json(args.subdomains))
    emit(out, args.out)


# ----------------------------------------------------------------------------
# 6. wayback
# ----------------------------------------------------------------------------

WB_UA = "rea-growth/2 (+public research)"
CDX_BASE = "https://web.archive.org/cdx/search/cdx"
KNOWN_PLANS = {"free", "starter", "basic", "pro", "plus", "team", "teams", "business", "enterprise", "premium",
               "growth", "scale", "standard", "hobby", "creator", "max", "personal", "individual", "essential",
               "advanced", "studio"}


def slugify(text):
    return re.sub(r"[^A-Za-z0-9]+", "_", text).strip("_")


def cdx_cache_path(cache, url, year_from, year_to, every):
    return os.path.join(cache, f"cdx_{slugify(url)}_{year_from or 'any'}_{year_to or 'any'}_{every}.json")


def snap_cache_path(cache, ts, original):
    return os.path.join(cache, f"snap_{ts}_{slugify(original)}.html")


def cdx_query_url(url, year_from=None, year_to=None, every="month"):
    params = [("url", url), ("output", "json"), ("filter", "statuscode:200"), ("fl", "timestamp,original,digest")]
    if every == "month":
        params.append(("collapse", "timestamp:6"))
    elif every == "week":
        params.append(("collapse", "timestamp:8"))
    else:
        params.append(("collapse", "digest"))
    if year_from:
        params.append(("from", str(year_from)))
    if year_to:
        params.append(("to", str(year_to)))
    return CDX_BASE + "?" + "&".join(f"{k}={quote(v, safe=':,')}" for k, v in params)


def http_get(url, retries=3, timeout=45):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": WB_UA})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
            if body[:2] == b"\x1f\x8b":  # Wayback id_ captures keep the original gzip Content-Encoding
                try:
                    body = gzip.decompress(body)
                except (OSError, EOFError):
                    pass
            return body
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            last = exc
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
    raise AnalysisError(f"fetch failed after {retries} tries: {url} ({last})")


def rows_from_cdx(data):
    if not data:
        return []
    if (not isinstance(data, list) or not isinstance(data[0], list)
            or not all(isinstance(r, list) for r in data[1:])):
        raise AnalysisError("CDX response is not a [header, rows...] list (rate limited or error body?)")
    header, body = data[0], data[1:]
    rows = [dict(zip(header, row)) for row in body]
    if rows and "timestamp" not in rows[0]:
        raise AnalysisError("CDX response has no 'timestamp' column")
    return rows


def sample_rows(rows, every, max_n):
    rows = sorted(rows, key=lambda r: r["timestamp"])
    kept, seen = [], set()
    for r in rows:
        ts = r["timestamp"]
        if every == "month":
            key = ts[:6]
        elif every == "week":
            d = dt.date(int(ts[:4]), int(ts[4:6]), int(ts[6:8])).isocalendar()
            key = (d[0], d[1])
        else:
            key = None
        if key is not None:
            if key in seen:
                continue
            seen.add(key)
        elif kept and kept[-1].get("digest") == r.get("digest"):
            continue
        kept.append(r)
    if len(kept) > max_n > 0:
        if max_n == 1:
            return kept[:1]
        idx = sorted({round(i * (len(kept) - 1) / (max_n - 1)) for i in range(max_n)})
        kept = [kept[i] for i in idx]
    return kept


class _PageParser(HTMLParser):
    HARD_SKIP = {"script", "style", "noscript", "svg", "template"}
    TEXT_SKIP = {"nav"}
    BLOCK = {"p", "div", "li", "ul", "ol", "section", "article", "header", "footer", "main", "br", "tr", "td", "th",
             "table", "h1", "h2", "h3", "h4", "h5", "h6", "a", "button", "span_break", "form", "label"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hard = 0
        self.nav = 0
        self.parts = []
        self.ctas = []
        self.headings = []
        self._cta = None
        self._cta_depth = 0
        self._head = None

    def handle_starttag(self, tag, attrs):
        if tag in self.HARD_SKIP:
            self.hard += 1
        elif tag in self.TEXT_SKIP:
            self.nav += 1
        if tag in self.BLOCK:
            self.parts.append(" ")
        if tag in ("a", "button") and self._cta is None and not self.hard:
            self._cta, self._cta_depth = [], 1
        elif self._cta is not None and tag in ("a", "button"):
            self._cta_depth += 1
        if tag in ("h1", "h2", "h3", "h4") and self._head is None:
            self._head = []

    def handle_endtag(self, tag):
        if tag in self.HARD_SKIP and self.hard:
            self.hard -= 1
        elif tag in self.TEXT_SKIP and self.nav:
            self.nav -= 1
        if tag in self.BLOCK:
            self.parts.append(" ")
        if tag in ("a", "button") and self._cta is not None:
            self._cta_depth -= 1
            if self._cta_depth <= 0:
                self.ctas.append(" ".join("".join(self._cta).split()))
                self._cta = None
        if tag in ("h1", "h2", "h3", "h4") and self._head is not None:
            self.headings.append(" ".join("".join(self._head).split()))
            self._head = None

    def handle_data(self, data):
        if self.hard:
            return
        if self._cta is not None:
            self._cta.append(data)
        if self._head is not None:
            self._head.append(data)
        if not self.nav:
            self.parts.append(data)


# ASCII digits only ([0-9], re.ASCII): '\d' would also match Arabic-Indic and other Unicode digits,
# which show up in garbled or partly rendered captures ('$٤').
_AMT = (r"(?:[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?(?![0-9,])"       # 1,234.56
        r"|[0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{1,2})?(?![0-9.,])"        # 1.234,56
        r"|[0-9]+(?:[.,][0-9]{1,2})?(?![0-9]))")                        # 9  9.99  9,99
_UNIT = r"(?:\s*(?:/|per|a)\s*(mo(?:nth)?|yr|year|user|seat|member)\b)?"
PRICE_RE = re.compile(r"([$\u20ac\u00a3])\s*(" + _AMT + ")" + _UNIT, re.I | re.A)
PRICE_SUFFIX_RE = re.compile(r"(?<![0-9.,])(" + _AMT + r")\s*([\u20ac\u00a3])" + _UNIT, re.I | re.A)


def _canon_amount(raw):
    """'9,99' '1.234,56' '1,234.50' '12' -> canonical '9.99' '1234.56' '1234.50' '12'."""
    s = raw
    last_dot, last_comma = s.rfind("."), s.rfind(",")
    if last_dot >= 0 and last_comma >= 0:
        dec = "." if last_dot > last_comma else ","
    elif last_comma >= 0:
        dec = "," if len(s) - last_comma - 1 != 3 else None  # '1,234' is thousands, '9,99' decimal
    elif last_dot >= 0:
        dec = "." if len(s) - last_dot - 1 != 3 or s.count(".") == 1 and s.index(".") > 3 else None
    else:
        dec = None
    if dec:
        whole, frac = s[:s.rfind(dec)], s[s.rfind(dec) + 1:]
    else:
        whole, frac = s, ""
    whole = re.sub(r"[.,]", "", whole)
    if not frac.strip("0"):
        frac = ""
    return whole + ("." + frac if frac else "")


def _price_matches(text):
    """Yield (start, symbol, canonical amount, unit) for prefix ($9.99, EUR 9,99) and suffix (9,99 EUR) prices."""
    spans = []
    for m in PRICE_RE.finditer(text):
        spans.append((m.start(), m.end()))
        yield m.start(), m.group(1), _canon_amount(m.group(2)), (m.group(3) or "").lower()
    for m in PRICE_SUFFIX_RE.finditer(text):
        if any(a < m.end() and m.start() < b for a, b in spans):
            continue
        yield m.start(), m.group(2), _canon_amount(m.group(1)), (m.group(3) or "").lower()


CTA_WORDS = re.compile(r"\b(start|try|get|sign\s*up|signup|book|free|join|demo)\b", re.I)
TRIAL_RE = re.compile(r"\b(\d+)[- ]days?((?:\s+free)?(?:\s+trial)?)", re.I)
_NOT_TRIAL_RE = re.compile(r"money[- ]?back|guarantee|refund", re.I)
CREDIT_RE = re.compile(r"\b[\d,]+\s+(?:free\s+)?(?:ai\s+)?credits?\b", re.I)


def extract_facts(html):
    p = _PageParser()
    try:
        p.feed(html)
        p.close()
    except Exception:  # html.parser is lenient, but never let a bad page kill the run
        pass
    text = " ".join("".join(p.parts).split())
    prices, plans = set(), set()
    for start, symbol, amount, unit in _price_matches(text):
        unit = {"month": "mo", "year": "yr"}.get(unit, unit)
        if not unit and len(amount) == 1:
            continue  # a bare '$1' / '$9' with no billing period is a clipped fragment, not a price
        if len(amount) > 1 and amount[0] == "0" and amount[1] != ".":
            continue  # '$0015': leading zeros are a counter or chart label, not a price
        prices.add(f"{symbol}{amount}" + (f"/{unit}" if unit else ""))
        window = text[max(0, start - 40):start]
        for w in reversed(re.findall(r"[A-Za-z]+", window)):
            if w.lower() in KNOWN_PLANS:
                plans.add(w.capitalize())
                break
    for h in p.headings:
        for w in re.findall(r"[A-Za-z]+", h):
            if w.lower() in KNOWN_PLANS:
                plans.add(w.capitalize())
    ctas = {c for c in p.ctas if c and len(c) <= 60 and CTA_WORDS.search(c)}
    trials = set()
    for m in TRIAL_RE.finditer(text):
        before, after = text[max(0, m.start() - 15):m.start()], text[m.end():m.end() + 15]
        if _NOT_TRIAL_RE.search(before + " " + m.group(0) + " " + after):
            continue
        if not m.group(2).strip():  # bare '14 days' needs 'trial' or 'free' nearby
            near = text[max(0, m.start() - 25):m.end() + 25].lower()
            if "trial" not in near and "free" not in near:
                continue
        trials.add(re.sub(r"\s+", " ", f"{m.group(1)}-day{m.group(2)}").lower())
    credits = {re.sub(r"\s+", " ", m.group(0).lower()) for m in CREDIT_RE.finditer(text)}
    return {"text": text, "facts": {"price": sorted(prices), "plan": sorted(plans), "cta": sorted(ctas),
                                    "trial": sorted(trials), "credit": sorted(credits)}}


FACT_KINDS = ("price", "plan", "cta", "trial", "credit")
MIN_TEXT_FRAC = 0.5   # a capture with fewer visible-text tokens than this share of the median is a partial render
DEFAULT_PERSIST = 2   # a change is reported only once the new state holds in this many consecutive captures


def diff_facts(prev, cur):
    """Yield (what, before, after) for categories that differ between two fact dicts."""
    for what in FACT_KINDS:
        a, b = set(prev.get(what, [])), set(cur.get(what, []))
        if a != b:
            yield what, "; ".join(sorted(a - b)), "; ".join(sorted(b - a))


def text_tokens(text):
    return len(text.split())


def drop_partial_renders(snaps, min_frac=MIN_TEXT_FRAC):
    """Split snapshots into (usable, partial). A capture whose visible-text token count is under
    `min_frac` of the median capture is a partial or client-side render that lost most of the page;
    comparing it with a full render would report the missing content as removed, then added back.
    Snapshots need a "tokens" count (set by cmd_wayback); one without it is kept."""
    counts = [s["tokens"] for s in snaps if "tokens" in s]
    if not counts or min_frac <= 0:
        return list(snaps), []
    cutoff = min_frac * rm.median(counts)
    usable = [s for s in snaps if s.get("tokens", cutoff) >= cutoff]
    partial = [s for s in snaps if s.get("tokens", cutoff) < cutoff]
    return usable, partial


def confirm_prices(snaps):
    """Return copies of `snaps` whose price facts keep only prices seen in their own capture AND an
    adjacent one (the next capture, or the previous for the last). A price that appears in one capture
    only is a rendering artifact (a clipped digit, a mid-animation value), not something the site charged;
    prices on either side of a real change survive because each is confirmed by its own neighbour."""
    out = []
    for i, snap in enumerate(snaps):
        own = set(snap["facts"].get("price", []))
        adj = [set(snaps[j]["facts"].get("price", [])) for j in (i - 1, i + 1) if 0 <= j < len(snaps)]
        keep = {p for p in own if any(p in a for a in adj)}
        facts = dict(snap["facts"])
        facts["price"] = sorted(keep)
        out.append({**snap, "facts": facts})
    return out


def compare_snapshots(snaps, persist=1):
    """Compare snapshots in order and return the changes.

    persist=1 compares CONSECUTIVE snapshots, so A -> B -> A yields two changes. With persist=N a change
    in one fact category is reported only when its new state holds for N consecutive captures (the first of
    them dates the change); a state that flips back sooner is a flap and is dropped, and a change in the
    last captures that cannot yet show N in a row is not reported. Categories are judged independently.
    """
    persist = max(1, int(persist))
    changes = []
    n = len(snaps)
    sets = {what: [frozenset(s["facts"].get(what, [])) for s in snaps] for what in FACT_KINDS}
    for what in FACT_KINDS:
        seq = sets[what]
        state = seq[0] if seq else frozenset()
        for i in range(1, n):
            if seq[i] == state:
                continue
            if i + persist > n or any(seq[k] != seq[i] for k in range(i, i + persist)):
                continue
            cur = snaps[i]
            changes.append({"date": cur["date"], "url": cur["original"], "snapshot": cur["snapshot_url"],
                            "what": what, "before": "; ".join(sorted(state - seq[i])),
                            "after": "; ".join(sorted(seq[i] - state)), "_i": i})
            state = seq[i]
    changes.sort(key=lambda c: (c.pop("_i"), FACT_KINDS.index(c["what"])))
    return changes


def cmd_wayback(args):
    cache = args.cache
    cdx_path = cdx_cache_path(cache, args.url, args.year_from, args.year_to, args.every)
    warnings = []
    if os.path.exists(cdx_path):
        data = read_json(cdx_path)
    elif args.offline:
        raise AnalysisError(f"--offline: no cached CDX response at {cdx_path}")
    else:
        os.makedirs(cache, exist_ok=True)
        raw = http_get(cdx_query_url(args.url, args.year_from, args.year_to, args.every))
        try:
            data = json.loads(raw.decode("utf-8") or "[]")
        except json.JSONDecodeError:
            raise AnalysisError("CDX API returned something that is not JSON")
        rows_from_cdx(data)  # shape check before caching
        with open(cdx_path, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
    rows = sample_rows(rows_from_cdx(data), args.every, args.max)
    snaps, fetched = [], False
    for r in rows:
        ts, original = r["timestamp"], r.get("original") or args.url
        sp = snap_cache_path(cache, ts, original)
        if os.path.exists(sp):
            with open(sp, encoding="utf-8", errors="replace") as fh:
                html = fh.read()
        elif args.offline:
            warnings.append(f"offline: snapshot {ts} not cached, skipped")
            continue
        else:
            if fetched:
                time.sleep(1.0)
            fetched = True
            try:
                body = http_get(f"https://web.archive.org/web/{ts}id_/{original}")
            except AnalysisError as exc:
                warnings.append(str(exc))
                continue
            html = body.decode("utf-8", errors="replace")
            with open(sp, "w", encoding="utf-8") as fh:
                fh.write(html)
        parsed = extract_facts(html)
        snaps.append({"timestamp": ts, "date": f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}", "original": original,
                      "digest": r.get("digest"), "snapshot_url": f"https://web.archive.org/web/{ts}/{original}",
                      "text_sha1": hashlib.sha1(parsed["text"].encode("utf-8")).hexdigest(),
                      "tokens": text_tokens(parsed["text"]), "facts": parsed["facts"]})
    raw_changes = compare_snapshots(snaps)  # what a naive consecutive diff would have reported
    usable, partial = drop_partial_renders(snaps, args.min_text_frac)
    partial_ts = {s["timestamp"] for s in partial}
    for s in snaps:
        s["partial_render"] = s["timestamp"] in partial_ts
    if partial:
        warnings.append(f"{len(partial)} capture(s) skipped as partial renders (visible text under "
                        f"{args.min_text_frac:.0%} of the median)")
    # price confirmation needs a neighbour to confirm against, so it only applies when persistence is on
    changes = compare_snapshots(confirm_prices(usable) if args.persist > 1 else usable, args.persist)
    write_csv(args.csv_out, ["date", "url", "snapshot", "what", "before", "after"], changes)
    emit({"url": args.url, "every": args.every, "n_cdx_rows": len(rows), "n_snapshots": len(snaps),
          "n_used": len(usable), "n_partial_skipped": len(partial),
          "partial_skipped": [{"timestamp": s["timestamp"], "tokens": s["tokens"]} for s in partial],
          "median_tokens": rm.median([s["tokens"] for s in snaps]) if snaps else None,
          "persist": args.persist, "min_text_frac": args.min_text_frac,
          "n_changes_unfiltered": len(raw_changes),
          "offline": bool(args.offline), "snapshots": snaps, "changes": changes, "csv": args.csv_out,
          "warnings": warnings}, args.out)


# ----------------------------------------------------------------------------
# 7. ai
# ----------------------------------------------------------------------------

def _first(d, keys):
    for k in keys:
        if d.get(k) not in (None, ""):
            return d[k]
    return None


def normalise_answers(obj):
    if isinstance(obj, dict):
        obj = obj.get("answers") or obj.get("results") or obj.get("items") or [obj]
    out = []
    for a in obj if isinstance(obj, list) else []:
        if not isinstance(a, dict):
            continue
        text = _first(a, ["text", "answer", "markdown", "content"])
        cites = _first(a, ["citations", "sources", "links"]) or []
        urls = []
        for c in cites if isinstance(cites, list) else []:
            if isinstance(c, str):
                urls.append(c)
            elif isinstance(c, dict) and (c.get("url") or c.get("link") or c.get("href")):
                urls.append(c.get("url") or c.get("link") or c.get("href"))
        out.append({"engine": str(_first(a, ["engine", "model", "source_engine"]) or "unknown"),
                    "question": _first(a, ["question", "prompt", "query"]) or "",
                    "text": str(text or ""), "citations": urls})
    return out


def mention_order(text, brands):
    found = []
    for b in brands:
        m = re.search(r"(?<![\w])" + re.escape(b) + r"(?![\w])", text, re.I)
        if m:
            found.append((m.start(), b))
    found.sort()
    return [b for _, b in found]


def norm_domain(domain):
    """'https://www.Acme.com/x' -> 'acme.com'."""
    d = host_of(str(domain or "").strip().lstrip("."))
    return d[4:] if d.startswith("www.") else d


def on_domain(url, domain):
    d = norm_domain(domain)
    if not d:
        return False
    h = host_of(url)
    if h.startswith("www."):
        h = h[4:]
    return h == d or h.endswith("." + d)


def analyze_ai(answers, target, brands=None, domain=None):
    names = [target] + [b for b in (brands or []) if b.lower() != target.lower()]
    warnings = []
    per = []
    for a in answers:
        order = mention_order(a["text"], names)
        rank = next((i + 1 for i, n in enumerate(order) if n.lower() == target.lower()), None)
        cited = [u for u in a["citations"] if on_domain(u, domain)]
        per.append({"engine": a["engine"], "question": a["question"], "ranked": order, "target_rank": rank,
                    "cited_target_urls": cited, "n_citations": len(a["citations"])})
    engines = {}
    for eng in sorted({p["engine"] for p in per}):
        ps = [p for p in per if p["engine"] == eng]
        named = [p for p in ps if p["target_rank"] is not None]
        engines[eng] = {"answers": len(ps), "named": len(named), "share_named": r2(len(named) / len(ps), 4),
                        "share_ranked_first": r2(sum(1 for p in named if p["target_rank"] == 1) / len(ps), 4),
                        "mean_rank": r2(sum(p["target_rank"] for p in named) / len(named), 3) if named else None,
                        "answers_citing_domain": sum(1 for p in ps if p["cited_target_urls"])}
    pages = Counter(u for p in per for u in p["cited_target_urls"])
    if domain and not pages:
        warnings.append(f"--domain {domain!r} matched none of the {sum(p['n_citations'] for p in per)} citations")
    best = None
    if per:
        best = min(per, key=lambda p: (p["target_rank"] is None, p["target_rank"] or 0))
    card = None
    if best and best["target_rank"] is None:
        warnings.append(f"no answer names {target!r}; ai_answer card omitted")
    elif best:
        card = {"type": "ai_answer", "engine": best["engine"], "question": best["question"],
                "ranked": [{"name": n} for n in best["ranked"]], "target": target,
                "pages": best["cited_target_urls"]}
    return {"target": target, "brands": names, "domain": domain, "n_answers": len(per), "answers": per,
            "engines": engines,
            "overall": {"share_named": r2(sum(1 for p in per if p["target_rank"]) / len(per), 4) if per else None},
            "top_pages": [{"url": u, "count": c} for u, c in sorted(pages.items(), key=lambda kv: (-kv[1], kv[0]))[:10]],
            "ai_answer": card, "warnings": warnings}


def cmd_ai(args):
    answers = normalise_answers(read_json(args.answers))
    if not answers:
        raise AnalysisError(f"{args.answers}: no answers found")
    emit(analyze_ai(answers, args.target, args.brands, args.domain), args.out)


# ----------------------------------------------------------------------------
# 8. costs
# ----------------------------------------------------------------------------

def analyze_costs(entries, balance_before=None, balance_after=None):
    steps, endpoints = {}, {}
    total = 0.0
    for e in entries:
        step, ep = e["step"], e["endpoint"]
        calls, cost = e["calls"], e["cost_usd"]
        total += cost
        s = steps.setdefault(step, {"label": step, "endpoints": {}, "cost_usd": 0.0})
        s["cost_usd"] += cost
        se = s["endpoints"].setdefault(ep, {"id": ep, "calls": 0, "cost_usd": 0.0})
        se["calls"] += calls
        se["cost_usd"] += cost
        ge = endpoints.setdefault(ep, {"id": ep, "calls": 0, "cost_usd": 0.0})
        ge["calls"] += calls
        ge["cost_usd"] += cost
    items = []
    for s in steps.values():
        items.append({"label": s["label"], "endpoints": [{"id": v["id"], "calls": v["calls"],
                                                          "cost_usd": round(v["cost_usd"], 6)}
                                                         for v in s["endpoints"].values()],
                      "cost_usd": round(s["cost_usd"], 6)})
    out = {"total_usd": round(total, 4), "items": items, "footnote": ""}
    out["by_endpoint"] = [{"id": v["id"], "calls": v["calls"], "cost_usd": round(v["cost_usd"], 6)}
                          for v in sorted(endpoints.values(), key=lambda v: (-v["cost_usd"], v["id"]))]
    out["n_calls"] = sum(v["calls"] for v in endpoints.values())
    if balance_before is not None and balance_after is not None:
        spent = balance_before - balance_after
        gap = spent - total
        out["balance"] = {"before": balance_before, "after": balance_after, "spent": round(spent, 6),
                          "ledger_total": round(total, 6), "gap": round(gap, 6)}
        out["footnote"] = (f"Balance moved ${balance_before:.4f} to ${balance_after:.4f} (${spent:.4f}); "
                           f"the ledger sums to ${total:.4f}, gap ${gap:+.4f}.")
    elif balance_before is not None or balance_after is not None:
        raise AnalysisError("give both --balance-before and --balance-after")
    return out


def read_ledger(path):
    entries = []
    try:
        with open(path, encoding="utf-8-sig") as fh:
            lines = fh.read().splitlines()
    except OSError as exc:
        raise AnalysisError(f"cannot read {path}: {exc}")
    for n, ln in enumerate(lines, 1):
        if not ln.strip():
            continue
        try:
            o = json.loads(ln)
        except json.JSONDecodeError as exc:
            raise AnalysisError(f"{path} line {n}: invalid JSON ({exc})")
        if not isinstance(o, dict) or "step" not in o or "endpoint" not in o:
            raise AnalysisError(f"{path} line {n}: need step and endpoint")
        calls, cost = parse_num(o.get("calls", 1)), parse_num(o.get("cost_usd", 0))
        if calls is None or cost is None:
            raise AnalysisError(f"{path} line {n}: calls/cost_usd must be numbers")
        entries.append({"step": str(o["step"]), "endpoint": str(o["endpoint"]), "calls": int(calls), "cost_usd": cost})
    if not entries:
        raise AnalysisError(f"{path}: empty ledger")
    return entries


_NUM = r"-?\d[\d,]*(?:\.\d+)?"
_MONEY_RE = re.compile(rf"(?:(?:US\$|\$|USD)\s*({_NUM}))|(?:({_NUM})\s*(?:USD|\$))", re.I)
_DOLLAR_RE = re.compile(rf"(?:US\$|\$)\s*({_NUM})")
_BALANCE_WORD_RE = re.compile(r"balance|credits?", re.I)


def _to_float(text):
    return float(text.replace(",", ""))


def _balance_from_json(obj):
    """treg balance --json: micro-USD integers. A key naming micro, usd or dollars wins over the guess."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            kl = str(k).lower()
            if ("balance" in kl or "credit" in kl) and isinstance(v, (int, float)) and not isinstance(v, bool):
                if "micro" in kl:
                    return v / 1e6
                if "usd" in kl or "dollar" in kl or isinstance(v, float):
                    return float(v)
                return v / 1e6  # bare integer: treg documents micro-USD integers
        for v in obj.values():
            found = _balance_from_json(v)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = _balance_from_json(v)
            if found is not None:
                return found
    return None


def parse_balance(text):
    """A balance as dollars. Accepts 10, 10.00, '$10.00', 'USD 10.00', '10.00 USD', or a path to a file
    holding `treg balance` output: the first money amount after the word balance/credit wins, else the
    first $ amount, else the number right after 'balance:'."""
    s = str(text).strip()
    if s and os.path.isfile(s):
        try:
            with open(s, encoding="utf-8-sig") as fh:
                s = fh.read().strip()
        except OSError as exc:
            raise ValueError(f"cannot read {text}: {exc}")
    if not s:
        raise ValueError("empty balance")
    if re.fullmatch(_NUM, s):
        return _to_float(s)
    m = _MONEY_RE.fullmatch(s)
    if m:
        return _to_float(m.group(1) or m.group(2))
    if s[0] in "{[":
        try:
            found = _balance_from_json(json.loads(s))
        except json.JSONDecodeError:
            found = None
        if found is not None:
            return found
    for w in _BALANCE_WORD_RE.finditer(s):
        m = _MONEY_RE.search(s, w.end())
        if m:
            return _to_float(m.group(1) or m.group(2))
    m = _DOLLAR_RE.search(s)
    if m:
        return _to_float(m.group(1))
    m = re.search(rf"balance\s*[:=]\s*({_NUM})", s, re.I)
    if m:
        return _to_float(m.group(1))
    raise ValueError(f"no balance amount found in {s[:60]!r}")


def balance_arg(text):
    try:
        return parse_balance(text)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc))


def cmd_costs(args):
    emit(analyze_costs(read_ledger(args.ledger), args.balance_before, args.balance_after), args.out)


# ----------------------------------------------------------------------------
# 9. trends (Google Trends via DataForSEO -> demand.csv)
# ----------------------------------------------------------------------------

def to_day(v):
    """Epoch seconds/ms, ISO date or timestamp, or a date -> datetime.date. None when unreadable."""
    if v is None or isinstance(v, bool) or v == "" or v == 0:
        return None
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    s = str(v).strip()
    if isinstance(v, (int, float)) or re.fullmatch(r"\d{9,13}", s):
        try:
            x = float(s)
            if x > 1e11:  # milliseconds
                x /= 1000.0
            return dt.datetime.fromtimestamp(x, dt.timezone.utc).date()
        except (ValueError, OverflowError, OSError):
            return None
    try:
        return rm.parse_day(s)
    except ValueError:
        return None


def clip(text, n):
    s = " ".join(str(text or "").split())
    return s if len(s) <= n else s[:max(n - 1, 1)].rstrip() + "…"


def trends_monthly(obj, keyword, today=None):
    """DataForSEO dataforseo_trends explore live raw JSON -> [{month, value, partial}] for one keyword.

    Each graph item lists its keywords and every data point carries one value per keyword, in order.
    A point belongs to the month of its date_from; the month's value is the mean of its points.
    """
    if not isinstance(obj, dict):
        raise AnalysisError("trends file is not a DataForSEO response object")
    if obj.get("status_code") not in (None, 20000):
        raise AnalysisError(f"trends response failed: {obj.get('status_code')} {obj.get('status_message')}")
    want = keyword.strip().lower()
    seen, points = [], {}
    for task in obj.get("tasks") or []:
        if not isinstance(task, dict):
            continue
        if task.get("status_code") not in (None, 20000):
            raise AnalysisError(f"trends task failed: {task.get('status_code')} {task.get('status_message')}")
        for res in task.get("result") or []:
            for it in (res.get("items") or []) if isinstance(res, dict) else []:
                if not isinstance(it, dict):
                    continue
                kws = [str(k) for k in (it.get("keywords") or (res.get("keywords") if isinstance(res, dict) else None) or [])]
                seen.extend(k for k in kws if k not in seen)
                idx = next((i for i, k in enumerate(kws) if k.strip().lower() == want), None)
                if idx is None:
                    continue
                for pt in it.get("data") or []:
                    if not isinstance(pt, dict):
                        continue
                    vals = pt.get("values")
                    val = parse_num(vals[idx]) if isinstance(vals, list) and idx < len(vals) else None
                    day = to_day(pt.get("date_from")) or to_day(pt.get("timestamp"))
                    if val is not None and day is not None:
                        points[day] = val  # a repeated week keeps its last value
    if not points:
        raise AnalysisError(f"no trend points for keyword {keyword!r}"
                            + (f" (response has: {', '.join(seen)})" if seen else " (no graph items in the response)"))
    by_month = defaultdict(list)
    for day, val in points.items():
        by_month[(day.year, day.month)].append(val)
    cutoff = (today.year, today.month) if today else None
    return [{"month": rm.month_str(ym), "value": round(sum(v) / len(v), 4),
             "partial": 1 if cutoff and ym >= cutoff else 0} for ym, v in sorted(by_month.items())]


def cmd_trends(args):
    rows = trends_monthly(read_json(args.trends), args.keyword, parse_today(args.today) if args.today else None)
    if args.out:
        write_csv(args.out, ["month", "value", "partial"], rows)
    else:
        w = csv.DictWriter(sys.stdout, fieldnames=["month", "value", "partial"], lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


# ----------------------------------------------------------------------------
# 10. ads (Meta Ad Library, Google Ads Transparency)
# ----------------------------------------------------------------------------

LONG_RUNNER_DAYS = 30


def normalise_caption(text):
    """Caption family key: lower-cased, URLs dropped, digit runs become #, punctuation and spacing collapsed."""
    s = str(text or "").replace("…", " ")
    s = re.sub(r"https?://\S+|www\.\S+", " ", s)
    s = re.sub(r"\d+(?:[.,]\d+)*", "#", s.casefold())
    s = re.sub(r"[^\w#]+", " ", s)
    return " ".join(s.split())[:120]


def _text_of(v):
    if isinstance(v, dict):
        v = v.get("text")
    return " ".join(str(v).split()) if v else ""


def meta_ad_record(a):
    snap = a.get("snapshot") if isinstance(a.get("snapshot"), dict) else {}
    cards = [c for c in (snap.get("cards") or []) if isinstance(c, dict)]
    text = (_text_of(snap.get("body")) or next((_text_of(c.get("body")) for c in cards if _text_of(c.get("body"))), "")
            or _text_of(snap.get("title")) or _text_of(snap.get("caption")))
    link = snap.get("link_url") or next((c.get("link_url") for c in cards if c.get("link_url")), "")
    if not link:
        extra = snap.get("extra_links") or []
        link = (extra[0].get("url") if extra and isinstance(extra[0], dict) else extra[0]) if extra else ""
    langs = a.get("languages") or a.get("language") or snap.get("languages") or snap.get("language") or []
    langs = [langs] if isinstance(langs, str) else [str(x) for x in langs]
    aid = str(a.get("ad_archive_id") or a.get("ad_id") or "")
    return {"id": aid, "platform": "meta", "text": text, "link": str(link or ""),
            "languages": [x.strip().lower() for x in langs if str(x).strip()],
            "start": to_day(a.get("start_date")) or to_day(a.get("start_date_string")),
            "end": to_day(a.get("end_date")) or to_day(a.get("end_date_string")),
            "active": a.get("is_active"), "variants": a.get("collation_count"),
            "reach": parse_num(a.get("reach_estimate")),
            "url": a.get("url") or (f"https://www.facebook.com/ads/library/?id={aid}" if aid else ""),
            "advertiser": a.get("page_name") or snap.get("page_name") or "", "family_hint": ""}


def google_ad_record(a):
    fmt = str(a.get("format") or "").strip().lower()
    shown = parse_num(a.get("total_days_shown"))
    return {"id": str(a.get("ad_creative_id") or ""), "platform": "google_ads", "text": _text_of(a.get("text") or a.get("title")),
            "link": "", "languages": [], "start": to_day(a.get("first_shown")) or to_day(a.get("first_shown_datetime")),
            "end": to_day(a.get("last_shown")) or to_day(a.get("last_shown_datetime")),
            "active": None, "variants": None, "reach": None, "url": a.get("details_link") or "",
            "advertiser": a.get("advertiser") or "", "family_hint": f"(google {fmt or 'creative'} ad)",
            "total_days_shown": int(shown) if shown is not None else None}


def _ad_list(obj, keys):
    if isinstance(obj, list):
        return [x for x in obj if isinstance(x, dict)]
    if isinstance(obj, dict):
        for k in keys:
            if isinstance(obj.get(k), list):
                return [x for x in obj[k] if isinstance(x, dict)]
    return []


def analyze_ads(meta_objs, google_objs, today, long_days=LONG_RUNNER_DAYS, max_moves=10):
    warnings = []
    recs, seen = [], set()
    for obj in meta_objs:
        for a in _ad_list(obj, ("results", "ads", "data")):
            r = meta_ad_record(a)
            key = ("meta", r["id"] or id(a))
            if key not in seen:
                seen.add(key)
                recs.append(r)
    for obj in google_objs:
        for a in _ad_list(obj, ("ad_creatives", "ads", "results")):
            r = google_ad_record(a)
            key = ("google_ads", r["id"] or id(a))
            if key not in seen:
                seen.add(key)
                recs.append(r)
    clamped = backwards = 0
    for r in recs:
        last = r["end"]
        if last and today and last > today:
            last, clamped = today, clamped + 1  # a scheduled end is not a sighting
        r["last_seen"], r["first_seen"] = last, r["start"]
        r["days_running"], r["days_source"] = None, None
        if r["start"] and last:
            d = (last - r["start"]).days
            if d < 0:
                backwards += 1
            else:
                r["days_running"], r["days_source"] = d, "last_seen-first_seen"
        elif r.get("total_days_shown") is not None:
            r["days_running"], r["days_source"] = r["total_days_shown"], "total_days_shown"
        r["family"] = normalise_caption(r["text"]) or r["family_hint"] or "(no text)"
        host = host_of(r["link"]) if r["link"] else ""
        r["landing_host"] = host[4:] if host.startswith("www.") else host
        r["landing_path"] = url_path(r["link"]) if r["link"] else None
    if clamped:
        warnings.append(f"{clamped} ad(s) with an end date after today: last seen clamped to {today.isoformat()}")
    if backwards:
        warnings.append(f"{backwards} ad(s) ended before they started; days running left blank")
    nodate = sum(1 for r in recs if r["first_seen"] is None)
    if nodate:
        warnings.append(f"{nodate} ad(s) without a start date")
    unknown = sum(1 for r in recs if r["days_running"] is None)
    if unknown:
        warnings.append(f"{unknown} ad(s) have no days-running value (no start or no last-seen date)")

    fams = defaultdict(list)
    for r in recs:
        fams[r["family"]].append(r)
    families = []
    for fam, items in fams.items():
        days = [r["days_running"] for r in items if r["days_running"] is not None]
        firsts = [r["first_seen"] for r in items if r["first_seen"]]
        lasts = [r["last_seen"] for r in items if r["last_seen"]]
        paths = Counter(f"{r['landing_host']}{r['landing_path']}" for r in items if r["landing_path"])
        langs = Counter(l for r in items for l in r["languages"])
        families.append({
            "family": fam, "count": len(items), "example": clip(next((r["text"] for r in items if r["text"]), ""), 160),
            "first_seen": min(firsts).isoformat() if firsts else None,
            "last_seen": max(lasts).isoformat() if lasts else None,
            "max_days_running": max(days) if days else None,
            "platforms": sorted({r["platform"] for r in items}),
            "landing_pages": [{"page": p, "count": c} for p, c in sorted(paths.items(), key=lambda kv: (-kv[1], kv[0]))[:5]],
            "languages": dict(sorted(langs.items()))})
    families.sort(key=lambda f: (-f["count"], -(f["max_days_running"] or 0), f["family"]))

    def compact(r):
        return {"id": r["id"], "platform": r["platform"], "first_seen": r["first_seen"].isoformat() if r["first_seen"] else None,
                "last_seen": r["last_seen"].isoformat() if r["last_seen"] else None, "days_running": r["days_running"],
                "days_source": r["days_source"], "family": r["family"], "languages": r["languages"],
                "landing_host": r["landing_host"], "landing_path": r["landing_path"], "active": r["active"],
                "url": r["url"]}
    ads = sorted(recs, key=lambda r: (r["first_seen"] or dt.date.min, r["id"]))
    long_runners = sorted((r for r in recs if r["days_running"] is not None and r["days_running"] >= long_days),
                          key=lambda r: (-r["days_running"], r["id"]))
    langs = Counter(l for r in recs for l in r["languages"])
    pages = Counter((r["landing_host"], r["landing_path"]) for r in recs if r["landing_path"])

    moves = []
    for f in families[:max_moves]:
        items = sorted((r for r in fams[f["family"]] if r["first_seen"]), key=lambda r: (r["first_seen"], r["id"]))
        if not items:
            continue
        first = items[0]
        plat = "Meta" if first["platform"] == "meta" else "Google"
        label = f'Ad: "{f["example"]}"' if f["example"] else f"Ad: {f['family']}"
        days = f["max_days_running"]
        moves.append({
            "date": first["first_seen"].isoformat(), "channel": "ads", "label": clip(label, 32),
            "platform": first["platform"], "url": first["url"], "evidence": "SEEN",
            "detail": (f"{plat} ad first shown {first['first_seen'].isoformat()}; {f['count']} ad(s) in this caption family"
                       + (f", longest run {days} days (last seen minus first seen)" if days is not None else "")
                       + (f"; lands on {f['landing_pages'][0]['page']}" if f["landing_pages"] else "") + "."),
            "reach": "" if first["reach"] is None else first["reach"]})
    moves.sort(key=lambda m: (m["date"], m["label"]))
    return {"today": today.isoformat(), "n_ads": len(recs),
            "n_meta": sum(1 for r in recs if r["platform"] == "meta"),
            "n_google": sum(1 for r in recs if r["platform"] == "google_ads"),
            "long_runner_days": long_days, "ads": [compact(r) for r in ads],
            "families": families, "long_runners": [compact(r) for r in long_runners],
            "languages": dict(sorted(langs.items())),
            "landing_pages": [{"host": h, "path": p, "count": c}
                              for (h, p), c in sorted(pages.items(), key=lambda kv: (-kv[1], kv[0]))[:20]],
            "moves": moves, "warnings": warnings}


def cmd_ads(args):
    if not (args.meta or args.google):
        raise AnalysisError("give --meta and/or --google")
    res = analyze_ads([read_json(p) for p in args.meta or []], [read_json(p) for p in args.google or []],
                      parse_today(args.today), args.long_days, args.max_moves)
    if not res["n_ads"]:
        res["warnings"].append("no ads found in the input; missing ads prove nothing on their own")
    emit(res, args.out)


# ----------------------------------------------------------------------------
# 11. moves-collect (every source -> moves.csv)
# ----------------------------------------------------------------------------

# Canonical channels. "company" holds launches, funding, hires and other company news that is not
# one of the four growth channels; blueprint.py shows an unknown channel as its own lane.
CANON_CHANNELS = ("seo", "ads", "social", "loop", "company")
COLLECT_COLUMNS = ["date", "channel", "label", "platform", "url", "evidence", "detail", "reach"]

WAYBACK_WHAT = {"price": ("Pricing", "loop"), "trial": ("Trial", "loop"), "plan": ("Plans", "loop"),
                "cta": ("CTA", "seo"), "credit": ("Credits", "seo")}
EVOLUTION_CATEGORIES = {  # PredictLeads website_evolution category -> (label, channel)
    "pricing": ("Pricing page", "loop"), "partners": ("Partners page", "loop"),
    "affiliates": ("Affiliate program", "loop"), "integrations": ("Integrations", "loop"),
    "templates": ("Templates", "seo"), "careers": ("Careers page", "company")}
NEWS_CATEGORIES = {  # PredictLeads news_events categories that signal a growth move
    "launches", "partners_with", "integrates_with", "receives_financing", "goes_public", "hires", "acquires",
    "merges_with", "signs_new_client", "expands_offices_to", "expands_offices_in", "opens_new_location",
    "increases_headcount_by", "recognized_as", "receives_award", "invests_into", "is_developing"}


class Collector:
    def __init__(self):
        self.rows, self.dropped, self.dups, self._seen = [], Counter(), 0, set()
        self.kept = Counter()

    def drop(self, source, reason):
        self.dropped[(source, reason)] += 1

    def add(self, source, date, channel, label, url, platform="web", evidence="SEEN", detail="", reach=""):
        day = to_day(date)
        if day is None:
            return self.drop(source, "no usable date")
        label, url = str(label or "").strip(), str(url or "").strip()
        if not label:
            return self.drop(source, "no label")
        if not url:
            return self.drop(source, "no url")
        key = (day.isoformat(), label)
        if key in self._seen:
            self.dups += 1
            return None
        self._seen.add(key)
        self.kept[source] += 1
        self.rows.append({"date": day.isoformat(), "channel": str(channel).strip().lower(), "label": label,
                          "platform": platform, "url": url, "evidence": evidence, "detail": detail,
                          "reach": "" if reach is None else reach})


def collect_wayback(c, path):
    for r in read_csv(path):
        what = r.get("what", "").lower()
        name, channel = WAYBACK_WHAT.get(what, (what.capitalize() or "Page", "seo"))
        before, after = r.get("before", ""), r.get("after", "")
        if before and after:
            change = f"{before} → {after}"
        elif after:
            change = f"added {after}"
        else:
            change = f"dropped {before}"
        date = r.get("date", "")
        detail = (f"{name}: {before or '(none)'} → {after or '(none)'}. Seen by {date} in a Wayback capture; the change was "
                  "live on or before that date, not on it.")
        c.add("wayback", date, channel, f"{name}: {change}", r.get("snapshot") or r.get("url"), "wayback", "SEEN", detail)


def _included(obj):
    return {(i.get("type"), i.get("id")): i.get("attributes") or {} for i in obj.get("included") or []
            if isinstance(i, dict)}


def collect_evolution(c, path, min_family=3):
    obj = read_json(path)
    entries = []
    for d in (obj.get("data") if isinstance(obj, dict) else obj) or []:
        a = d.get("attributes") if isinstance(d, dict) else None
        if not isinstance(a, dict):
            continue
        day, url = to_day(a.get("first_seen_at")), a.get("url") or ""
        if day is None or not url:
            c.drop("evolution", "no first_seen_at or url")
            continue
        entries.append({"cat": str(a.get("category") or "").lower(), "url": url, "day": day})
    if not entries:
        return []
    notes = []
    base = Counter(e["day"] for e in entries).most_common(1)[0]
    if base[1] >= 20 and base[1] >= 0.25 * len(entries) and base[0] == min(e["day"] for e in entries):
        notes.append(f"{base[1]} pages share first-seen date {base[0].isoformat()}, the crawler's first visit; "
                     "left out because they say nothing about when a page went live")
        for e in entries:
            if e["day"] == base[0]:
                c.drop("evolution", "first-seen on the crawler's first-visit date")
        entries = [e for e in entries if e["day"] != base[0]]
    groups = defaultdict(list)
    fam_groups = defaultdict(list)
    for e in entries:
        if e["cat"] in EVOLUTION_CATEGORIES:
            groups[e["cat"]].append(e)
        else:
            _, bare = split_locale(url_path(e["url"]) or "/")
            fam = family_of(bare)
            if fam != "/":
                fam_groups[fam].append(e)
            else:
                c.drop("evolution", "other category, no path family")
    for cat, items in groups.items():
        items.sort(key=lambda e: (e["day"], e["url"]))
        first, name_channel = items[0], EVOLUTION_CATEGORIES[cat]
        c.add("evolution", first["day"], name_channel[1], f"{name_channel[0]}: first seen", first["url"], "web",
              "SEEN", f"{len(items)} page(s) in this category; the earliest first seen by {first['day'].isoformat()} "
                      "(a crawler's first sight: the page went live on or before this date).")
    for fam, items in fam_groups.items():
        if len(items) < min_family:
            c.drop("evolution", f"path family under {min_family} pages")
            continue
        items.sort(key=lambda e: (e["day"], e["url"]))
        first = items[0]
        c.add("evolution", first["day"], "seo", f"New section: /{fam}/", first["url"], "web", "SEEN",
              f"{len(items)} pages under /{fam}/; the earliest first seen by {first['day'].isoformat()} "
              "(a crawler's first sight: live on or before this date).")
    return notes


def collect_news(c, path):
    obj = read_json(path)
    inc = _included(obj)
    for d in obj.get("data") or []:
        a = d.get("attributes") if isinstance(d, dict) else None
        if not isinstance(a, dict):
            continue
        cat = str(a.get("category") or "")
        if cat not in NEWS_CATEGORIES:
            c.drop("news", "category is not a growth signal")
            continue
        src = ((d.get("relationships") or {}).get("most_relevant_source") or {}).get("data") or {}
        art = inc.get((src.get("type"), src.get("id")), {})
        url = art.get("url") or a.get("url") or a.get("source_url") or ""
        date = art.get("published_at") or a.get("found_at")
        summary = " ".join(str(a.get("summary") or cat).split())
        c.add("news", date, "company", clip(summary, 32), url, "news", "SEEN",
              f"{cat.replace('_', ' ')}: {summary} Found by {str(a.get('found_at') or date)[:10]}.")


def collect_financing(c, path):
    obj = read_json(path)
    for d in obj.get("data") or []:
        a = d.get("attributes") if isinstance(d, dict) else None
        if not isinstance(a, dict):
            continue
        urls = a.get("source_urls") or []
        amount = str(a.get("amount") or "").strip()
        kind = str(a.get("financing_type") or "financing")
        label = f"Funding: {amount}" if amount else f"Financing: {kind}"
        cats = ", ".join(a.get("categories") or [])
        c.add("financing", a.get("effective_date") or a.get("found_at"), "company", label,
              urls[0] if urls else "", "money", "SEEN",
              f"{kind}{', ' + cats if cats else ''}; amount as reported by the linked source"
              + (f" ({amount})." if amount else "."))


def collect_loops(c, path, default_url=""):
    obj = read_json(path)
    block = obj.get("anchors", obj) if isinstance(obj, dict) else obj
    loops = block.get("loops") if isinstance(block, dict) else block
    for a in loops or []:
        if not isinstance(a, dict):
            continue
        date = a.get("first_seen")
        if not date:
            c.drop("loops", "no first_seen")
            continue
        c.add("loops", date, "loop", clip(f"Badge: {a.get('anchor', '')}", 32), a.get("url") or default_url, "link",
              "SEEN", f"Anchor \"{a.get('anchor', '')}\" on {a.get('referring_domains', 0)} referring domains "
                      f"({a.get('backlinks', 0)} backlinks); first seen by {str(date)[:10]}.")


def collect_ads(c, path):
    obj = read_json(path)
    for m in (obj.get("moves") if isinstance(obj, dict) else obj) or []:
        if isinstance(m, dict):
            c.add("ads", m.get("date"), m.get("channel") or "ads", m.get("label"), m.get("url"),
                  m.get("platform") or "meta", m.get("evidence") or "SEEN", m.get("detail") or "", m.get("reach"))


def collect_posts(c, path, top_n=3):
    obj = read_json(path)
    posts = obj.get("posts") or []
    chan, metric = obj.get("channel") or "social", obj.get("metric") or "engagement"
    chosen = [p for p in posts if p.get("tier") == "top"]
    if not chosen:
        chosen = sorted((p for p in posts if p.get("rank")), key=lambda p: p["rank"])[:top_n]
    for p in chosen:
        eng = p.get("engagement")
        mult = p.get("multiple")
        n = "?" if eng is None else f"{eng:,.0f}"
        c.add("posts", p.get("date"), "social", clip(f"Top {chan} post: {n} {metric}", 32), p.get("url"), chan, "SEEN",
              f"{n} {metric}" + (f", {mult:g}x the channel median" if mult else "") + f"; posted {p.get('date')}; "
              f"counts read {obj.get('today', '')}.", eng)


def collect_extra(c, path):
    rows = read_csv(path)
    if rows:
        missing = [k for k in ("date", "channel", "label", "url") if k not in rows[0]]
        if missing:
            raise AnalysisError(f"{path}: missing column(s) {', '.join(missing)} (need date,channel,label,url)")
    odd = set()
    for r in rows:
        ch = r.get("channel", "").lower()
        if ch and ch not in CANON_CHANNELS:
            odd.add(ch)
        c.add("extra", r.get("date"), ch, r.get("label"), r.get("url"), r.get("platform", ""), r.get("evidence", ""),
              r.get("detail", ""), r.get("reach", ""))
    return [f"{path}: channel(s) outside {'/'.join(CANON_CHANNELS)} kept as given: {', '.join(sorted(odd))}"] if odd else []


def cmd_moves_collect(args):
    srcs = [("wayback", args.wayback), ("evolution", args.evolution), ("news", args.news),
            ("financing", args.financing), ("loops", args.loops), ("ads", args.ads),
            ("posts", args.posts_ranked), ("extra", args.extra)]
    if not any(paths for _, paths in srcs):
        raise AnalysisError("give at least one of --wayback --evolution --news --financing --loops --ads "
                            "--posts-ranked --extra")
    c, warnings = Collector(), []
    for name, paths in srcs:
        for path in paths or []:
            if name == "wayback":
                collect_wayback(c, path)
            elif name == "evolution":
                warnings.extend(collect_evolution(c, path, args.min_family))
            elif name == "news":
                collect_news(c, path)
            elif name == "financing":
                collect_financing(c, path)
            elif name == "loops":
                collect_loops(c, path, args.loops_url or "")
            elif name == "ads":
                collect_ads(c, path)
            elif name == "posts":
                collect_posts(c, path)
            else:
                warnings.extend(collect_extra(c, path))
    for (source, reason), n in sorted(c.dropped.items()):
        warnings.append(f"{n} {source} row(s) dropped: {reason}")
    rows = sorted(c.rows, key=lambda r: (r["date"], r["label"]))
    if not rows:
        warnings.append("no moves collected")
    write_csv(args.csv_out, COLLECT_COLUMNS, rows)
    emit({"csv": args.csv_out, "columns": COLLECT_COLUMNS, "n_rows": len(rows), "by_source": dict(sorted(c.kept.items())),
          "by_channel": dict(sorted(Counter(r["channel"] for r in rows).items())), "duplicates_removed": c.dups,
          "dropped": [{"source": s, "reason": r, "count": n} for (s, r), n in sorted(c.dropped.items())],
          "warnings": warnings}, args.out)


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def _int_min(lo):
    def conv(text):
        try:
            v = int(text)
        except ValueError:
            raise argparse.ArgumentTypeError(f"not an integer: {text!r}")
        if v < lo:
            raise argparse.ArgumentTypeError(f"must be >= {lo}")
        return v
    return conv


def build_parser():
    ap = argparse.ArgumentParser(prog="analyze.py", description="rea-growth analysis scripts")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, fn, help_, out_help="write JSON here (default stdout)"):
        p = sub.add_parser(name, help=help_)
        p.add_argument("-o", "--out", help=out_help)
        p.set_defaults(fn=fn)
        return p

    p = add("inflection", cmd_inflection, "growth inflection, change-points, best window")
    p.add_argument("--traffic")
    p.add_argument("--from-dataforseo", help="DataForSEO historical_rank_overview raw JSON")
    p.add_argument("--max-window", type=int, default=6)
    p.add_argument("--min-base-frac", type=float, default=0.01)
    p.add_argument("--min-seg", type=int, default=3)
    p.add_argument("--kind", choices=["attention", "people"], default="attention",
                   help="series kind for the window floor: attention (visits, views; first month >= 1000) "
                        "or people (stars, sign-ups, followers; first month >= 100)")
    p.add_argument("--cumulative", action=argparse.BooleanOptionalAction, default=None,
                   help="the series is a running total (stars, followers): change-points run on monthly "
                        "increments, the window stays on the cumulative values. Default: auto-detect a "
                        "non-decreasing series for --kind people; --no-cumulative turns that off")
    p.add_argument("--peers", nargs="*")
    p.add_argument("--today", help="YYYY-MM-DD; months from this month on count as partial")
    p.add_argument("--emit-csv", help="write the parsed series as month,value,partial,organic,paid")

    p = add("moves", cmd_moves, "moves vs growth with clustering and placebo test")
    p.add_argument("--moves", required=True)
    p.add_argument("--traffic", required=True)
    p.add_argument("--brand-demand")
    p.add_argument("--peers", nargs="*")
    p.add_argument("--before", type=_int_min(1), default=2)
    p.add_argument("--after", type=_int_min(0), default=2)
    p.add_argument("--cluster-days", type=int, default=30)
    p.add_argument("--placebo", action="store_true")
    p.add_argument("--kind", choices=sorted(WINDOW_BASE_FLOOR), default="attention",
                   help="series kind for the lift guard: a cluster whose before-window mean is under the floor "
                        "(attention 1000, people 100) or under 5%% of the series max is not credited "
                        "(\"base too small\")")
    p.add_argument("--today")
    p.add_argument("--csv-out", default="moves-vs-growth.csv")

    p = add("posts", cmd_posts, "rank posts, find outliers")
    p.add_argument("--posts", required=True)
    p.add_argument("--channel", required=True, choices=["x", "youtube", "tiktok", "instagram", "linkedin", "reddit"])
    p.add_argument("--today")
    p.add_argument("--settle-days", type=int, default=7)
    p.add_argument("--emit-monthly", metavar="CSV",
                   help="also write month,value,partial: the channel engagement metric summed by month over "
                        "ALL posts (settled or not); the current month is partial")

    p = add("families", cmd_families, "URL families, templates, programmatic SEO")
    p.add_argument("--urls", required=True)
    p.add_argument("--keywords")
    p.add_argument("--brand", action="append", default=[])
    p.add_argument("--min-family", type=int, default=3)
    p.add_argument("--pseo-min", type=int, default=50)

    p = add("loops", cmd_loops, "badge/referral loops from anchors and backlinks")
    p.add_argument("--anchors", required=True)
    p.add_argument("--referrers")
    p.add_argument("--subdomains")
    p.add_argument("--brand", action="append", default=[])

    p = add("wayback", cmd_wayback, "Wayback Machine pricing/CTA change history")
    p.add_argument("--url", required=True)
    p.add_argument("--from", dest="year_from", type=int)
    p.add_argument("--to", dest="year_to", type=int)
    p.add_argument("--every", choices=["month", "week", "change"], default="month")
    p.add_argument("--max", type=int, default=40)
    p.add_argument("--cache", default=os.path.join("raw", "wayback"))
    p.add_argument("--offline", action="store_true", help="read only the cache, never the network")
    p.add_argument("--persist", type=_int_min(1), default=DEFAULT_PERSIST,
                   help="a change is reported only when the new state holds in this many consecutive captures "
                        "(default 2; 1 reports every flip)")
    p.add_argument("--min-text-frac", type=float, default=MIN_TEXT_FRAC,
                   help="skip captures whose visible-text token count is under this share of the median "
                        "(partial renders; default 0.5, 0 keeps all)")
    p.add_argument("--csv-out", default="changes.csv")

    p = add("ai", cmd_ai, "rank the target in AI answers")
    p.add_argument("--answers", required=True)
    p.add_argument("--target", required=True)
    p.add_argument("--brands", nargs="*", default=[])
    p.add_argument("--domain")

    p = add("ads", cmd_ads, "ad days running, caption families, long-runners and ad-start moves")
    p.add_argument("--meta", action="append", help="scrapecreators facebook adlibrary company ads raw JSON (repeatable)")
    p.add_argument("--google", action="append", help="serpapi google ads transparency raw JSON (repeatable)")
    p.add_argument("--today", help="YYYY-MM-DD; an ad's last seen is never later than this (default: today)")
    p.add_argument("--long-days", type=_int_min(1), default=LONG_RUNNER_DAYS,
                   help="days running that make a long-runner (default 30)")
    p.add_argument("--max-moves", type=_int_min(0), default=10, help="ad-start moves emitted, one per top caption family")

    p = add("trends", cmd_trends, "Google Trends raw JSON -> monthly demand CSV (month,value,partial)",
            out_help="write the CSV here (default stdout)")
    p.add_argument("--trends", required=True, help="dataforseo trends explore live raw JSON")
    p.add_argument("--keyword", required=True, help="the keyword to extract (as sent in the call)")
    p.add_argument("--today", help="YYYY-MM-DD; this month and later are marked partial")

    p = add("moves-collect", cmd_moves_collect, "merge every source into moves.csv")
    for flag, hlp in (("--wayback", "analyze wayback changes.csv"),
                      ("--evolution", "predictleads website_evolution raw JSON"),
                      ("--news", "predictleads news_events raw JSON"),
                      ("--financing", "predictleads financing_events raw JSON"),
                      ("--loops", "analyze loops output JSON (badge anchors)"),
                      ("--ads", "analyze ads output JSON (ad-start moves)"),
                      ("--posts-ranked", "analyze posts output JSON (top-tier posts; top 3 when no tiers)"),
                      ("--extra", "manual CSV with date,channel,label,url (appended after validation)")):
        p.add_argument(flag, action="append", metavar="FILE", help=hlp + " (repeatable)")
    p.add_argument("--loops-url", help="url to use for badge anchors that carry none (e.g. the target's homepage)")
    p.add_argument("--min-family", type=_int_min(1), default=3, help="pages a new path family needs (default 3)")
    p.add_argument("--csv-out", default="moves.csv")

    p = add("costs", cmd_costs, "sum a calls ledger")
    p.add_argument("--ledger", required=True)
    p.add_argument("--balance-before", type=balance_arg,
                   help="dollars: 10.00, '$10.00', 'USD 10.00', '10.00 USD', or a file holding `treg balance` output")
    p.add_argument("--balance-after", type=balance_arg, help="same forms as --balance-before")
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.cmd == "inflection" and not (args.traffic or args.from_dataforseo):
        build_parser().error("inflection needs --traffic or --from-dataforseo")
    try:
        args.fn(args)
    except AnalysisError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1
    except ValueError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1
    except Exception as exc:  # malformed input must exit 1 with a message, never a traceback
        sys.stderr.write(f"error: unexpected {type(exc).__name__}: {exc}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
