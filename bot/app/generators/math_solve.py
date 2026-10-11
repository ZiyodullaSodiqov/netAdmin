"""Rasmdagi misolni yechish (Gemini vision)."""
from __future__ import annotations

import html

from ..ai.clients import gemini_json

PROMPT = (
    "Rasmdagi matematik misol(lar)ni yech. Har bir qadamni qisqa va tushunarli tushuntir, "
    "formulalarni oddiy matnda yoz (masalan x^2, sqrt(3), 1/2). Javob tili: {lang}.\n"
    'Faqat JSON: {{"problems": [{{"problem": "shart", "steps": ["..."], "answer": "..."}}], '
    '"readable": true}} — agar rasmda misol bo\'lmasa yoki o\'qib bo\'lmasa readable=false.'
)


async def solve(image: bytes, mime: str, lang: str = "o'zbek") -> dict:
    return await gemini_json(PROMPT.format(lang=lang), [(image, mime)], temperature=0.1)


def format_html(d: dict) -> str:
    parts = []
    for i, p in enumerate(d.get("problems", []), 1):
        e = html.escape
        steps = "\n".join(f"  {j}) {e(s)}" for j, s in enumerate(p.get("steps", []), 1))
        parts.append(f"<b>{i}. {e(p.get('problem', ''))}</b>\n{steps}\n✅ <b>Javob:</b> {e(str(p.get('answer', '')))}")
    return "\n\n".join(parts)
