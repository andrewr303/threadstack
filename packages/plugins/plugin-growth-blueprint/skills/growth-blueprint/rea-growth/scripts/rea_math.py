"""rea_math: small pure helpers for the rea-growth analysis scripts.

Python 3.10+ standard library only. No I/O in this module.
"""
from __future__ import annotations

import datetime as dt
import math
import re
from collections import Counter, defaultdict

# ----------------------------------------------------------------------------
# Months and dates
# ----------------------------------------------------------------------------

_MONTH_RE = re.compile(r"\s*(\d{4})-(\d{2})(?:-(\d{2}))?\s*$")


def parse_month(text):
    """'YYYY-MM' or 'YYYY-MM-DD' -> (year, month). Raises ValueError."""
    m = _MONTH_RE.match(str(text))
    if not m:
        raise ValueError(f"bad month/date: {text!r} (want YYYY-MM or YYYY-MM-DD)")
    year, month = int(m.group(1)), int(m.group(2))
    if not 1 <= month <= 12:
        raise ValueError(f"bad month in {text!r}")
    if m.group(3) is not None:
        dt.date(year, month, int(m.group(3)))  # validates the day
    return (year, month)


def parse_day(text):
    """'YYYY-MM-DD' (or a longer ISO timestamp) -> datetime.date. 'YYYY-MM' -> first of month."""
    s = str(text).strip()
    m = re.match(r"(\d{4})-(\d{2})(?:-(\d{2}))?", s)
    if not m:
        raise ValueError(f"bad date: {text!r}")
    return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3) or 1))


def month_str(ym):
    return f"{ym[0]:04d}-{ym[1]:02d}"


def month_index(ym):
    return ym[0] * 12 + ym[1] - 1


def month_add(ym, n):
    idx = month_index(ym) + int(n)
    return (idx // 12, idx % 12 + 1)


def months_between(a, b):
    """Whole calendar months from a to b (b - a)."""
    return month_index(b) - month_index(a)


def month_range(a, b):
    """Inclusive list of (y, m) from a to b."""
    return [month_add(a, i) for i in range(months_between(a, b) + 1)]


# ----------------------------------------------------------------------------
# Basic statistics
# ----------------------------------------------------------------------------

def mean(values):
    values = list(values)
    return sum(values) / len(values) if values else None


def median(values):
    s = sorted(values)
    n = len(s)
    if n == 0:
        return None
    mid = n // 2
    return float(s[mid]) if n % 2 else (s[mid - 1] + s[mid]) / 2.0


def mad(values):
    """Median absolute deviation around the median (unscaled)."""
    vals = list(values)
    if not vals:
        return None
    med = median(vals)
    return median([abs(v - med) for v in vals])


def robust_z(x, med, mad_value):
    """(x - median) / (1.4826 * MAD); None when MAD is 0."""
    if not mad_value:
        return None
    return (x - med) / (1.4826 * mad_value)


def rankdata(values):
    """Ranks starting at 1, ties get the average rank."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def pearson(x, y):
    n = len(x)
    if n < 2 or n != len(y):
        return None
    mx, my = sum(x) / n, sum(y) / n
    sxx = sum((a - mx) ** 2 for a in x)
    syy = sum((b - my) ** 2 for b in y)
    if sxx == 0 or syy == 0:
        return None
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y))
    return sxy / math.sqrt(sxx * syy)


def spearman(x, y):
    """Spearman rho with average ranks for ties; None if undefined."""
    if len(x) != len(y) or len(x) < 2:
        return None
    return pearson(rankdata(list(x)), rankdata(list(y)))


# ----------------------------------------------------------------------------
# Growth
# ----------------------------------------------------------------------------

def mom_growth(values):
    """Month-on-month growth as fractions. None where undefined (first, gaps, prev <= 0)."""
    out = [None] * len(values)
    for i in range(1, len(values)):
        a, b = values[i - 1], values[i]
        if a is None or b is None or a <= 0:
            continue
        out[i] = b / a - 1.0
    return out


def format_multiple(x):
    """>= 10 -> integer string, else one decimal with a trailing .0 dropped."""
    from decimal import Decimal, ROUND_HALF_UP
    d = Decimal(repr(float(x)))
    if x >= 10:
        return str(int(d.quantize(Decimal("1"), rounding=ROUND_HALF_UP)))
    s = f"{d.quantize(Decimal('0.1'), rounding=ROUND_HALF_UP):.1f}"
    return s[:-2] if s.endswith(".0") else s


def window_label(multiple, months):
    unit = "month" if months == 1 else "months"
    return f"{format_multiple(multiple)}× in {months} {unit}"


SUSTAINED_END_FRAC = 0.8   # a sustained window must end at >= this share of its own maximum


def sustained_rise(window, end_frac=SUSTAINED_END_FRAC):
    """True when `window` (values, first..last, None = missing) is a sustained rise.

    Rejected when any month falls below the window's first month (the series dipped back under its
    starting point) or when the last month is under `end_frac` of the window maximum (the window ends
    in a collapse after a spike, so it is a spike, not a rise).
    """
    vals = [v for v in window if v is not None]
    if not vals or window[0] is None or window[-1] is None:
        return False
    return min(vals) >= window[0] and window[-1] >= end_frac * max(vals)


def best_window(values, max_window, min_base, min_months=1, sustained=False, stats=None):
    """Largest end/start multiple over windows of min_months..max_window months.

    values may contain None (partial/missing). Start values below min_base (or <= 0)
    are ignored, and so is any window whose end value is None (a partial month never ends
    a window). Ties: shortest window, then earliest start. Returns None if nothing > 1x.

    With sustained=True a candidate window must also be a sustained rise (see `sustained_rise`);
    candidates that fail are skipped. When `stats` is a dict it receives "candidates" (windows that
    passed the base/end filters and rose above 1x) and "rejected" (of those, the ones dropped as not
    sustained), so a caller can say why nothing qualified.
    """
    n = len(values)
    best = None
    candidates = rejected = 0
    for i in range(n):
        a = values[i]
        if a is None or a <= 0 or a < min_base:
            continue
        for j in range(i + max(1, min_months), min(n, i + max_window + 1)):
            b = values[j]
            if b is None:
                continue
            mult = b / a
            if mult <= 1.0:
                continue
            candidates += 1
            if sustained and not sustained_rise(values[i:j + 1]):
                rejected += 1
                continue
            if (best is None or mult > best["multiple"] + 1e-9
                    or (abs(mult - best["multiple"]) <= 1e-9 and j - i < best["months"])):
                best = {"start_idx": i, "end_idx": j, "multiple": mult, "months": j - i}
    if stats is not None:
        stats["candidates"], stats["rejected"] = candidates, rejected
    if best is None or best["multiple"] <= 1.0:
        return None
    best["label"] = window_label(best["multiple"], best["months"])
    return best


# ----------------------------------------------------------------------------
# Change-point detection (PELT, L2 cost)
# ----------------------------------------------------------------------------

def _prefix_sums(values):
    s, s2 = [0.0], [0.0]
    for v in values:
        s.append(s[-1] + v)
        s2.append(s2[-1] + v * v)
    return s, s2


def segment_cost(s, s2, a, b):
    """Sum of squared deviations from the mean over values[a:b]."""
    n = b - a
    total = s[b] - s[a]
    return (s2[b] - s2[a]) - total * total / n


def pelt(values, penalty, min_seg=2):
    """Penalised optimal partitioning with pruning (PELT), L2 segment cost.

    Returns sorted indices where a new segment starts (never 0, never len).
    """
    n = len(values)
    min_seg = max(1, int(min_seg))
    if n < 2 * min_seg:
        return []
    s, s2 = _prefix_sums(values)
    best = [None] * (n + 1)
    best[0] = -penalty
    prev = [0] * (n + 1)
    cands = []
    for t in range(min_seg, n + 1):
        new = t - min_seg
        if new == 0 or new >= min_seg:
            cands.append(new)
        costs = {}
        arg, low = None, None
        for c in cands:
            val = best[c] + segment_cost(s, s2, c, t) + penalty
            costs[c] = val
            if low is None or val < low:
                low, arg = val, c
        best[t], prev[t] = low, arg
        if min_seg == 1:
            # PELT pruning is only valid for min_seg == 1; otherwise keep all candidates.
            cands = [c for c in cands if costs[c] - penalty <= best[t]]
    cps = []
    t = n
    while t > 0:
        c = prev[t]
        if c > 0:
            cps.append(c)
        t = c
    return sorted(cps)


def noise_variance(values, floor=1e-4):
    """Robust noise variance from first differences (MAD based), floored."""
    if len(values) < 3:
        return floor
    diffs = [values[i + 1] - values[i] for i in range(len(values) - 1)]
    sigma = 1.4826 * (mad(diffs) or 0.0) / math.sqrt(2.0)
    return max(sigma * sigma, floor)


def penalty_sweep(values, min_seg=2, ks=(1, 2, 4, 8)):
    """Run PELT at pen = k * sigma^2 * log(n) for each k."""
    n = len(values)
    sigma2 = noise_variance(values)
    runs = []
    for k in ks:
        pen = k * sigma2 * math.log(max(n, 2))
        runs.append({"k": k, "penalty": pen, "changepoints": pelt(values, pen, min_seg)})
    return {"sigma2": sigma2, "n": n, "runs": runs}


def stability(cp, runs, tol=1):
    """How many penalty runs keep a changepoint (within +-tol indices)."""
    return sum(1 for r in runs if any(abs(c - cp) <= tol for c in r["changepoints"]))


# ----------------------------------------------------------------------------
# Event study helpers
# ----------------------------------------------------------------------------

def event_lift(series, idx, before, after):
    """Average MoM growth before vs after an event month.

    Before = growth in the `before` months preceding idx. After = growth in month idx and
    the `after` months following it. lift_pp = (after - before) in percentage points.
    series holds levels (None = partial/missing).
    """
    n = len(series)
    if idx - before < 1:
        return {"ok": False, "reason": "no_history"}
    if idx + after > n - 1:
        return {"ok": False, "reason": "no_future"}
    g = mom_growth(series)
    b_vals = [g[i] for i in range(idx - before, idx)]
    a_vals = [g[i] for i in range(idx, idx + after + 1)]
    if any(v is None for v in b_vals + a_vals):
        return {"ok": False, "reason": "partial_or_missing"}
    b, a = sum(b_vals) / len(b_vals), sum(a_vals) / len(a_vals)
    return {"ok": True, "before_pct": b * 100.0, "after_pct": a * 100.0, "lift_pp": (a - b) * 100.0}


def placebo_p(observed, placebos):
    """Tail-count p: (1 + #placebo >= observed) / (N + 1)."""
    return (1 + sum(1 for p in placebos if p >= observed)) / (len(placebos) + 1)


def cluster_dates(dates, days):
    """Chain dates less than `days` apart. Returns cluster ids (1.., chronological) aligned to input."""
    parsed = [parse_day(d) if not isinstance(d, dt.date) else d for d in dates]
    order = sorted(range(len(parsed)), key=lambda i: (parsed[i], i))
    ids = [0] * len(parsed)
    cur, last = 0, None
    for i in order:
        if last is None or (parsed[i] - last).days >= days:
            cur += 1
        ids[i] = cur
        last = parsed[i]
    return ids


# ----------------------------------------------------------------------------
# Anchor classification
# ----------------------------------------------------------------------------

_BADGE_RE = re.compile(
    r"\b(?:(?:made|built|created|designed|sent|scheduled|edit)\s+with|powered\s+by|hosted\s+on)\b",
    re.I,
)
_SPAM_RE = re.compile(
    r"\b(?:seo|backlinks?|casino|telegram|viagra|betting|escort|escorts|poker|slots?|porn|"
    r"loan|payday|crypto|bitcoin|forex|pills?|cbd|gambling|bet)\b",
    re.I,
)
_GENERIC = {
    "click here", "here", "website", "link", "this link", "site", "this site", "read more",
    "more", "visit", "visit site", "visit website", "homepage", "home", "source", "web",
    "this", "page", "url", "check it out", "learn more", "official site",
}
_URLISH_RE = re.compile(r"^(?:https?://|www\.)\S+$|^[\w-]+(?:\.[\w-]+)+(?:/\S*)?$", re.I)


def _squash(text):
    return re.sub(r"[\W_]+", "", str(text).casefold())


def classify_anchor(text, brand=None):
    """badge | spam | brand | url | generic | other."""
    t = " ".join(str(text or "").split())
    if not t:
        return "other"
    brand_terms = [b for b in ([brand] if isinstance(brand, str) else list(brand or [])) if b]
    if _BADGE_RE.search(t):
        return "badge"
    for b in brand_terms:
        if re.search(r"\bvia\s+" + re.escape(b) + r"\b", t, re.I) or re.search(
            re.escape(b) + r"\s+badge\b", t, re.I
        ):
            return "badge"
    sq = _squash(t)
    folded = t.casefold()
    for b in brand_terms:
        bf = " ".join(str(b).split()).casefold()
        bs = _squash(b)
        if not bs:
            continue
        if re.search(r"(?<!\w)" + re.escape(bf) + r"(?!\w)", folded):
            return "brand"
        if (len(bs) >= 4 or not bs.isascii()) and bs in sq:
            return "brand"
    if _SPAM_RE.search(t):
        return "spam"
    if t.casefold().strip(" \t.,!?;:()[]\"'") in _GENERIC:
        return "generic"
    if _URLISH_RE.match(t):
        return "url"
    return "other"


# ----------------------------------------------------------------------------
# URL templates
# ----------------------------------------------------------------------------

_HEXID_RE = re.compile(r"^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[0-9a-f]*\d)[0-9a-f]{8,})$", re.I)


def segment_class(seg):
    if re.fullmatch(r"\d+", seg):
        return "num"
    if _HEXID_RE.match(seg):
        return "id"
    return "text"


_SLOT_NAMES = {"num": "{num}", "id": "{id}", "text": "{slug}"}


def _template_groups(rows, shape, literal_frac):
    """Split same-shape rows into groups that each match ONE template. Yields (parts, matching_rows).

    A position is literal when one value covers >= literal_frac of the rows still matching the
    literals chosen so far (and at least 2 of them, unless only one row is left); otherwise it is a
    variable slot. Rows that do not carry the chosen literals are split off and templated on their
    own, so a template never counts or exemplifies a URL it does not match.
    """
    queue = [rows]
    while queue:
        group = queue.pop()
        subset, parts = group, []
        for pos, cls in enumerate(shape):
            counts = Counter(r[pos] for r in subset)
            value, c = min(counts.items(), key=lambda kv: (-kv[1], kv[0]))
            if c / len(subset) >= literal_frac and (c >= 2 or len(subset) == 1):
                parts.append(value)
                subset = [r for r in subset if r[pos] == value]
            else:
                parts.append(_SLOT_NAMES[cls])
        yield parts, subset
        ids = {id(r) for r in subset}
        rest = [r for r in group if id(r) not in ids]
        if rest:
            queue.append(rest)


def url_template(paths, literal_frac=0.5):
    """Group paths into templates. Two stages:

    1. shape signature = depth + per-segment class (num / id / text);
    2. inside a shape, a position is `literal` when one value covers >= literal_frac of the
       group (and at least 2 URLs, unless the group is a single URL), else a variable slot.
       URLs that do not carry the chosen literals are templated separately, so every path listed
       under a template matches it.

    Returns [{"template", "count", "paths"}] sorted by count desc then template.
    """
    shapes = defaultdict(list)
    for p in paths:
        segs = [s for s in p.split("/") if s]
        shapes[tuple(segment_class(s) for s in segs)].append(segs)
    merged = {}
    for shape, rows in shapes.items():
        for parts, matching in _template_groups(rows, shape, literal_frac):
            tpl = "/" + "/".join(parts)
            entry = merged.setdefault(tpl, {"template": tpl, "count": 0, "paths": []})
            entry["count"] += len(matching)
            entry["paths"].extend("/" + "/".join(r) for r in matching)
    return sorted(merged.values(), key=lambda e: (-e["count"], e["template"]))
