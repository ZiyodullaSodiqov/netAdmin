"""Natijani to'lovdan oldin ko'rsatish uchun himoyalangan (suv belgili, qisman xira) rasmlar."""
from __future__ import annotations

import io
import logging
from pathlib import Path

from PIL import Image

from .generators.convert import soffice_bin, to_pdf
from .imaging import blur_bottom, draw_text_box, to_jpeg, watermark

log = logging.getLogger(__name__)


def pdf_pages(pdf: Path, max_pages: int, zoom: float = 1.3) -> tuple[list[Image.Image], int]:
    import pymupdf as fitz
    with fitz.open(pdf) as doc:
        total = doc.page_count
        imgs = []
        for i in range(min(max_pages, total)):
            pix = doc[i].get_pixmap(matrix=fitz.Matrix(zoom, zoom))
            imgs.append(Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB"))
    return imgs, total


def _text_page(text: str) -> Image.Image:
    """LibreOffice yo'q bo'lganda — oddiy matnli sahifa rasmi."""
    img = Image.new("RGB", (1240, 1754), "white")
    draw_text_box(img, text, (100, 100, 1140, 1650), "regular", 30, (30, 30, 30), min_size=18,
                  align="left", valign="top")
    return img


WM = "NAMUNA • TO'LOVDAN KEYIN"


async def office_preview(path: Path, max_pages: int = 3, fallback_text: str = "",
                         mark: str = WM) -> tuple[list[bytes], int]:
    """DOCX/PPTX → birinchi sahifalar (suv belgili). Qaytaradi: (jpeg lar, jami sahifa)."""
    if path.suffix.lower() == ".pdf":
        pdf = path
    elif soffice_bin():
        pdf = await to_pdf(path, path.parent / "preview")
    else:
        pdf = None
    if pdf is None:
        return [to_jpeg(watermark(blur_bottom(_text_page(fallback_text[:2500])), mark))], 0
    imgs, total = pdf_pages(pdf, max_pages)
    out = []
    for i, im in enumerate(imgs):
        # Birinchi sahifa to'liq, keyingilari yarmi xira — sifatni ko'rish mumkin, ko'chirib bo'lmaydi
        out.append(to_jpeg(watermark(im if i == 0 else blur_bottom(im), mark)))
    return out, total


def image_preview(path: Path, mark: str = WM) -> bytes:
    return to_jpeg(watermark(Image.open(path), mark))
