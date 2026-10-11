"""Pillow yordamchilari: shriftlar, matnni joylash, suv belgisi (watermark)."""
from __future__ import annotations

import io
import math
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .config import config


@lru_cache(maxsize=64)
def font(kind: str, size: int) -> ImageFont.FreeTypeFont:
    path = {"regular": config.font_regular, "bold": config.font_bold,
            "serif": config.font_serif, "serif_bold": config.font_serif_bold}[kind]
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default(size)


def wrap(draw: ImageDraw.ImageDraw, text: str, fnt, max_w: int) -> list[str]:
    lines: list[str] = []
    for para in text.split("\n"):
        cur = ""
        for word in para.split():
            test = f"{cur} {word}".strip()
            if draw.textlength(test, font=fnt) <= max_w or not cur:
                cur = test
            else:
                lines.append(cur)
                cur = word
        lines.append(cur)
    return lines


def draw_text_box(img: Image.Image, text: str, box: tuple[int, int, int, int], kind: str, max_size: int,
                  fill, min_size: int = 14, align: str = "center", line_gap: float = 1.25,
                  valign: str = "center") -> int:
    """Matnni qutichaga sig'adigan eng katta shrift bilan yozadi. Pastki y ni qaytaradi."""
    x0, y0, x1, y1 = box
    d = ImageDraw.Draw(img)
    size = max_size
    while True:
        f = font(kind, size)
        lines = wrap(d, text, f, x1 - x0)
        lh = int(size * line_gap)
        total = lh * len(lines)
        if total <= (y1 - y0) or size <= min_size:
            break
        size = max(min_size, int(size * 0.92))
    y = y0 if valign == "top" else y0 + max(0, ((y1 - y0) - total) // 2)
    for ln in lines:
        w = d.textlength(ln, font=f)
        x = x0 if align == "left" else (x1 - w if align == "right" else x0 + ((x1 - x0) - w) / 2)
        d.text((x, y), ln, font=f, fill=fill)
        y += lh
    return y


def watermark(img: Image.Image, text: str = "NAMUNA • TO'LOVDAN KEYIN", max_side: int = 1280) -> Image.Image:
    """Ko'rib chiqish uchun: kichraytiradi va diagonal takroriy suv belgisi qo'yadi."""
    img = img.convert("RGB")
    img.thumbnail((max_side, max_side))
    w, h = img.size
    layer = Image.new("RGBA", (w * 2, h * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    f = font("bold", max(18, w // 22))
    step_y = max(60, h // 7)
    tw = int(d.textlength(text, font=f)) + 80
    for row, y in enumerate(range(0, h * 2, step_y)):
        off = (row % 2) * tw // 2
        for x in range(-tw, w * 2, tw):
            d.text((x + off, y), text, font=f, fill=(200, 30, 30, 85))
    layer = layer.rotate(30, resample=Image.BICUBIC)
    left, top = (layer.width - w) // 2, (layer.height - h) // 2
    layer = layer.crop((left, top, left + w, top + h))
    out = Image.alpha_composite(img.convert("RGBA"), layer)
    # Markazda katta yozuv
    d = ImageDraw.Draw(out)
    big = font("bold", max(28, w // 9))
    label = "NAMUNA"
    bw = d.textlength(label, font=big)
    d.text(((w - bw) / 2, h / 2 - big.size / 2), label, font=big, fill=(220, 0, 0, 110))
    return out.convert("RGB")


def blur_bottom(img: Image.Image, keep: float = 0.45) -> Image.Image:
    """Sahifaning pastki qismini xiralashtiradi — to'liq matnni o'qib olishning oldini olish uchun."""
    img = img.copy()
    y = int(img.height * keep)
    part = img.crop((0, y, img.width, img.height)).filter(ImageFilter.GaussianBlur(radius=max(6, img.width // 90)))
    img.paste(part, (0, y))
    return img


def to_jpeg(img: Image.Image, quality: int = 80) -> bytes:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def cover(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Rasmni berilgan o'lchamga to'ldirib (crop qilib) moslash."""
    tw, th = size
    scale = max(tw / img.width, th / img.height)
    img = img.resize((math.ceil(img.width * scale), math.ceil(img.height * scale)), Image.LANCZOS)
    left, top = (img.width - tw) // 2, (img.height - th) // 2
    return img.crop((left, top, left + tw, top + th))
