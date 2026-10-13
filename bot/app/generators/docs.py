"""Mustaqil ish, referat, maqola (DOCX).

Avval reja (bo'limlar) tuziladi, keyin har bo'lim alohida va parallel yoziladi —
shunda kerakli hajm (varoqlar soni) chiqadi.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

from ..ai.clients import openai_json
from ..services import LANG_FULL

WORDS_PER_PAGE = 300  # Times New Roman 14, 1.5 interval

# 5 uslub: shrift, sarlavha rangi/joylashuvi, sahifa ramkasi
# 5 uslub — rangdan tashqari tuzilish ham farq qiladi (kind):
# classic — an'anaviy titul, markazda sarlavhalar;
# framed — sahifa ramkasi, titulda ramkali blok, raqamli va tagiga chiziqli sarlavhalar;
# band — titulda rangli lenta, sarlavhalar rangli fonda, har sahifada yuqorida mavzu;
# academic — chap chiziqli sarlavhalar, titulda «Bajardi/Tekshirdi» jadvali, abzatslar orasida bo'shliq;
# minimal — chapga tekislangan katta sarlavhalar «01, 02...», titulda katta nom va urg'u chizig'i
STYLES = [
    {"kind": "classic", "font": "Times New Roman", "size": 14, "spacing": 1.5, "head": None, "border": None},
    {"kind": "framed", "font": "Times New Roman", "size": 14, "spacing": 1.5, "head": "1F3864",
     "border": ("double", 6, "1F3864")},
    {"kind": "band", "font": "Arial", "size": 12, "spacing": 1.5, "head": "0F6B57", "border": None},
    {"kind": "academic", "font": "Cambria", "size": 13, "spacing": 1.4, "head": "7A1F3D", "border": None},
    {"kind": "minimal", "font": "Calibri", "size": 13, "spacing": 1.3, "head": "2F5597",
     "border": ("single", 4, "BFCBE6")},
]

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


def _page_border(sec, kind: str, size: int, color: str) -> None:
    borders = OxmlElement("w:pgBorders")
    borders.set(qn("w:offsetFrom"), "page")
    for side in ("top", "left", "bottom", "right"):
        el = OxmlElement(f"w:{side}")
        el.set(qn("w:val"), kind)
        el.set(qn("w:sz"), str(size))
        el.set(qn("w:space"), "24")
        el.set(qn("w:color"), color)
        borders.append(el)
    # OOXML sxemasida pgBorders pgMar dan keyin turishi shart (aks holda Word faylni "buzilgan" deydi)
    pg_mar = sec._sectPr.find(qn("w:pgMar"))
    if pg_mar is not None:
        pg_mar.addnext(borders)
    else:
        sec._sectPr.append(borders)


def _base_doc(st: dict | None = None) -> Document:
    st = st or STYLES[0]
    doc = Document()
    sec = doc.sections[0]
    sec.page_height, sec.page_width = Cm(29.7), Cm(21)
    sec.left_margin, sec.right_margin = Cm(3), Cm(1.5)
    sec.top_margin = sec.bottom_margin = Cm(2)
    normal = doc.styles["Normal"]
    normal.font.name, normal.font.size = st["font"], Pt(st["size"])
    normal.paragraph_format.line_spacing = st["spacing"]
    normal.paragraph_format.space_after = Pt(0)
    for name in ("Heading 1", "Heading 2"):
        h = doc.styles[name]
        h.font.name, h.font.size, h.font.bold = st["font"], Pt(st["size"] + (2 if name == "Heading 1" else 0)), True
        h.font.color.rgb = RGBColor.from_string(st["head"]) if st["head"] else None
    if st["border"]:
        _page_border(sec, *st["border"])
    return doc


def _para(doc, text, *, bold=False, size=None, align=None, indent=True, color=None):
    p = doc.add_paragraph()
    r = p.add_run(text)
    r.bold = bold
    if size:
        r.font.size = Pt(size)
    if color:
        r.font.color.rgb = RGBColor.from_string(color)
    if align is not None:
        p.alignment = align
    elif indent:
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        p.paragraph_format.first_line_indent = Cm(1.25)
    return p


def _shade(p, color: str) -> None:
    ppr = p._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), color)
    ppr.append(shd)


def _pborder(p, sides: tuple[str, ...], color: str, size: int = 12, space: int = 4) -> None:
    ppr = p._p.get_or_add_pPr()
    bdr = OxmlElement("w:pBdr")
    for side in ("top", "left", "bottom", "right"):
        if side in sides:
            el = OxmlElement(f"w:{side}")
            el.set(qn("w:val"), "single")
            el.set(qn("w:sz"), str(size))
            el.set(qn("w:space"), str(space))
            el.set(qn("w:color"), color)
            bdr.append(el)
    # pBdr pPr ichida shd dan oldin turishi kerak
    shd = ppr.find(qn("w:shd"))
    if shd is not None:
        shd.addprevious(bdr)
    else:
        ppr.append(bdr)


def _heading(doc, st: dict, text: str, num: int | None, level_title: bool = False) -> None:
    """Bo'lim sarlavhasi — uslubga qarab har xil ko'rinishda."""
    kind, hc = st["kind"], st["head"] or "000000"
    size = st["size"] + 2
    if kind == "classic":
        p = doc.add_heading(text, level=1)
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    elif kind == "framed":
        label = f"{num}. {text}" if num else text
        p = _para(doc, label, bold=True, size=size, align=WD_ALIGN_PARAGRAPH.LEFT, color=hc)
        _pborder(p, ("bottom",), hc, 8)
    elif kind == "band":
        p = _para(doc, "  " + text, bold=True, size=size, align=WD_ALIGN_PARAGRAPH.LEFT, color="FFFFFF")
        _shade(p, hc)
    elif kind == "academic":
        p = _para(doc, text.upper() if level_title else text, bold=True, size=size,
                  align=WD_ALIGN_PARAGRAPH.LEFT, color=hc)
        _pborder(p, ("left",), hc, 36, 8)
    else:  # minimal
        label = f"{num:02d}  {text}" if num else text
        p = _para(doc, label, size=size + 6, align=WD_ALIGN_PARAGRAPH.LEFT, color=hc)
    p.paragraph_format.space_before = Pt(12)
    p.paragraph_format.space_after = Pt(8)
    p.paragraph_format.keep_with_next = True


def _title_page(doc, st: dict, L: dict, doc_type: str, lang: str, title: str, author: str, institution: str,
                teacher: str) -> None:
    kind, hc = st["kind"], st["head"] or "000000"
    C, R, LEFT = WD_ALIGN_PARAGRAPH.CENTER, WD_ALIGN_PARAGRAPH.RIGHT, WD_ALIGN_PARAGRAPH.LEFT
    type_title = TYPE_TITLE[lang][doc_type]

    def gap(n):
        for _ in range(n):
            doc.add_paragraph()

    if kind == "band":
        if institution:
            _para(doc, institution.upper(), bold=True, align=LEFT, color=hc)
        gap(5)
        for txt, size in ((type_title, 30), (title, 18)):
            p = _para(doc, "  " + txt, bold=True, size=size, align=LEFT, color="FFFFFF")
            _shade(p, hc)
        gap(7)
        for lbl, val in ((L["by"], author), (L["checked"], teacher)):
            if val:
                _para(doc, f"{lbl}: {val}", align=LEFT)
        gap(2)
        _para(doc, L["city"], align=LEFT, color=hc)
    elif kind == "academic":
        if institution:
            p = _para(doc, institution.upper(), bold=True, align=C, color=hc)
            _pborder(p, ("bottom",), hc, 12)
        gap(6)
        _para(doc, type_title, bold=True, size=26, align=C, color=hc)
        _para(doc, title, bold=True, size=17, align=C)
        gap(6)
        rows = [(L["by"], author), (L["checked"], teacher)]
        rows = [r for r in rows if r[1]]
        if rows:
            t = doc.add_table(rows=len(rows), cols=2)
            t.style = "Table Grid"
            for i, (lbl, val) in enumerate(rows):
                t.cell(i, 0).text, t.cell(i, 1).text = lbl, val
        gap(3)
        _para(doc, L["city"], align=C)
    elif kind == "minimal":
        if institution:
            _para(doc, institution, align=LEFT, color="7F7F7F")
        gap(6)
        _para(doc, type_title, size=16, align=LEFT, color=hc)
        p = _para(doc, title, bold=True, size=30, align=LEFT)
        _pborder(p, ("bottom",), hc, 24, 12)
        gap(8)
        for lbl, val in ((L["by"], author), (L["checked"], teacher)):
            if val:
                _para(doc, f"{lbl} — {val}", align=LEFT, color="595959")
        _para(doc, L["city"], align=LEFT, color="7F7F7F")
    else:  # classic / framed
        if institution:
            _para(doc, institution.upper(), bold=True, align=C)
        gap(6)
        if kind == "framed":
            p = _para(doc, type_title, bold=True, size=28, align=C, color=hc)
            _pborder(p, ("top", "left", "right"), hc, 12, 8)
            p = _para(doc, f"{L['topic']}: {title}", bold=True, size=16, align=C)
            _pborder(p, ("bottom", "left", "right"), hc, 12, 8)
        else:
            _para(doc, type_title, bold=True, size=28, align=C)
            _para(doc, f"{L['topic']}: {title}", bold=True, size=16, align=C)
        gap(6)
        if author:
            _para(doc, f"{L['by']}: {author}", align=R)
        if teacher:
            _para(doc, f"{L['checked']}: {teacher}", align=R)
        gap(3)
        _para(doc, L["city"], align=C)


def _page_break(doc):
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def build_docx(data: dict, out: Path, doc_type: str, lang: str, author: str = "", institution: str = "",
               teacher: str = "", style: int = 0) -> Path:
    L = LABELS[lang]
    st = STYLES[style % len(STYLES)]
    doc = _base_doc(st)
    C = WD_ALIGN_PARAGRAPH.CENTER
    HC = st["head"]
    academic = st["kind"] == "academic"

    def body(text):
        p = _para(doc, text)
        if academic:  # akademik uslub: chekinishsiz, abzatslar orasida bo'shliq
            p.paragraph_format.first_line_indent = Cm(0)
            p.paragraph_format.space_after = Pt(8)

    sections = data["sections"]
    if st["kind"] == "band":
        hp = doc.sections[0].header.paragraphs[0]
        hp.text = data["title"]
        hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        if hp.runs:
            hp.runs[0].font.size, hp.runs[0].font.color.rgb = Pt(9), RGBColor.from_string(HC)
        _pborder(hp, ("bottom",), HC, 6)

    if doc_type == "ilmiy maqola":
        _para(doc, data["title"].upper(), bold=True, size=16, align=C, color=HC)
        if author:
            _para(doc, author, bold=True, align=WD_ALIGN_PARAGRAPH.RIGHT)
        if institution:
            _para(doc, institution, align=WD_ALIGN_PARAGRAPH.RIGHT)
        if data.get("abstract"):
            _para(doc, f"{L['abstract']}: ", bold=True, indent=False)
            body(data["abstract"])
        if data.get("keywords"):
            p = _para(doc, f"{L['keywords']}: ", bold=True, indent=False)
            p.add_run(", ".join(data["keywords"])).italic = True
        if data.get("abstract_en") and lang != "en":
            _para(doc, "Abstract: ", bold=True, indent=False)
            body(data["abstract_en"])
        for k, sec in enumerate(sections):
            _heading(doc, st, sec["heading"], k if 0 < k < len(sections) - 1 else None)
            for t in sec["paragraphs"]:
                body(t)
    else:
        _title_page(doc, st, L, doc_type, lang, data["title"], author, institution, teacher)
        _page_break(doc)
        # Reja
        _heading(doc, st, L["plan"], None, level_title=True)
        for k, sec in enumerate(sections):
            label = sec["heading"] if k in (0, len(sections) - 1) else f"{k}. {sec['heading']}"
            _para(doc, label, indent=False)
        _para(doc, L["refs"], indent=False)
        _page_break(doc)
        for k, sec in enumerate(sections):
            _heading(doc, st, sec["heading"], k if 0 < k < len(sections) - 1 else None, level_title=True)
            for t in sec["paragraphs"]:
                body(t)

    if data.get("references"):
        if doc_type != "ilmiy maqola":
            _page_break(doc)
        _heading(doc, st, L["refs"], None, level_title=True)
        for i, ref in enumerate(data["references"], 1):
            _para(doc, f"{i}. {ref}", indent=False)

    _add_page_numbers(doc)
    doc.save(out)
    return out


def _add_page_numbers(doc) -> None:
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

