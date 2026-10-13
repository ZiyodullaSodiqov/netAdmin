"""Test savollari: til, fan, mavzu, sinf asosida — variantlarga ajratilgan DOCX + javoblar kaliti."""
from __future__ import annotations

import asyncio
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.shared import Cm, Pt, RGBColor

from ..ai.clients import openai_json
from ..services import LANG_FULL

LABELS = {
    "uz": {"variant": "{n}-variant", "class": "{n}-sinf", "keys": "JAVOBLAR KALITI", "name": "F.I.Sh: ____________",
           "subject": "Fan", "topic": "Mavzu"},
    "ru": {"variant": "Вариант {n}", "class": "{n} класс", "keys": "КЛЮЧИ ОТВЕТОВ", "name": "Ф.И.О.: ____________",
           "subject": "Предмет", "topic": "Тема"},
    "en": {"variant": "Variant {n}", "class": "Grade {n}", "keys": "ANSWER KEY", "name": "Name: ____________",
           "subject": "Subject", "topic": "Topic"},
}
LETTERS = "ABCD"

# 5 uslub: shrift, sarlavha rangi, javob variantlarining joylashuvi (list — ustun, grid — 2x2, inline — bir qatorda)
STYLES = [
    {"font": "Times New Roman", "head": None, "opts": "list"},
    {"font": "Arial", "head": "1F4E79", "opts": "grid"},
    {"font": "Calibri", "head": "0F7B6C", "opts": "inline"},
    {"font": "Cambria", "head": "7A1F3D", "opts": "list"},
    {"font": "Georgia", "head": "5B3FA8", "opts": "grid"},
]


async def generate_variants(subject: str, topic: str, grade: str, lang: str, variants: int, count: int) -> list[list[dict]]:
    system = (f"Sen {grade}-sinf o'quvchilari uchun test tuzuvchi tajribali o'qituvchisan. Faqat JSON qaytar. "
              f"Barcha savol va javoblar {LANG_FULL[lang]} tilida.")

    async def one(n: int) -> list[dict]:
        d = await openai_json(system, (
            f"Fan: {subject}. Mavzu: {topic}. Sinf: {grade}. Bu {n}-variant (boshqa variantlardan farqli savollar).\n"
            f"Aynan {count} ta test savoli tuz, har birida 4 ta javob varianti, faqat bittasi to'g'ri. "
            "Qiyinlik sinf darajasiga mos, osondan qiyinga. To'g'ri javob o'rni tasodifiy bo'lsin.\n"
            'Format: {"questions": [{"q": "...", "options": ["..","..","..",".."], "answer": 0}]} '
            "(answer — to'g'ri javob indeksi 0-3)"
        ), temperature=0.8)
        qs = []
        for q in d.get("questions", []):
            opts = [str(o) for o in q.get("options", [])][:4]
            if q.get("q") and len(opts) == 4 and int(q.get("answer", -1)) in range(4):
                qs.append({"q": q["q"], "options": opts, "answer": int(q["answer"])})
        return qs[:count]

    return list(await asyncio.gather(*[one(i) for i in range(1, variants + 1)]))


def build_docx(variants: list[list[dict]], out: Path, subject: str, topic: str, grade: str, lang: str,
               style: int = 0) -> Path:
    L = LABELS[lang]
    ts = STYLES[style % len(STYLES)]
    head_color = RGBColor.from_string(ts["head"]) if ts["head"] else None
    doc = Document()
    sec = doc.sections[0]
    sec.page_height, sec.page_width = Cm(29.7), Cm(21)
    sec.left_margin = sec.right_margin = Cm(1.8)
    sec.top_margin = sec.bottom_margin = Cm(1.5)
    st = doc.styles["Normal"]
    st.font.name, st.font.size = ts["font"], Pt(12)
    st.paragraph_format.space_after = Pt(2)

    for vi, qs in enumerate(variants, 1):
        if vi > 1:
            doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
        h = doc.add_paragraph()
        h.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = h.add_run(f"{L['variant'].format(n=vi)}  •  {L['class'].format(n=grade)}")
        r.bold, r.font.size = True, Pt(15)
        if head_color:
            r.font.color.rgb = head_color
        doc.add_paragraph(f"{L['subject']}: {subject}    {L['topic']}: {topic}")
        doc.add_paragraph(L["name"])
        for qi, q in enumerate(qs, 1):
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(6)
            qr = p.add_run(f"{qi}. {q['q']}")
            qr.bold = True
            if head_color:
                qr.font.color.rgb = head_color
            _options(doc, q["options"], ts["opts"])

    # Javoblar kaliti
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
    h = doc.add_paragraph()
    h.alignment = WD_ALIGN_PARAGRAPH.CENTER
    kr = h.add_run(L["keys"])
    kr.bold = True
    if head_color:
        kr.font.color.rgb = head_color
    for vi, qs in enumerate(variants, 1):
        doc.add_paragraph().add_run(L["variant"].format(n=vi)).bold = True
        cols = 10
        rows = (len(qs) + cols - 1) // cols
        t = doc.add_table(rows=rows * 2, cols=cols)
        t.style = "Table Grid"
        for i, q in enumerate(qs):
            rr, cc = (i // cols) * 2, i % cols
            t.cell(rr, cc).text = str(i + 1)
            t.cell(rr + 1, cc).text = LETTERS[q["answer"]]
    doc.save(out)
    return out


def _options(doc, options: list[str], layout: str) -> None:
    if layout == "inline":
        op = doc.add_paragraph("     ".join(f"{LETTERS[i]}) {o}" for i, o in enumerate(options)))
        op.paragraph_format.left_indent = Cm(0.8)
    elif layout == "grid":
        t = doc.add_table(rows=2, cols=2)
        for i, o in enumerate(options):
            t.cell(i // 2, i % 2).text = f"{LETTERS[i]}) {o}"
    else:
        for i, o in enumerate(options):
            op = doc.add_paragraph(f"{LETTERS[i]}) {o}")
            op.paragraph_format.left_indent = Cm(0.8)
