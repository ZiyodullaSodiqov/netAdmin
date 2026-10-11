"""Karta xabarlari botining (CardXabar, Humo/Uzcard SMS-bot va h.k.) xabarlarini tahlil qilish.

Misollar:
    🟢 Пополнение ➕ 10 000.00 UZS 📍 CLICK P2P 💳 HUMOCARD *1234 🕓 14:25 11.10.2026 💰 125 000.00 UZS
    Popolnenie scheta: 10,000.00 UZS Karta: ***1234 Data: 11.10.26 14:25 Dostupno: 125,000.00 UZS
    To'ldirish ➕ 10 000 so'm 💳 *1234 🕓 11.10.2026 14:25
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, tzinfo

CREDIT_WORDS = (
    "пополнение", "поступление", "зачисление", "перевод на карту", "popolnenie", "postuplenie", "zachislenie",
    "to'ldirish", "toʻldirish", "to‘ldirish", "toldirish", "kirim", "o'tkazma qabul", "qabul qilindi", "➕",
    "credit", "incoming",
)
DEBIT_WORDS = (
    "списание", "оплата", "покупка", "снятие", "spisanie", "oplata", "pokupka", "yechib", "xarid",
    "➖", "debit", "отмена", "otmena", "bekor",
)
BALANCE_MARKERS = ("💰", "баланс", "остаток", "доступно", "dostupno", "balans", "qoldiq", "ostatok", "available")

NUM = r"(\d{1,3}(?:[  .,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)"
AMOUNT_RE = re.compile(NUM + r"\s*(?:UZS|uzs|сум|so['ʻ‘’`]?m|sum|сўм)", re.I)
DT_PATTERNS = [
    (re.compile(r"(?<!\d)(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})"), "ymdt"),
    (re.compile(r"(?<!\d)(\d{1,2}):(\d{2})(?::\d{2})?\s+(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?!\d)"), "tdmy"),
    (re.compile(r"(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})[ ,T]+(\d{1,2}):(\d{2})"), "dmyt"),
]
CARD_RE = re.compile(r"\*{1,}\s?(\d{4})\b")


@dataclass
class CardTx:
    amount: int
    paid_at: datetime | None
    card_last4: str | None


def parse_amount(s: str) -> int:
    s = s.replace(" ", " ").strip()
    m = re.match(r"^(.*?)[.,](\d{1,2})$", s)
    if m:
        s = m.group(1)  # tiyinlarni tashlaymiz
    return int(re.sub(r"[^\d]", "", s) or 0)


def parse_datetime(text: str, tz: tzinfo) -> datetime | None:
    for rx, kind in DT_PATTERNS:
        m = rx.search(text)
        if not m:
            continue
        g = [int(x) for x in m.groups()]
        if kind == "tdmy":
            hh, mi, d, mo, y = g
        elif kind == "dmyt":
            d, mo, y, hh, mi = g
        else:
            y, mo, d, hh, mi = g
        if y < 100:
            y += 2000
        try:
            return datetime(y, mo, d, hh, mi, tzinfo=tz)
        except ValueError:
            continue
    return None


def is_credit(text: str) -> bool:
    low = text.lower()
    credit = any(w in low for w in CREDIT_WORDS)
    debit = any(w in low for w in DEBIT_WORDS)
    return credit and not debit


def parse_card_message(text: str, tz: tzinfo) -> CardTx | None:
    """Kirim (karta to'ldirilishi) bo'lsa CardTx, aks holda None."""
    if not text or not is_credit(text):
        return None
    amount = None
    # Satrlar bo'yicha: balans satridagi summani olmaymiz
    for line in re.split(r"[\n\r]+|(?=💰)|(?=💳)|(?=🕓)|(?=📍)", text):
        if any(b in line.lower() for b in BALANCE_MARKERS):
            continue
        m = AMOUNT_RE.search(line)
        if m:
            amount = parse_amount(m.group(1))
            break
    if not amount:
        return None
    card = CARD_RE.search(text)
    return CardTx(amount=amount, paid_at=parse_datetime(text, tz), card_last4=card.group(1) if card else None)
