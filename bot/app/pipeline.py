"""Har bir xizmat uchun: kiritilgan ma'lumotlardan tayyor fayl va himoyalangan ko'rinish (preview) yasash."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path

from .generators import convert, design, docs, ocr, photo34, slides, tests_gen
from .preview import image_preview, office_preview, pdf_pages
from .imaging import to_jpeg, watermark
from .config import config
from .services import Service

log = logging.getLogger(__name__)


@dataclass
class Produced:
    files: list[Path]
    previews: list[bytes]
    note: str = ""
    units: int = 1  # narx ko'paytiruvchisi (masalan, rasm → word da listlar soni)
    extra_price: int = 0  # qo'shimcha xizmat narxi (masalan, 3x4 rasmda kiyim)
    extra: dict = field(default_factory=dict)


def _safe(name: str, limit: int = 50) -> str:
    keep = "".join(c if c.isalnum() or c in " -_" else "_" for c in name).strip()
    return (keep[:limit] or "fayl").replace(" ", "_")


async def produce(svc: Service, p: dict, work: Path) -> Produced:
    work.mkdir(parents=True, exist_ok=True)
    attempt = int(p.get("attempt", 0))
    lang = p.get("lang", "uz")

    if svc.kind == "slides":
        data = await slides.generate_content(p["topic"], int(p["pages"]), lang)
        out = slides.build_pptx(data, work / f"{_safe(p['topic'])}.pptx", lang, p.get("author", ""), theme=attempt)
        prev, total = await office_preview(out, 3, data["title"])
        return Produced([out], prev, f"{total} ta slayd" if total else "")

    if svc.kind == "doc":
        dt = svc.extra["doc_type"]
        data = await docs.generate_content(dt, p["topic"], int(p["pages"]), lang)
        out = docs.build_docx(data, work / f"{_safe(p['topic'])}.docx", dt, lang,
                              author=p.get("author", ""), institution=p.get("institution", ""),
                              teacher=p.get("teacher", ""))
        text = data["title"] + "\n\n" + "\n".join(data["sections"][0]["paragraphs"][:3])
        prev, total = await office_preview(out, 3, text)
        return Produced([out], prev, f"{total} varoq" if total else "")

    if svc.kind == "tests":
        variants = await tests_gen.generate_variants(p["subject"], p["topic"], p["grade"], lang,
                                                     int(p["variants"]), int(p["count"]))
        out = tests_gen.build_docx(variants, work / f"test_{_safe(p['subject'])}_{p['grade']}.docx",
                                   p["subject"], p["topic"], p["grade"], lang)
        first = variants[0][:3] if variants else []
        text = "\n".join(q["q"] for q in first)
        prev, _ = await office_preview(out, 2, text)
        n = sum(len(v) for v in variants)
        return Produced([out], prev, f"{len(variants)} variant, jami {n} ta savol (javoblar kaliti bilan)")

    if svc.kind == "convert":
        src = Path(p["files"][0])
        if svc.extra["direction"] == "word2pdf":
            out = await convert.to_pdf(src, work)
            imgs, total = pdf_pages(out, 1)
        else:
            out = await convert.pdf_to_docx(src, work / (src.stem + ".docx"))
            prev, total = await office_preview(out, 1, src.stem)
            return Produced([out], prev, f"{total} sahifa" if total else "")
        return Produced([out], [to_jpeg(watermark(i)) for i in imgs], f"{total} sahifa")

    if svc.kind == "ocr":
        pages = []
        for f in p["files"]:
            path = Path(f)
            mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
            pages.append(await ocr.recognize(path.read_bytes(), mime, svc.extra["fix"]))
        out = ocr.build_docx(pages, work / "rasm_matn.docx", svc.extra["fix"])
        text = "\n".join(b.get("text", "") for b in pages[0][:8]) if pages else ""
        prev, _ = await office_preview(out, 2, text)
        return Produced([out], prev, f"{len(pages)} list", units=len(pages))

    if svc.kind == "design":
        doc = svc.extra["doc"]
        data = await design.compose(doc, lang, p["info"])
        png = await design.render(doc, lang, data, work / f"{svc.key}.png")
        pdf = design.png_to_pdf(png, work / f"{svc.key}.pdf")
        return Produced([pdf, png], [image_preview(png)])

    if svc.kind == "photo34":
        photo = Path(p["files"][0]).read_bytes()
        clothes = p.get("clothes", "none")
        if clothes != "none":
            photo = await photo34.dress(photo, clothes)
        out = photo34.build_sheet(photo, work / "3x4_10x15.jpg", single_out=work / "3x4_bitta.jpg")
        return Produced([out, work / "3x4_bitta.jpg"], [image_preview(out)],
                        "10x15 sm list, 9 dona 3x4 rasm, 600 dpi (4K)",
                        extra_price=config.price_photo_clothes if clothes != "none" else 0)

    raise ValueError(f"Unknown service kind: {svc.kind}")
