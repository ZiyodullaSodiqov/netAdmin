"""Ism bo'yicha kontaktni topish (lotin/kirill, qo'shimchalar, xatoliklarga chidamli)."""
from __future__ import annotations

import re
from difflib import SequenceMatcher

_CYR = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo", "ж": "j", "з": "z", "и": "i",
    "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t",
    "у": "u", "ф": "f", "х": "x", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sh", "ъ": "", "ы": "i", "ь": "",
    "э": "e", "ю": "yu", "я": "ya", "ў": "o", "қ": "q", "ғ": "g", "ҳ": "h",
}

# O'zbekcha kelishik va hurmat qo'shimchalari
_SUFFIXES = ("akaga", "opaga", "akadan", "opadan", "akaning", "opaning", "aka", "opa", "jon", "xon",
             "ning", "dan", "ga", "ni", "da", "ka", "qa")


def normalize(s: str | None) -> str:
    if not s:
        return ""
    s = s.lower().strip().lstrip("@")
    s = "".join(_CYR.get(ch, ch) for ch in s)
    s = s.replace("'", "").replace("`", "").replace("ʻ", "").replace("ʼ", "").replace("’", "")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def strip_suffix(word: str) -> str:
    for suf in _SUFFIXES:
        if word.endswith(suf) and len(word) - len(suf) >= 3:
            return word[: -len(suf)]
    return word


def _names(c: dict) -> list[str]:
    first = normalize(c.get("first_name"))
    last = normalize(c.get("last_name"))
    out = [n for n in (first, f"{first} {last}".strip(), normalize(c.get("username")), last) if n]
    return out


def score(query: str, contact: dict) -> float:
    q = normalize(query)
    if not q:
        return 0.0
    q_variants = {q, " ".join(strip_suffix(w) for w in q.split())}
    best = 0.0
    for name in _names(contact):
        for qv in q_variants:
            if qv == name:
                return 1.0
            r = SequenceMatcher(None, qv, name).ratio()
            # "Akmal" ↔ "Akmal Karimov": ismning birinchi so'zi mos kelsa
            if name.split()[0] == qv.split()[0]:
                r = max(r, 0.9)
            best = max(best, r)
    return best


def find_contact(query: str | None, contacts: list[dict], threshold: float = 0.8) -> dict | None:
    if not query:
        return None
    scored = sorted(((score(query, c), c) for c in contacts), key=lambda x: (-x[0], -int(x[1].get("is_contact") or 0)))
    if scored and scored[0][0] >= threshold:
        return scored[0][1]
    return None


def display_name(c: dict) -> str:
    name = " ".join(x for x in (c.get("first_name"), c.get("last_name")) if x).strip()
    return name or (f"@{c['username']}" if c.get("username") else str(c.get("tg_id")))
