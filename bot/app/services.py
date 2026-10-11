"""Xizmatlar katalogi va narxlar.

Narxlar so'mda. `price` — xizmatning o'zi, `print_price` — qog'ozda chiqarish.
`base_pages` bo'lgan xizmatlarda foydalanuvchi boshqa hajm tanlasa narx mutanosib o'zgaradi.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from .config import config


@dataclass(frozen=True)
class Service:
    key: str
    title: str
    kind: str  # slides | doc | tests | convert | ocr | design | photo34 | math
    price: int
    print_price: int = 0
    base_pages: int = 0
    page_options: tuple[int, ...] = ()
    langs: tuple[str, ...] = ()  # bo'sh bo'lsa til so'ralmaydi
    ai: str = ""
    extra: dict = field(default_factory=dict)

    def price_for(self, pages: int | None = None) -> int:
        if self.base_pages and pages:
            return _round(self.price * pages / self.base_pages)
        return self.price

    def print_price_for(self, pages: int | None = None) -> int:
        if self.base_pages and pages:
            return _round(self.print_price * pages / self.base_pages)
        return self.print_price


def _round(x: float) -> int:
    """Narxni 500 so'mga yaxlitlash (yuqoriga)."""
    return int(math.ceil(x / 500.0) * 500)


UZ_RU = ("uz", "ru")

SERVICES: dict[str, Service] = {s.key: s for s in [
    Service("slides", "🖥 Slayd tayyorlash", "slides", 10_000, 5_000, 10, (10, 15, 20), UZ_RU, "openai"),
    Service("mustaqil", "📘 Mustaqil ish", "doc", 10_000, 3_000, 10, (10, 15, 20), UZ_RU, "openai",
            {"doc_type": "mustaqil ish"}),
    Service("referat", "📗 Referat", "doc", 10_000, 3_000, 10, (10, 15, 20), UZ_RU, "openai",
            {"doc_type": "referat"}),
    Service("maqola", "📰 Maqola yozish", "doc", 10_000, 3_000, 7, (7, 10, 14), UZ_RU, "openai",
            {"doc_type": "ilmiy maqola"}),
    Service("word2pdf", "📄 Word → PDF", "convert", 2_000, extra={"direction": "word2pdf"}),
    Service("pdf2word", "🔁 PDF → Word", "convert", 5_000, extra={"direction": "pdf2word"}),
    Service("img2word", "🖼 Rasm → Word", "ocr", 5_000, ai="openai", extra={"fix": False}),
    Service("img2word_fix", "🛠 Rasm → Word (fix)", "ocr", 5_000, ai="openai", extra={"fix": True}),
    Service("sertifikat", "🏅 Sertifikat", "design", 3_000, 5_000, langs=UZ_RU, ai="openai",
            extra={"doc": "certificate"}),
    Service("diplom", "🎓 Diplom", "design", 3_000, 5_000, langs=UZ_RU, ai="openai", extra={"doc": "diploma"}),
    Service("tashakkurnoma", "🙏 Tashakkurnoma", "design", 3_000, 5_000, langs=UZ_RU, ai="openai",
            extra={"doc": "gratitude"}),
    Service("faxriy", "🎖 Faxriy / maqtov yorlig'i", "design", 3_000, 5_000, langs=UZ_RU, ai="openai",
            extra={"doc": "honor"}),
    Service("daftar", "📓 Daftar usti", "design", 3_000, 500, langs=UZ_RU, ai="openai", extra={"doc": "notebook"}),
    Service("photo34", "📸 3x4 rasm (10x15 listda 9 dona)", "photo34", 5_000, 5_000),
    Service("math", "🧮 Misol yechish (rasmdan)", "math", 3_000, ai="openai",
            extra={"pack": 10, "free": 1}),
    Service("tests", "📝 Testlar tuzish", "tests", config.price_tests, langs=("uz", "en", "ru"), ai="openai"),
]}

LANG_NAMES = {"uz": "🇺🇿 O'zbekcha", "ru": "🇷🇺 Русский", "en": "🇬🇧 English"}
LANG_FULL = {"uz": "o'zbek (lotin alifbosida)", "ru": "rus", "en": "ingliz"}


def fmt_sum(x: int) -> str:
    return f"{x:,}".replace(",", " ") + " so'm"
