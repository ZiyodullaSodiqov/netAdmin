"""Taqdimot (PPTX) — matn OpenAI dan, ko'rinish python-pptx bilan."""
from __future__ import annotations

from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Pt

from ..ai.clients import openai_json
from ..services import LANG_FULL

# 5 uslub: rang, shrift va joylashuv (top — yuqorida sarlavha paneli, side — chap tomonda chiziq)
# 5 uslub — har biri o'z joylashuvi (layout) bilan, faqat rang emas:
# classic — yuqorida sarlavha paneli va ro'yxat; cards — punktlar raqamli kartochkalarda;
# split — chapda rangli panelda sarlavha, o'ngda raqamli punktlar; bold — qorong'i fon, katta tartib raqami;
# timeline — punktlar chiziq bo'ylab bosqichlar ko'rinishida
THEMES = [
    {"layout": "classic", "bg": "FFFFFF", "accent": "1F4E79", "accent2": "2E75B6", "text": "222222",
     "on_accent": "FFFFFF", "muted": "6B7280", "font": "Calibri"},
    {"layout": "cards", "bg": "F6F4EF", "accent": "7A1F3D", "accent2": "C9A227", "text": "2B2B2B",
     "on_accent": "FFFFFF", "muted": "7C6F64", "font": "Georgia", "card": "FFFFFF"},
    {"layout": "split", "bg": "FFFFFF", "accent": "0F6B57", "accent2": "35B88F", "text": "1F2A24",
     "on_accent": "FFFFFF", "muted": "5F7A70", "font": "Arial"},
    {"layout": "bold", "bg": "171B26", "accent": "F5A524", "accent2": "4FC3F7", "text": "E8EAF0",
     "on_accent": "171B26", "muted": "9AA3B2", "font": "Trebuchet MS"},
    {"layout": "timeline", "bg": "FFFFFF", "accent": "5B3FA8", "accent2": "18A999", "text": "2A2540",
     "on_accent": "FFFFFF", "muted": "6E6890", "font": "Cambria"},
]

END_TEXT = {"uz": "E'tiboringiz uchun rahmat!", "ru": "Спасибо за внимание!", "en": "Thank you for your attention!"}


async def generate_content(topic: str, slides: int, lang: str, details: str = "") -> dict:
    system = (
        "Sen tajribali o'qituvchi va taqdimot dizaynerisan. Faqat JSON qaytar. "
        f"Barcha matn {LANG_FULL[lang]} tilida bo'lsin."
    )
    user = (
        f"Mavzu: {topic}\n{('Qo`shimcha talablar: ' + details) if details else ''}\n"
        f"Jami {slides} ta slayd: 1-slayd sarlavha, oxirgisi \"rahmat\" slaydi (ularni men qo'shaman), oxirgidan oldingisi xulosa. Har bir slaydda 3-5 ta mazmunli, "
        "aniq faktlarga asoslangan punkt (har biri 8-20 so'z). Takrorlanmasin.\n"
        'Format: {"title": "...", "subtitle": "...", "slides": [{"title": "...", "bullets": ["..."]}]} '
        f"— slides massivida aynan {slides - 2} ta element bo'lsin (sarlavha va rahmat slaydlarisiz)."
    )
    data = await openai_json(system, user)
    data.setdefault("title", topic)
    data["slides"] = [s for s in data.get("slides", []) if s.get("title")][: slides - 2]
    return data


def _rgb(h: str) -> RGBColor:
    return RGBColor.from_string(h)


def _shape(slide, kind, x, y, w, h, color: str, line: str | None = None):
    shp = slide.shapes.add_shape(kind, int(x), int(y), int(w), int(h))
    shp.fill.solid()
    shp.fill.fore_color.rgb = _rgb(color)
    if line:
        shp.line.color.rgb = _rgb(line)
    else:
        shp.line.fill.background()
    shp.shadow.inherit = False
    return shp


def _rect(slide, x, y, w, h, color: str):
    return _shape(slide, MSO_SHAPE.RECTANGLE, x, y, w, h, color)


def _bg(slide, color: str):
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = _rgb(color)


def _text(slide, x, y, w, h, text: str, size: float, color: str, font: str, bold: bool = False,
          align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
    tb = slide.shapes.add_textbox(int(x), int(y), int(w), int(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = Emu(0)
    p = tf.paragraphs[0]
    p.text = text
    p.alignment = align
    p.font.size, p.font.bold, p.font.color.rgb, p.font.name = Pt(size), bold, _rgb(color), font
    return tf


def _bullets(slide, x, y, w, h, items: list[str], t: dict, marker: str = "▪", size: float | None = None):
    tb = slide.shapes.add_textbox(int(x), int(y), int(w), int(h))
    tf = tb.text_frame
    tf.word_wrap = True
    size = size or (20 if sum(len(b) for b in items) < 420 else 17)
    for j, b in enumerate(items):
        p = tf.paragraphs[0] if j == 0 else tf.add_paragraph()
        p.text = f"{marker} {b}" if marker else b
        p.font.size, p.font.color.rgb, p.font.name = Pt(size), _rgb(t["text"]), t["font"]
        p.space_after = Pt(10)
    return tf


def _fit(n_chars: int, base: float, floor: float) -> float:
    """Matn uzunligiga qarab shrift o'lchami."""
    return max(floor, base - max(0, n_chars - 60) / 25)


# ---------- sarlavha slaydlari ----------

def _title_slide(s, W, H, t, data, author):
    L, f = t["layout"], t["font"]
    title, sub = data["title"], data.get("subtitle", "")
    if L == "classic":
        _bg(s, t["accent"])
        _rect(s, 0, H * 0.62, W, H * 0.012, t["accent2"])
        _text(s, W * 0.07, H * 0.22, W * 0.86, H * 0.3, title, 40, t["on_accent"], f, True, anchor=MSO_ANCHOR.BOTTOM)
        _text(s, W * 0.07, H * 0.52, W * 0.86, H * 0.08, sub, 20, t["on_accent"], f)
        _text(s, W * 0.07, H * 0.7, W * 0.86, H * 0.1, author, 18, t["on_accent"], f)
    elif L == "cards":
        _bg(s, t["bg"])
        _rect(s, 0, 0, W * 0.42, H, t["accent"])
        _shape(s, MSO_SHAPE.OVAL, W * 0.3, H * 0.62, W * 0.2, W * 0.2, t["accent2"])
        _text(s, W * 0.48, H * 0.25, W * 0.47, H * 0.35, title, 36, t["accent"], f, True, anchor=MSO_ANCHOR.BOTTOM)
        _rect(s, W * 0.48, H * 0.63, W * 0.1, H * 0.008, t["accent2"])
        _text(s, W * 0.48, H * 0.66, W * 0.47, H * 0.1, sub, 18, t["muted"], f)
        _text(s, W * 0.06, H * 0.08, W * 0.32, H * 0.1, author, 16, t["on_accent"], f)
    elif L == "split":
        _bg(s, t["bg"])
        _shape(s, MSO_SHAPE.RIGHT_TRIANGLE, W * 0.45, 0, W * 0.55, H, t["accent"]).rotation = 180
        _shape(s, MSO_SHAPE.RIGHT_TRIANGLE, W * 0.7, H * 0.5, W * 0.3, H * 0.5, t["accent2"]).rotation = 180
        _text(s, W * 0.06, H * 0.2, W * 0.5, H * 0.4, title, 38, t["accent"], f, True, anchor=MSO_ANCHOR.BOTTOM)
        _text(s, W * 0.06, H * 0.62, W * 0.45, H * 0.1, sub, 18, t["muted"], f)
        _text(s, W * 0.06, H * 0.82, W * 0.45, H * 0.08, author, 16, t["text"], f, True)
    elif L == "bold":
        _bg(s, t["bg"])
        _rect(s, W * 0.06, H * 0.18, W * 0.012, H * 0.5, t["accent"])
        _text(s, W * 0.1, H * 0.16, W * 0.82, H * 0.4, title.upper(), 40, t["text"], f, True, anchor=MSO_ANCHOR.BOTTOM)
        _text(s, W * 0.1, H * 0.58, W * 0.8, H * 0.1, sub, 20, t["accent"], f)
        _text(s, W * 0.1, H * 0.84, W * 0.8, H * 0.08, author, 16, t["muted"], f)
    else:  # timeline
        _bg(s, t["bg"])
        for i, (cx, cy, r, c) in enumerate([(0.9, 0.1, 0.22, "accent"), (0.08, 0.92, 0.16, "accent2"),
                                            (0.82, 0.86, 0.07, "accent2")]):
            _shape(s, MSO_SHAPE.OVAL, W * (cx - r / 2), H * cy - W * r / 2, W * r, W * r, t[c])
        _text(s, W * 0.12, H * 0.28, W * 0.76, H * 0.3, title, 40, t["accent"], f, True,
              PP_ALIGN.CENTER, MSO_ANCHOR.BOTTOM)
        _text(s, W * 0.12, H * 0.6, W * 0.76, H * 0.1, sub, 20, t["muted"], f, align=PP_ALIGN.CENTER)
        _text(s, W * 0.12, H * 0.72, W * 0.76, H * 0.08, author, 16, t["text"], f, align=PP_ALIGN.CENTER)


# ---------- mazmun slaydlari ----------

def _content_slide(s, W, H, t, sl, num: int, total: int):
    L, f = t["layout"], t["font"]
    title, items = sl["title"], [b for b in (sl.get("bullets") or []) if b][:6]
    _bg(s, t["bg"])
    if L == "classic":
        _rect(s, 0, 0, W, H * 0.16, t["accent"])
        _rect(s, 0, H * 0.16, W * 0.25, H * 0.01, t["accent2"])
        _text(s, W * 0.05, H * 0.03, W * 0.9, H * 0.11, title, 28, t["on_accent"], f, True, anchor=MSO_ANCHOR.MIDDLE)
        _bullets(s, W * 0.06, H * 0.22, W * 0.88, H * 0.68, items, t, "▪")
    elif L == "cards":
        _text(s, W * 0.05, H * 0.05, W * 0.9, H * 0.12, title, 30, t["accent"], f, True)
        _rect(s, W * 0.05, H * 0.18, W * 0.08, H * 0.008, t["accent2"])
        cols = 2 if len(items) > 3 else 1
        rows = (len(items) + cols - 1) // cols or 1
        gx, gy = W * 0.025, H * 0.03
        cw = (W * 0.9 - gx * (cols - 1)) / cols
        ch = (H * 0.7 - gy * (rows - 1)) / rows
        for k, b in enumerate(items):
            x = W * 0.05 + (k % cols) * (cw + gx)
            y = H * 0.24 + (k // cols) * (ch + gy)
            _shape(s, MSO_SHAPE.ROUNDED_RECTANGLE, x, y, cw, ch, t["card"], line="E2DED4")
            _shape(s, MSO_SHAPE.OVAL, x + W * 0.015, y + ch / 2 - H * 0.035, H * 0.07, H * 0.07, t["accent"])
            _text(s, x + W * 0.015, y + ch / 2 - H * 0.035, H * 0.07, H * 0.07, str(k + 1), 16, t["on_accent"], f,
                  True, PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
            _text(s, x + W * 0.015 + H * 0.09, y, cw - H * 0.12, ch, b, _fit(len(b), 17, 12), t["text"], f,
                  anchor=MSO_ANCHOR.MIDDLE)
    elif L == "split":
        _rect(s, 0, 0, W * 0.34, H, t["accent"])
        _rect(s, W * 0.34, 0, W * 0.008, H, t["accent2"])
        _text(s, W * 0.04, H * 0.1, W * 0.27, H * 0.7, title, _fit(len(title), 30, 20), t["on_accent"], f, True,
              anchor=MSO_ANCHOR.MIDDLE)
        n = len(items) or 1
        step = H * 0.8 / n
        for k, b in enumerate(items):
            y = H * 0.1 + k * step
            _shape(s, MSO_SHAPE.OVAL, W * 0.39, y + step / 2 - H * 0.03, H * 0.06, H * 0.06, t["accent2"])
            _text(s, W * 0.39, y + step / 2 - H * 0.03, H * 0.06, H * 0.06, str(k + 1), 14, "FFFFFF", f, True,
                  PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
            _text(s, W * 0.39 + H * 0.09, y, W * 0.56 - H * 0.09, step, b, _fit(len(b), 18, 12), t["text"], f,
                  anchor=MSO_ANCHOR.MIDDLE)
    elif L == "bold":
        _text(s, W * 0.04, H * 0.04, W * 0.2, H * 0.3, f"{num - 1:02d}", 80, t["accent"], f, True)
        _text(s, W * 0.25, H * 0.08, W * 0.7, H * 0.2, title, 30, t["text"], f, True, anchor=MSO_ANCHOR.MIDDLE)
        _rect(s, W * 0.25, H * 0.3, W * 0.7, H * 0.004, t["muted"])
        n = len(items) or 1
        step = H * 0.6 / n
        for k, b in enumerate(items):
            y = H * 0.34 + k * step
            _rect(s, W * 0.25, y + step * 0.2, W * 0.006, step * 0.6, t["accent2"] if k % 2 else t["accent"])
            _text(s, W * 0.27, y, W * 0.68, step, b, _fit(len(b), 18, 12), t["text"], f, anchor=MSO_ANCHOR.MIDDLE)
    else:  # timeline
        _text(s, W * 0.05, H * 0.05, W * 0.9, H * 0.13, title, 28, t["accent"], f, True, PP_ALIGN.CENTER)
        n = len(items) or 1
        if n <= 5:
            ly = H * 0.42
            _rect(s, W * 0.06, ly, W * 0.88, H * 0.008, t["accent2"])
            step = W * 0.88 / n
            for k, b in enumerate(items):
                cx = W * 0.06 + step * (k + 0.5)
                _shape(s, MSO_SHAPE.OVAL, cx - H * 0.045, ly - H * 0.041, H * 0.09, H * 0.09, t["accent"])
                _text(s, cx - H * 0.045, ly - H * 0.041, H * 0.09, H * 0.09, str(k + 1), 16, t["on_accent"], f, True,
                      PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
                _text(s, cx - step / 2 + W * 0.01, ly + H * 0.08, step - W * 0.02, H * 0.42, b,
                      _fit(len(b), 15, 11), t["text"], f, align=PP_ALIGN.CENTER)
        else:
            _rect(s, W * 0.1, H * 0.22, W * 0.006, H * 0.7, t["accent2"])
            step = H * 0.7 / n
            for k, b in enumerate(items):
                y = H * 0.22 + k * step
                _shape(s, MSO_SHAPE.OVAL, W * 0.1 - H * 0.02, y + step / 2 - H * 0.02, H * 0.04, H * 0.04, t["accent"])
                _text(s, W * 0.13, y, W * 0.8, step, b, _fit(len(b), 16, 11), t["text"], f, anchor=MSO_ANCHOR.MIDDLE)
    _text(s, W * 0.86, H * 0.92, W * 0.1, H * 0.06, f"{num}/{total}", 11, t["muted"], f, align=PP_ALIGN.RIGHT)


def _end_slide(s, W, H, t, lang):
    text = END_TEXT.get(lang, END_TEXT["uz"])
    if t["layout"] in ("classic", "cards"):
        _bg(s, t["accent"])
        color = t["on_accent"]
    else:
        _bg(s, t["bg"])
        color = t["accent"]
        _rect(s, W * 0.4, H * 0.62, W * 0.2, H * 0.01, t["accent2"])
    _text(s, W * 0.07, H * 0.35, W * 0.86, H * 0.25, text, 40, color, t["font"], True, PP_ALIGN.CENTER,
          MSO_ANCHOR.MIDDLE)


def build_pptx(data: dict, out: Path, lang: str, author: str = "", theme: int = 0) -> Path:
    t = THEMES[theme % len(THEMES)]
    prs = Presentation()
    prs.slide_width, prs.slide_height = Emu(12192000), Emu(6858000)  # 16:9
    W, H = prs.slide_width, prs.slide_height
    blank = prs.slide_layouts[6]
    total = len(data["slides"]) + 2
    _title_slide(prs.slides.add_slide(blank), W, H, t, data, author)
    for i, sl in enumerate(data["slides"], start=2):
        _content_slide(prs.slides.add_slide(blank), W, H, t, sl, i, total)
    _end_slide(prs.slides.add_slide(blank), W, H, t, lang)
    prs.save(out)
    return out
