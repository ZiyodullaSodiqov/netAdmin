"""Vaqt bilan ishlash. Bazada barcha vaqtlar UTC da 'YYYY-MM-DDTHH:MM:SSZ' ko'rinishida saqlanadi."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

UTC = timezone.utc
FMT = "%Y-%m-%dT%H:%M:%SZ"

WEEKDAYS_UZ = ["Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba", "Yakshanba"]
MONTHS_UZ = [
    "yanvar", "fevral", "mart", "aprel", "may", "iyun",
    "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr",
]


def utcnow() -> datetime:
    return datetime.now(UTC)


def to_db(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).strftime(FMT)


def from_db(s: str | None) -> datetime | None:
    if not s:
        return None
    return datetime.strptime(s, FMT).replace(tzinfo=UTC)


def now_db() -> str:
    return to_db(utcnow())  # type: ignore[return-value]


def parse_hhmm(s: str | None, default: time = time(9, 0)) -> time:
    if not s:
        return default
    try:
        h, m = s.strip().split(":")[:2]
        return time(int(h), int(m))
    except (ValueError, TypeError):
        return default


def parse_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(s.strip()[:10])
    except ValueError:
        return None


def combine_local(d: date, t: time, tz: ZoneInfo) -> datetime:
    return datetime.combine(d, t, tzinfo=tz)


def build_due(due_date: str | None, due_time: str | None, tz: ZoneInfo,
              default_time: time) -> tuple[str | None, bool]:
    """AI qaytargan sana/vaqtdan (lokal) UTC qatorini yasaydi. (due_at, has_time)."""
    d = parse_date(due_date)
    if d is None:
        return None, False
    has_time = bool(due_time and ":" in due_time)
    t = parse_hhmm(due_time, default_time) if has_time else default_time
    return to_db(combine_local(d, t, tz)), has_time


def fmt_local(s: str | None, tz: ZoneInfo, has_time: bool = True) -> str:
    dt = from_db(s)
    if dt is None:
        return "muddatsiz"
    loc = dt.astimezone(tz)
    today = datetime.now(tz).date()
    d = loc.date()
    if d == today:
        day = "bugun"
    elif d == today + timedelta(days=1):
        day = "ertaga"
    elif d == today - timedelta(days=1):
        day = "kecha"
    else:
        day = f"{d.day}-{MONTHS_UZ[d.month - 1]}"
        if d.year != today.year:
            day += f" {d.year}"
        day += f" ({WEEKDAYS_UZ[d.weekday()].lower()})"
    return f"{day}, {loc:%H:%M}" if has_time else day


def now_context(tz: ZoneInfo) -> str:
    n = datetime.now(tz)
    return f"{n:%Y-%m-%d %H:%M}, {WEEKDAYS_UZ[n.weekday()]} ({tz.key})"


def local_day_bounds(d: date, tz: ZoneInfo) -> tuple[str, str]:
    start = datetime.combine(d, time(0, 0), tzinfo=tz)
    end = start + timedelta(days=1)
    return to_db(start), to_db(end)  # type: ignore[return-value]
