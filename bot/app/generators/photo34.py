"""3x4 rasm: 10x15 sm listda 9 dona (3x3), 300 dpi, kesish chiziqlari bilan."""
from __future__ import annotations

import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from ..imaging import cover

DPI = 300
MM = DPI / 25.4
SHEET = (round(100 * MM), round(150 * MM))  # 10x15 sm, tik holatda
PHOTO = (round(30 * MM), round(40 * MM))    # 3x4 sm


def build_sheet(photo: bytes, out: Path, face_top: float = 0.0) -> Path:
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(photo))).convert("RGB")
    # Yuz odatda yuqori qismda — 3:4 ga kesishda yuqoriroqdan olamiz
    target_ratio = PHOTO[0] / PHOTO[1]
    if img.width / img.height > target_ratio:
        cropped = cover(img, PHOTO)
    else:
        new_h = int(img.width / target_ratio)
        top = int((img.height - new_h) * (0.25 if face_top == 0 else face_top))
        cropped = img.crop((0, top, img.width, top + new_h)).resize(PHOTO, Image.LANCZOS)

    sheet = Image.new("RGB", SHEET, "white")
    d = ImageDraw.Draw(sheet)
    cols, rows = 3, 3
    gap_x = (SHEET[0] - cols * PHOTO[0]) // (cols + 1)
    gap_y = (SHEET[1] - rows * PHOTO[1]) // (rows + 1)
    for r in range(rows):
        for c in range(cols):
            x = gap_x + c * (PHOTO[0] + gap_x)
            y = gap_y + r * (PHOTO[1] + gap_y)
            sheet.paste(cropped, (x, y))
            d.rectangle((x - 1, y - 1, x + PHOTO[0], y + PHOTO[1]), outline=(180, 180, 180), width=1)
    sheet.save(out, "JPEG", quality=95, dpi=(DPI, DPI))
    return out
