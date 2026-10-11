"""3x4 rasm: 10x15 sm listda 9 dona (3x3), 600 dpi (≈4K: 2362x3543 px), kesish chiziqlari bilan.

Ixtiyoriy: OpenAI orqali kiyimni (kostyum, kofta, oq ko'ylak) almashtirish, fonni oq qilish — yuz o'zgarmaydi.
"""
from __future__ import annotations

import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

from ..ai.clients import edit_image
from ..imaging import cover

DPI = 600
MM = DPI / 25.4
SHEET = (round(100 * MM), round(150 * MM))  # 10x15 sm, tik holatda → 2362x3543
PHOTO = (round(30 * MM), round(40 * MM))    # 3x4 sm → 709x945

CLOTHES = {
    "none": ("👤 O'zgartirmasdan", ""),
    "suit_m": ("🤵 Erkaklar kostyumi", "a dark navy formal business suit with a white dress shirt and a dark tie"),
    "suit_f": ("👩‍💼 Ayollar kostyumi", "an elegant dark formal women's business suit jacket with a white blouse"),
    "sweater": ("🧥 Kofta", "a neat, plain dark-colored knitted sweater (kofta)"),
    "shirt": ("👔 Oq ko'ylak", "a crisp white formal dress shirt with collar"),
}

EDIT_PROMPT = (
    "Official 3x4 document/passport photo. Dress the person in {clothes}. Keep the face, facial features, skin tone, "
    "hairstyle, head size, head position and expression EXACTLY identical to the original — do not beautify or "
    "change identity. Plain pure white background, even studio lighting, sharp focus, photorealistic, "
    "head and shoulders centered, no text."
)


async def dress(photo: bytes, clothes: str) -> bytes:
    """Kiyimni almashtirish (OpenAI image edit). `clothes` — CLOTHES kaliti."""
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(photo))).convert("RGB")
    img.thumbnail((1536, 1536))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return await edit_image(buf.getvalue(), EDIT_PROMPT.format(clothes=CLOTHES[clothes][1]), size="1024x1536")


def enhance(img: Image.Image) -> Image.Image:
    """Sifatni oshirish: kerakli o'lchamgacha LANCZOS bilan kattalashtirish, keskinlik, yengil kontrast."""
    img = cover(img, PHOTO)  # kichik rasm bo'lsa LANCZOS bilan 600 dpi gacha kattalashadi
    img = img.filter(ImageFilter.UnsharpMask(radius=2, percent=80, threshold=2))
    img = ImageOps.autocontrast(img, cutoff=0.5)
    img = ImageEnhance.Color(img).enhance(1.05)
    return img


def crop_34(img: Image.Image) -> Image.Image:
    """3:4 nisbatga kesish. Yuz odatda yuqoriroqda — balanddan yuqori qismini olamiz."""
    ratio = PHOTO[0] / PHOTO[1]
    if img.width / img.height > ratio:
        new_w = int(img.height * ratio)
        left = (img.width - new_w) // 2
        return img.crop((left, 0, left + new_w, img.height))
    new_h = int(img.width / ratio)
    top = int((img.height - new_h) * 0.25)
    return img.crop((0, top, img.width, top + new_h))


def build_sheet(photo: bytes, out: Path, single_out: Path | None = None) -> Path:
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(photo))).convert("RGB")
    one = enhance(crop_34(img))
    if single_out:
        one.save(single_out, "JPEG", quality=97, dpi=(DPI, DPI))

    sheet = Image.new("RGB", SHEET, "white")
    d = ImageDraw.Draw(sheet)
    cols, rows = 3, 3
    gap_x = (SHEET[0] - cols * PHOTO[0]) // (cols + 1)
    gap_y = (SHEET[1] - rows * PHOTO[1]) // (rows + 1)
    for r in range(rows):
        for c in range(cols):
            x = gap_x + c * (PHOTO[0] + gap_x)
            y = gap_y + r * (PHOTO[1] + gap_y)
            sheet.paste(one, (x, y))
            d.rectangle((x - 2, y - 2, x + PHOTO[0] + 1, y + PHOTO[1] + 1), outline=(185, 185, 185), width=2)
    sheet.save(out, "JPEG", quality=97, dpi=(DPI, DPI), subsampling=0)
    return out
