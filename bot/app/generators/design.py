"""Sertifikat, diplom, tashakkurnoma, faxriy/maqtov yorlig'i, daftar usti.

OpenAI: (1) foydalanuvchi yozgan erkin matndan maydonlar va rasmiy matn tuzadi, rang palitrasini tanlaydi;
(2) matnsiz bezakli fon rasm chizadi. Matnni Pillow aniq joylaydi — shunda kirill/lotin harflari buzilmaydi.
"""
from __future__ import annotations

import io
import logging
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

# 5 uslub. 0-uslub — AI tanlagan ranglar va fon, qolganlari tayyor palitralar bilan
STYLES = [
    None,
    {"primary": "#14306E", "accent": "#C49A3C",
     "bg": "classic navy blue and gold guilloche ornamental border, luxury formal certificate style"},
    {"primary": "#0E5A43", "accent": "#C9A227",
     "bg": "emerald green and gold art deco geometric frame, elegant and festive"},
    {"primary": "#6E1A33", "accent": "#B8860B",
     "bg": "burgundy and gold baroque floral ornament corners, vintage parchment texture"},
    {"primary": "#1F3A93", "accent": "#18A999",
     "bg": "modern minimal design with soft abstract blue and teal gradient waves along the edges, clean white"},
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
    for i in range(h):  # yengil gradient
        t = i / h
        d.line([(0, i), (w, i)], fill=tuple(int(252 - 10 * t + (c - 252) * 0.04) for c in primary))
    m = int(min(w, h) * 0.035)
    d.rectangle((m, m, w - m, h - m), outline=primary, width=max(6, m // 3))
    m2 = m + max(14, m // 2)
    d.rectangle((m2, m2, w - m2, h - m2), outline=accent, width=max(3, m // 8))
    r = int(min(w, h) * 0.06)
    for cx, cy in ((m2, m2), (w - m2, m2), (m2, h - m2), (w - m2, h - m2)):
        d.ellipse((cx - r // 2, cy - r // 2, cx + r // 2, cy + r // 2), fill=accent, outline=primary, width=4)
    return img


async def render(doc: str, lang: str, data: dict, out: Path, use_ai_background: bool = True,
                 style: int = 0) -> Path:
    preset = STYLES[style % len(STYLES)]
    if preset:
        data = {**data, "primary": preset["primary"], "accent": preset["accent"],
                "background_prompt": preset["bg"] + f", for a {doc}"}
    portrait = doc == "notebook"
    size = (1748, 2480) if portrait else (3508, 2480)  # A5 tik / A4 yotiq, 300 dpi
    primary = _hex(data.get("primary", ""), (20, 50, 110))
    accent = _hex(data.get("accent", ""), (196, 154, 60))

    bg = None
    if use_ai_background:
        orient = "portrait notebook cover" if portrait else "landscape A4 certificate"
        prompt = (data.get("background_prompt") or f"elegant ornamental frame for a formal {doc}") + \
            f". {orient} background, high resolution, empty center area for text, absolutely no text, no letters."
        raw = await generate_image(prompt, "1024x1536" if portrait else "1536x1024")
        if raw:
            try:
                bg = cover(Image.open(io.BytesIO(raw)).convert("RGB"), size)
            except Exception:  # noqa: BLE001
                log.exception("bad background image")
    if bg is None:
        bg = _fallback_background(size, primary, accent)

    img = bg.convert("RGBA")
    w, h = size
    # Matn o'qilishi uchun yarim shaffof panel
    panel = Image.new("RGBA", size, (0, 0, 0, 0))
    pd = ImageDraw.Draw(panel)
    px, py = int(w * 0.13), int(h * (0.12 if portrait else 0.13))
    pd.rounded_rectangle((px, py, w - px, h - py), radius=40, fill=(255, 255, 255, 205))
    img = Image.alpha_composite(img, panel).convert("RGB")

    variant = data.get("variant") if doc == "honor" and data.get("variant") in ("honor", "honor_praise") else doc
    title = TITLES[variant][lang]
    dark = (35, 35, 35)
    x0, x1 = px + int(w * 0.04), w - px - int(w * 0.04)

    if portrait:
        y = draw_text_box(img, title, (x0, int(h * 0.2), x1, int(h * 0.3)), "serif_bold", 170, primary)
        subj = data.get("subject", "")
        if subj:
            draw_text_box(img, subj, (x0, y + 40, x1, y + 260), "serif_bold", 110, accent)
        lines = [s for s in (data.get("recipient"), data.get("student_class"), data.get("school")) if s]
        draw_text_box(img, "\n".join(lines), (x0, int(h * 0.55), x1, int(h * 0.8)), "serif", 80, dark,
                      line_gap=1.5)
    else:
        draw_text_box(img, title, (x0, int(h * 0.17), x1, int(h * 0.31)), "serif_bold", 220, primary)
        if data.get("org"):
            draw_text_box(img, data["org"], (x0, int(h * 0.31), x1, int(h * 0.37)), "serif", 70, dark)
        if data.get("recipient"):
            draw_text_box(img, data["recipient"], (x0, int(h * 0.39), x1, int(h * 0.5)), "serif_bold", 140, accent)
        if data.get("body"):
            draw_text_box(img, data["body"], (x0 + 80, int(h * 0.51), x1 - 80, int(h * 0.7)), "serif", 72, dark)
        d = ImageDraw.Draw(img)
        sy = int(h * 0.77)
        if data.get("date"):
            draw_text_box(img, data["date"], (x0, sy, x0 + int(w * 0.25), sy + 80), "serif", 58, dark, align="left")
        sign = " ".join(s for s in (data.get("signer_title", ""), data.get("signer", "")) if s)
        if sign:
            lx = x1 - int(w * 0.32)
            d.line((lx, sy - 10, x1, sy - 10), fill=dark, width=3)
            draw_text_box(img, sign, (lx, sy, x1, sy + 120), "serif", 54, dark, align="right", valign="top")

    img.save(out, "PNG", dpi=(300, 300))
    return out


def png_to_pdf(png: Path, out: Path) -> Path:
    Image.open(png).convert("RGB").save(out, "PDF", resolution=300)
    return out
