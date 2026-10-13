"""Sertifikat, diplom, tashakkurnoma, faxriy/maqtov yorlig'i, daftar usti.

OpenAI: (1) foydalanuvchi yozgan erkin matndan maydonlar va rasmiy matn tuzadi, rang palitrasini tanlaydi;
(2) matnsiz bezakli fon rasm chizadi. Matnni Pillow aniq joylaydi — shunda kirill/lotin harflari buzilmaydi.
"""
from __future__ import annotations

import io
import logging
import math
from pathlib import Path

from PIL import Image, ImageDraw

from ..ai.clients import generate_image, vision_json
from ..imaging import cover, draw_text_box

log = logging.getLogger(__name__)

TITLES = {
    "certificate": {"uz": "SERTIFIKAT", "ru": "СЕРТИФИКАТ"},
    "diploma": {"uz": "DIPLOM", "ru": "ДИПЛОМ"},
    "gratitude": {"uz": "TASHAKKURNOMA", "ru": "БЛАГОДАРНОСТЬ"},
    "honor": {"uz": "FAXRIY YORLIQ", "ru": "ПОЧЁТНАЯ ГРАМОТА"},
    "honor_praise": {"uz": "MAQTOV YORLIG'I", "ru": "ПОХВАЛЬНЫЙ ЛИСТ"},
    "notebook": {"uz": "DAFTAR", "ru": "ТЕТРАДЬ"},
}

HINTS = {
    "certificate": "Kimga (F.I.Sh), nima uchun (kurs, tanlov...), tashkilot nomi, sana, imzo qo'yuvchi",
    "diploma": "Kimga (F.I.Sh), qaysi o'rin / yutuq, tadbir nomi, tashkilot, sana, imzo qo'yuvchi",
    "gratitude": "Kimga (F.I.Sh), nima uchun minnatdorchilik, tashkilot, sana, imzo qo'yuvchi",
    "honor": "Faxriy yorliqmi yoki maqtov yorlig'imi, kimga, nima uchun, tashkilot, sana, imzo qo'yuvchi",
    "notebook": "Fan nomi, o'quvchi F.I.Sh, sinf, maktab; xohlasangiz uslub (masalan: ko'k, minimalistik)",
}

LANG = {"uz": "o'zbek (lotin)", "ru": "rus"}

# 5 uslub — rang bilan birga kompozitsiya ham farq qiladi (layout):
# ornament — AI chizgan bezakli fon, markazda matn (ranglarni AI tanlaydi);
# side — chapda rangli lenta va muhr, matn chapga tekislangan;
# ribbon — ingichka qo'sh ramka, ism rangli lenta (bant) ustida, pastda oltin muhr;
# modern — oq fon, burchaklarda geometrik shakllar, katta chapga tekislangan sarlavha;
# dark — qorong'i hashamatli AI fon, oltin rangli matn va ramka
STYLES = [
    {"layout": "ornament", "ai": True},
    {"layout": "side", "ai": False, "primary": "#14306E", "accent": "#C49A3C"},
    {"layout": "ribbon", "ai": False, "primary": "#6E1A33", "accent": "#B8860B"},
    {"layout": "modern", "ai": False, "primary": "#0F6B57", "accent": "#F2A33A"},
    {"layout": "dark", "ai": True, "primary": "#E6C27A", "accent": "#F5E3B3",
     "bg": "dark navy blue luxury background with fine golden baroque ornament border, subtle texture"},
]


async def compose(doc: str, lang: str, user_text: str) -> dict:
    prompt = (
        f"Hujjat turi: {doc}. Til: {LANG[lang]}. Foydalanuvchi ma'lumoti:\n«{user_text}»\n\n"
        "Shu ma'lumotdan rasmiy, chiroyli hujjat matnini tuz (ortiqcha uydirma qo'shma, yetishmasa bo'sh qoldir). "
        "Dizayn uchun mos rang palitrasi va fon tasvirini tanla.\n"
        'Faqat JSON: {"variant": "honor|honor_praise (faqat faxriy/maqtov uchun)", "recipient": "F.I.Sh", '
        '"body": "2-4 gapli rasmiy matn (notebook uchun bo\'sh)", "org": "tashkilot", "date": "sana", '
        '"signer": "imzo qo\'yuvchi F.I.Sh", "signer_title": "lavozimi", '
        '"subject": "fan (faqat notebook)", "student_class": "sinf (faqat notebook)", "school": "maktab (notebook)", '
        '"primary": "#hex to\'q asosiy rang", "accent": "#hex oltin/yorqin urg\'u rangi", '
        '"background_prompt": "inglizcha: elegant ornamental border frame for a formal ... , no text"}'
    )
    return await vision_json(prompt, temperature=0.6)


def _hex(c: str, default: tuple) -> tuple:
    try:
        c = c.lstrip("#")
        return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
    except (ValueError, AttributeError):
        return default


def _fallback_background(size, primary, accent) -> Image.Image:
    w, h = size
    img = Image.new("RGB", size, (252, 249, 240))
    d = ImageDraw.Draw(img)
    m = int(min(w, h) * 0.035)
    d.rectangle((m, m, w - m, h - m), outline=primary, width=max(6, m // 3))
    m2 = m + max(14, m // 2)
    d.rectangle((m2, m2, w - m2, h - m2), outline=accent, width=max(3, m // 8))
    r = int(min(w, h) * 0.06)
    for cx, cy in ((m2, m2), (w - m2, m2), (m2, h - m2), (w - m2, h - m2)):
        d.ellipse((cx - r // 2, cy - r // 2, cx + r // 2, cy + r // 2), fill=accent, outline=primary, width=4)
    return img


def _seal(d: ImageDraw.ImageDraw, cx: int, cy: int, r: int, fill, ring) -> None:
    """Oltin muhr: tishli doira + ichki halqa + yulduz."""
    pts = []
    for k in range(48):
        a = math.pi * 2 * k / 48
        rr = r if k % 2 == 0 else r * 0.9
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    d.polygon(pts, fill=fill)
    d.ellipse((cx - r * 0.75, cy - r * 0.75, cx + r * 0.75, cy + r * 0.75), outline=ring, width=max(3, r // 25))
    star = []
    for k in range(10):
        a = -math.pi / 2 + math.pi * k / 5
        rr = r * 0.45 if k % 2 == 0 else r * 0.18
        star.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    d.polygon(star, fill=ring)


def _ribbon(d: ImageDraw.ImageDraw, x0: int, y0: int, x1: int, y1: int, color, tail) -> None:
    h = y1 - y0
    n = int(h * 0.5)
    d.polygon([(x0 - n * 2, y0 + h * 0.25), (x0 + n, y0 + h * 0.25), (x0 + n, y1 + h * 0.25),
               (x0 - n * 2, y1 + h * 0.25), (x0 - n, y0 + h * 0.75)], fill=tail)
    d.polygon([(x1 + n * 2, y0 + h * 0.25), (x1 - n, y0 + h * 0.25), (x1 - n, y1 + h * 0.25),
               (x1 + n * 2, y1 + h * 0.25), (x1 + n, y0 + h * 0.75)], fill=tail)
    d.rectangle((x0, y0, x1, y1), fill=color)


def _darker(c, k=0.6):
    return tuple(int(v * k) for v in c)


async def _ai_bg(prompt: str, size, portrait: bool) -> Image.Image | None:
    raw = await generate_image(prompt, "1024x1536" if portrait else "1536x1024")
    if not raw:
        return None
    try:
        return cover(Image.open(io.BytesIO(raw)).convert("RGB"), size)
    except Exception:  # noqa: BLE001
        log.exception("bad background image")
        return None


def _sign_block(img, data, x0, x1, y, color, align_date="left") -> None:
    d = ImageDraw.Draw(img)
    w = img.width
    if data.get("date"):
        draw_text_box(img, data["date"], (x0, y, x0 + int(w * 0.25), y + 80), "serif", 58, color, align=align_date)
    sign = " ".join(s for s in (data.get("signer_title", ""), data.get("signer", "")) if s)
    if sign:
        lx = x1 - int(w * 0.3)
        d.line((lx, y - 10, x1, y - 10), fill=color, width=3)
        draw_text_box(img, sign, (lx, y, x1, y + 120), "serif", 54, color, align="right", valign="top")


async def render(doc: str, lang: str, data: dict, out: Path, use_ai_background: bool = True,
                 style: int = 0) -> Path:
    preset = STYLES[style % len(STYLES)]
    layout = preset["layout"]
    if "primary" in preset:
        data = {**data, "primary": preset["primary"], "accent": preset["accent"]}
    portrait = doc == "notebook"
    size = (1748, 2480) if portrait else (3508, 2480)  # A5 tik / A4 yotiq, 300 dpi
    w, h = size
    primary = _hex(data.get("primary", ""), (20, 50, 110))
    accent = _hex(data.get("accent", ""), (196, 154, 60))
    variant = data.get("variant") if doc == "honor" and data.get("variant") in ("honor", "honor_praise") else doc
    title = TITLES[variant][lang]
    dark = (35, 35, 35)
    orient = "portrait notebook cover" if portrait else "landscape A4 certificate"
    tail = ". " + orient + " background, high resolution, empty center area for text, absolutely no text, no letters."

    bg = None
    if preset["ai"] and use_ai_background:
        base = preset.get("bg") or data.get("background_prompt") or f"elegant ornamental frame for a formal {doc}"
        bg = await _ai_bg(base + tail, size, portrait)

    if layout == "ornament":
        img = (bg or _fallback_background(size, primary, accent)).convert("RGBA")
        panel = Image.new("RGBA", size, (0, 0, 0, 0))
        px, py = int(w * 0.13), int(h * (0.12 if portrait else 0.13))
        ImageDraw.Draw(panel).rounded_rectangle((px, py, w - px, h - py), radius=40, fill=(255, 255, 255, 205))
        img = Image.alpha_composite(img, panel).convert("RGB")
        x0, x1 = px + int(w * 0.04), w - px - int(w * 0.04)
        _centered(img, doc, data, title, portrait, x0, x1, primary, accent, dark)

    elif layout == "dark":
        if bg is None:
            bg = Image.new("RGB", size, (16, 24, 48))
            dd = ImageDraw.Draw(bg)
            m = int(min(w, h) * 0.04)
            dd.rectangle((m, m, w - m, h - m), outline=primary, width=10)
            dd.rectangle((m + 30, m + 30, w - m - 30, h - m - 30), outline=primary, width=3)
        img = bg.convert("RGBA")
        shade = Image.new("RGBA", size, (0, 0, 0, 0))
        px, py = int(w * 0.14), int(h * 0.15)
        ImageDraw.Draw(shade).rounded_rectangle((px, py, w - px, h - py), radius=40, fill=(8, 14, 30, 170))
        img = Image.alpha_composite(img, shade).convert("RGB")
        x0, x1 = px + int(w * 0.04), w - px - int(w * 0.04)
        _centered(img, doc, data, title, portrait, x0, x1, primary, accent, (235, 235, 240))

    elif layout == "side":
        img = Image.new("RGB", size, (250, 250, 252))
        d = ImageDraw.Draw(img)
        if portrait:
            bh = int(h * 0.3)
            d.rectangle((0, 0, w, bh), fill=primary)
            d.rectangle((0, bh, w, bh + 18), fill=accent)
            _seal(d, w // 2, bh, int(w * 0.11), accent, primary)
            x0, x1 = int(w * 0.1), int(w * 0.9)
            draw_text_box(img, title, (x0, int(h * 0.06), x1, int(h * 0.2)), "bold", 150, (255, 255, 255))
            _notebook_text(img, data, x0, x1, int(h * 0.42), primary, accent, dark, align="left")
        else:
            bw = int(w * 0.26)
            d.rectangle((0, 0, bw, h), fill=primary)
            d.rectangle((bw, 0, bw + 22, h), fill=accent)
            _seal(d, bw // 2, int(h * 0.5), int(bw * 0.3), accent, primary)
            x0, x1 = bw + int(w * 0.06), w - int(w * 0.07)
            draw_text_box(img, title, (x0, int(h * 0.1), x1, int(h * 0.26)), "bold", 230, primary, align="left")
            d.rectangle((x0, int(h * 0.275), x0 + int(w * 0.12), int(h * 0.275) + 14), fill=accent)
            if data.get("org"):
                draw_text_box(img, data["org"], (x0, int(h * 0.3), x1, int(h * 0.37)), "regular", 64, dark,
                              align="left")
            if data.get("recipient"):
                draw_text_box(img, data["recipient"], (x0, int(h * 0.4), x1, int(h * 0.52)), "bold", 150, accent,
                              align="left")
            if data.get("body"):
                draw_text_box(img, data["body"], (x0, int(h * 0.54), x1, int(h * 0.72)), "regular", 66, dark,
                              align="left", valign="top")
            _sign_block(img, data, x0, x1, int(h * 0.8), dark)

    elif layout == "ribbon":
        img = Image.new("RGB", size, (253, 250, 243))
        d = ImageDraw.Draw(img)
        m = int(min(w, h) * 0.03)
        d.rectangle((m, m, w - m, h - m), outline=accent, width=6)
        d.rectangle((m + 24, m + 24, w - m - 24, h - m - 24), outline=primary, width=3)
        x0, x1 = int(w * 0.1), int(w * 0.9)
        if portrait:
            draw_text_box(img, title, (x0, int(h * 0.1), x1, int(h * 0.2)), "serif_bold", 160, primary)
            ry0, ry1 = int(h * 0.3), int(h * 0.38)
            _ribbon(d, int(w * 0.14), ry0, int(w * 0.86), ry1, primary, _darker(primary))
            draw_text_box(img, data.get("subject", "") or title, (int(w * 0.16), ry0, int(w * 0.84), ry1),
                          "serif_bold", 100, (255, 255, 255))
            lines = [s for s in (data.get("recipient"), data.get("student_class"), data.get("school")) if s]
            draw_text_box(img, "\n".join(lines), (x0, int(h * 0.48), x1, int(h * 0.72)), "serif", 80, dark,
                          line_gap=1.5)
            _seal(d, w // 2, int(h * 0.84), int(w * 0.1), accent, primary)
        else:
            draw_text_box(img, title, (x0, int(h * 0.1), x1, int(h * 0.24)), "serif_bold", 220, primary)
            if data.get("org"):
                draw_text_box(img, data["org"], (x0, int(h * 0.25), x1, int(h * 0.31)), "serif", 64, dark)
            ry0, ry1 = int(h * 0.35), int(h * 0.47)
            _ribbon(d, int(w * 0.2), ry0, int(w * 0.8), ry1, primary, _darker(primary))
            if data.get("recipient"):
                draw_text_box(img, data["recipient"], (int(w * 0.22), ry0, int(w * 0.78), ry1), "serif_bold", 130,
                              (255, 255, 255))
            if data.get("body"):
                draw_text_box(img, data["body"], (x0 + 120, int(h * 0.53), x1 - 120, int(h * 0.68)), "serif", 68,
                              dark)
            _seal(d, w // 2, int(h * 0.8), int(h * 0.09), accent, primary)
            _sign_block(img, data, int(w * 0.12), int(w * 0.88), int(h * 0.8), dark)

    else:  # modern
        img = Image.new("RGB", size, (255, 255, 255))
        d = ImageDraw.Draw(img)
        a = int(min(w, h) * 0.35)
        d.polygon([(0, 0), (a, 0), (0, a)], fill=primary)
        d.polygon([(0, 0), (int(a * 0.6), 0), (0, int(a * 0.6))], fill=_darker(primary, 0.8))
        d.polygon([(w, h), (w - a, h), (w, h - a)], fill=accent)
        d.polygon([(w, h), (w - int(a * 0.5), h), (w, h - int(a * 0.5))], fill=primary)
        x0, x1 = int(w * 0.12), int(w * 0.88)
        if portrait:
            draw_text_box(img, (data.get("subject") or title).upper(), (x0, int(h * 0.3), x1, int(h * 0.46)),
                          "bold", 190, primary, align="left")
            d.rectangle((x0, int(h * 0.47), x0 + int(w * 0.25), int(h * 0.47) + 16), fill=accent)
            lines = [s for s in (data.get("recipient"), data.get("student_class"), data.get("school")) if s]
            draw_text_box(img, "\n".join(lines), (x0, int(h * 0.52), x1, int(h * 0.72)), "regular", 76, dark,
                          align="left", valign="top", line_gap=1.5)
            draw_text_box(img, title, (x0, int(h * 0.2), x1, int(h * 0.27)), "regular", 80, (120, 120, 120),
                          align="left")
        else:
            draw_text_box(img, title, (x0, int(h * 0.14), x1, int(h * 0.3)), "bold", 240, primary, align="left")
            d.rectangle((x0, int(h * 0.31), x0 + int(w * 0.1), int(h * 0.31) + 16), fill=accent)
            if data.get("org"):
                draw_text_box(img, data["org"].upper(), (x0, int(h * 0.34), x1, int(h * 0.39)), "regular", 56,
                              (110, 110, 110), align="left")
            if data.get("recipient"):
                draw_text_box(img, data["recipient"], (x0, int(h * 0.42), x1, int(h * 0.55)), "bold", 170, dark,
                              align="left")
            if data.get("body"):
                draw_text_box(img, data["body"], (x0, int(h * 0.57), int(w * 0.75), int(h * 0.72)), "regular", 64,
                              (70, 70, 70), align="left", valign="top")
            _sign_block(img, data, x0, int(w * 0.72), int(h * 0.8), dark)

    img.save(out, "PNG", dpi=(300, 300))
    return out


def _notebook_text(img, data, x0, x1, y0, primary, accent, dark, align="center"):
    h = img.height
    y = y0
    if data.get("subject"):
        y = draw_text_box(img, data["subject"], (x0, y, x1, y + int(h * 0.1)), "bold", 130, primary, align=align)
    lines = [s for s in (data.get("recipient"), data.get("student_class"), data.get("school")) if s]
    draw_text_box(img, "\n".join(lines), (x0, y + 40, x1, int(h * 0.85)), "regular", 80, dark, align=align,
                  valign="top", line_gap=1.5)


def _centered(img, doc, data, title, portrait, x0, x1, primary, accent, text):
    w, h = img.size
    if portrait:
        y = draw_text_box(img, title, (x0, int(h * 0.2), x1, int(h * 0.3)), "serif_bold", 170, primary)
        if data.get("subject"):
            draw_text_box(img, data["subject"], (x0, y + 40, x1, y + 260), "serif_bold", 110, accent)
        lines = [s for s in (data.get("recipient"), data.get("student_class"), data.get("school")) if s]
        draw_text_box(img, "\n".join(lines), (x0, int(h * 0.55), x1, int(h * 0.8)), "serif", 80, text,
                      line_gap=1.5)
        return
    draw_text_box(img, title, (x0, int(h * 0.17), x1, int(h * 0.31)), "serif_bold", 220, primary)
    if data.get("org"):
        draw_text_box(img, data["org"], (x0, int(h * 0.31), x1, int(h * 0.37)), "serif", 70, text)
    if data.get("recipient"):
        draw_text_box(img, data["recipient"], (x0, int(h * 0.39), x1, int(h * 0.5)), "serif_bold", 140, accent)
    if data.get("body"):
        draw_text_box(img, data["body"], (x0 + 80, int(h * 0.51), x1 - 80, int(h * 0.7)), "serif", 72, text)
    _sign_block(img, data, x0, x1, int(h * 0.77), text)


def png_to_pdf(png: Path, out: Path) -> Path:
    Image.open(png).convert("RGB").save(out, "PDF", resolution=300)
    return out
