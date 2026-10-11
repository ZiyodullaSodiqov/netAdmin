"""Mustaqil ish, referat, maqola (DOCX).

Avval reja (bo'limlar) tuziladi, keyin har bo'lim alohida va parallel yoziladi —
shunda kerakli hajm (varoqlar soni) chiqadi.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.shared import Cm, Pt

from ..ai.clients import openai_json
from ..services import LANG_FULL

WORDS_PER_PAGE = 300  # Times New Roman 14, 1.5 interval

LABELS = {
    "uz": {"plan": "REJA", "intro": "Kirish", "concl": "Xulosa", "refs": "Foydalanilgan adabiyotlar",
           "by": "Bajardi", "checked": "Tekshirdi", "topic": "Mavzu", "abstract": "Annotatsiya",
           "keywords": "Kalit so'zlar", "city": "Toshkent"},
    "ru": {"plan": "ПЛАН", "intro": "Введение", "concl": "Заключение", "refs": "Список использованной литературы",
           "by": "Выполнил(а)", "checked": "Проверил(а)", "topic": "Тема", "abstract": "Аннотация",
           "keywords": "Ключевые слова", "city": "Ташкент"},
}
TYPE_TITLE = {
    "uz": {"mustaqil ish": "MUSTAQIL ISH", "referat": "REFERAT", "ilmiy maqola": ""},
    "ru": {"mustaqil ish": "САМОСТОЯТЕЛЬНАЯ РАБОТА", "referat": "РЕФЕРАТ", "ilmiy maqola": ""},
}


async def generate_content(doc_type: str, topic: str, pages: int, lang: str, details: str = "") -> dict:
    L = LABELS[lang]
    system = f"Sen akademik matnlar yozuvchi mutaxassissan. Faqat JSON qaytar. Til: {LANG_FULL[lang]}."
    n_main = max(2, min(6, pages // 3))
    plan = await openai_json(system, (
        f"Hujjat turi: {doc_type}. Mavzu: {topic}. {('Talablar: ' + details) if details else ''}\n"
        f"{n_main} ta asosiy bo'lim nomini tuz (kirish va xulosadan tashqari). "
        'Format: {"title": "aniq sarlavha", "sections": ["..."], "keywords": ["5-7 ta"], '
        '"references": ["8-10 ta real, mavjud adabiyot: muallif, nom, nashriyot, yil"]}'
    ))
    sections = [s for s in plan.get("sections", []) if s][:n_main] or [topic]
    total_words = pages * WORDS_PER_PAGE
    # Titul va reja ~1.5 varoq oladi
    body_words = max(600, total_words - int(1.5 * WORDS_PER_PAGE))
    intro_w = concl_w = int(body_words * 0.1)
    sec_w = int((body_words - intro_w - concl_w) / len(sections))

    async def write(heading: str, words: int, role: str) -> dict:
        d = await openai_json(system, (
            f"{doc_type} — mavzu: «{plan.get('title', topic)}». Umumiy reja: {', '.join(sections)}.\n"
            f"Hozir faqat «{heading}» qismini yoz ({role}). Hajmi taxminan {words} so'z, "
            "4-8 ta abzats, ilmiy uslubda, aniq misollar va faktlar bilan, takrorsiz.\n"
            'Format: {"paragraphs": ["..."]}'
        ))
        return {"heading": heading, "paragraphs": [p for p in d.get("paragraphs", []) if p]}

    parts = await asyncio.gather(
        write(L["intro"], intro_w, "kirish"),
        *[write(s, sec_w, f"{i}-asosiy bo'lim") for i, s in enumerate(sections, 1)],
        write(L["concl"], concl_w, "xulosa"),
    )
    result = {"title": plan.get("title", topic), "sections": list(parts),
              "keywords": plan.get("keywords", []), "references": plan.get("references", [])}
    if doc_type == "ilmiy maqola":
        ab = await openai_json(system, (
            f"«{result['title']}» maqolasi uchun 60-90 so'zli annotatsiya yoz. "
            'Format: {"abstract": "...", "abstract_en": "inglizcha tarjimasi"}'))
        result.update(ab)
    return result


def _base_doc() -> Document:
    doc = Document()
    sec = doc.sections[0]
    sec.page_height, sec.page_width = Cm(29.7), Cm(21)
    sec.left_margin, sec.right_margin = Cm(3), Cm(1.5)
    sec.top_margin = sec.bottom_margin = Cm(2)
    st = doc.styles["Normal"]
    st.font.name, st.font.size = "Times New Roman", Pt(14)
    st.paragraph_format.line_spacing = 1.5
    st.paragraph_format.space_after = Pt(0)
    for name in ("Heading 1", "Heading 2"):
        h = doc.styles[name]
        h.font.name, h.font.size, h.font.bold = "Times New Roman", Pt(16 if name == "Heading 1" else 14), True
        h.font.color.rgb = None
    return doc


def _para(doc, text, *, bold=False, size=None, align=None, indent=True):
    p = doc.add_paragraph()
    r = p.add_run(text)
    r.bold = bold
    if size:
        r.font.size = Pt(size)
    if align is not None:
        p.alignment = align
    elif indent:
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        p.paragraph_format.first_line_indent = Cm(1.25)
    return p


def _page_break(doc):
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def build_docx(data: dict, out: Path, doc_type: str, lang: str, author: str = "", institution: str = "",
               teacher: str = "") -> Path:
    L = LABELS[lang]
    doc = _base_doc()
    C = WD_ALIGN_PARAGRAPH.CENTER

    if doc_type == "ilmiy maqola":
        _para(doc, data["title"].upper(), bold=True, size=16, align=C)
        if author:
            _para(doc, author, bold=True, align=WD_ALIGN_PARAGRAPH.RIGHT)
        if institution:
            _para(doc, institution, align=WD_ALIGN_PARAGRAPH.RIGHT)
        if data.get("abstract"):
            _para(doc, f"{L['abstract']}: ", bold=True, indent=False)
            _para(doc, data["abstract"])
        if data.get("keywords"):
            p = _para(doc, f"{L['keywords']}: ", bold=True, indent=False)
            p.add_run(", ".join(data["keywords"])).italic = True
        if data.get("abstract_en") and lang != "en":
            _para(doc, "Abstract: ", bold=True, indent=False)
            _para(doc, data["abstract_en"])
        for s in data["sections"]:
            _para(doc, s["heading"], bold=True, align=C)
            for t in s["paragraphs"]:
                _para(doc, t)
    else:
        # Titul varaq
        if institution:
            _para(doc, institution.upper(), bold=True, align=C)
        for _ in range(6):
            doc.add_paragraph()
        _para(doc, TYPE_TITLE[lang][doc_type], bold=True, size=28, align=C)
        _para(doc, f"{L['topic']}: {data['title']}", bold=True, size=16, align=C)
        for _ in range(6):
            doc.add_paragraph()
        if author:
            _para(doc, f"{L['by']}: {author}", align=WD_ALIGN_PARAGRAPH.RIGHT)
        if teacher:
            _para(doc, f"{L['checked']}: {teacher}", align=WD_ALIGN_PARAGRAPH.RIGHT)
        for _ in range(3):
            doc.add_paragraph()
        _para(doc, L["city"], align=C)
        _page_break(doc)
        # Reja
        _para(doc, L["plan"], bold=True, size=16, align=C)
        for i, s in enumerate(data["sections"]):
            label = s["heading"] if i in (0, len(data["sections"]) - 1) else f"{i}. {s['heading']}"
            _para(doc, label, indent=False)
        _para(doc, L["refs"], indent=False)
        _page_break(doc)
        for s in data["sections"]:
            doc.add_heading(s["heading"], level=1).alignment = C
            for t in s["paragraphs"]:
                _para(doc, t)

    if data.get("references"):
        if doc_type != "ilmiy maqola":
            _page_break(doc)
        _para(doc, L["refs"], bold=True, align=C)
        for i, ref in enumerate(data["references"], 1):
            _para(doc, f"{i}. {ref}", indent=False)

    _add_page_numbers(doc)
    doc.save(out)
    return out


def _add_page_numbers(doc) -> None:
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    p = doc.sections[0].footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run()
    for tag, text in (("begin", None), (None, "PAGE"), ("end", None)):
        if tag:
            el = OxmlElement("w:fldChar")
            el.set(qn("w:fldCharType"), tag)
        else:
            el = OxmlElement("w:instrText")
            el.set(qn("xml:space"), "preserve")
            el.text = text
        run._r.append(el)

