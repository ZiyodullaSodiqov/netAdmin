"""Har bir xizmat uchun: kiritilgan ma'lumotlardan tayyor fayl va himoyalangan ko'rinish (preview) yasash."""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from pathlib import Path

from .generators import convert, design, docs, ocr, photo34, slides, tests_gen
from .preview import WM, image_preview, office_preview, pdf_pages
from .imaging import to_jpeg, watermark
from .config import config
from .services import Service

log = logging.getLogger(__name__)


@dataclass
class Variant:
    files: list[Path]
    previews: list[bytes]


@dataclass
class Produced:
    variants: list[Variant]
    note: str = ""
    units: int = 1  # narx ko'paytiruvchisi (masalan, rasm → word da listlar soni)
    extra_price: int = 0  # qo'shimcha xizmat narxi (masalan, 3x4 rasmda kiyim)
    extra: dict = field(default_factory=dict)

    @property
    def files(self) -> list[Path]:
        return self.variants[0].files

    @property
    def previews(self) -> list[bytes]:
        return self.variants[0].previews


def single(files: list[Path], previews: list[bytes], note: str = "", **kw) -> Produced:
    return Produced([Variant(files, previews)], note, **kw)


def n_styles() -> int:
    return max(1, min(5, config.style_variants))


def _safe(name: str, limit: int = 50) -> str:
    keep = "".join(c if c.isalnum() or c in " -_" else "_" for c in name).strip()
    return (keep[:limit] or "fayl").replace(" ", "_")


async def produce(svc: Service, p: dict, work: Path, mark: str = WM) -> Produced:
    """Natija yaratish. Slayd, hujjat, test va dizaynlarda — bir xil mazmun, n_styles() xil uslubda."""
    work.mkdir(parents=True, exist_ok=True)
    lang = p.get("lang", "uz")
    n = n_styles()

    def sdir(i: int) -> Path:
        d = work / f"s{i + 1}"
        d.mkdir(parents=True, exist_ok=True)
        return d

    if svc.kind == "slides":
        data = await slides.generate_content(p["topic"], int(p["pages"]), lang)
        outs = [slides.build_pptx(data, sdir(i) / f"{_safe(p['topic'])}.pptx", lang, p.get("author", ""), theme=i)
                for i in range(n)]
        prevs = await asyncio.gather(*[office_preview(o, 3, data["title"], mark) for o in outs])
        total = prevs[0][1]
        return Produced([Variant([o], pv) for o, (pv, _) in zip(outs, prevs)], f"{total} ta slayd" if total else "")

    if svc.kind == "doc":
        dt = svc.extra["doc_type"]
        data = await docs.generate_content(dt, p["topic"], int(p["pages"]), lang)
        outs = [docs.build_docx(data, sdir(i) / f"{_safe(p['topic'])}.docx", dt, lang,
                                author=p.get("author", ""), institution=p.get("institution", ""),
                                teacher=p.get("teacher", ""), style=i) for i in range(n)]
        text = data["title"] + "\n\n" + "\n".join(data["sections"][0]["paragraphs"][:3])
        prevs = await asyncio.gather(*[office_preview(o, 3, text, mark) for o in outs])
        total = prevs[0][1]
        return Produced([Variant([o], pv) for o, (pv, _) in zip(outs, prevs)], f"{total} varoq" if total else "")

    if svc.kind == "tests":
        tv = await tests_gen.generate_variants(p["subject"], p["topic"], p["grade"], lang,
                                               int(p["variants"]), int(p["count"]))
        outs = [tests_gen.build_docx(tv, sdir(i) / f"test_{_safe(p['subject'])}_{p['grade']}.docx",
                                     p["subject"], p["topic"], p["grade"], lang, style=i) for i in range(n)]
        text = "\n".join(q["q"] for q in (tv[0][:3] if tv else []))
        prevs = await asyncio.gather(*[office_preview(o, 2, text, mark) for o in outs])
        cnt = sum(len(v) for v in tv)
        return Produced([Variant([o], pv) for o, (pv, _) in zip(outs, prevs)],
                        f"{len(tv)} variant, jami {cnt} ta savol (javoblar kaliti bilan)")

    if svc.kind == "design":
        doc = svc.extra["doc"]
        data = await design.compose(doc, lang, p["info"])
        pngs = await asyncio.gather(*[design.render(doc, lang, data, sdir(i) / f"{svc.key}.png", style=i)
                                      for i in range(n)])
        return Produced([Variant([design.png_to_pdf(png, png.with_suffix(".pdf")), png], [image_preview(png, mark)])
                         for png in pngs])

    if svc.kind == "convert":
        src = Path(p["files"][0])
        if svc.extra["direction"] == "word2pdf":
            out = await convert.to_pdf(src, work)
            imgs, total = pdf_pages(out, 1)
        else:
            out = await convert.pdf_to_docx(src, work / (src.stem + ".docx"))
            prev, total = await office_preview(out, 1, src.stem, mark)
            return single([out], prev, f"{total} sahifa" if total else "")
        return single([out], [to_jpeg(watermark(i, mark)) for i in imgs], f"{total} sahifa")

    if svc.kind == "ocr":
        pages = []
        for f in p["files"]:
            path = Path(f)
            mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
            pages.append(await ocr.recognize(path.read_bytes(), mime, svc.extra["fix"]))
        out = ocr.build_docx(pages, work / "rasm_matn.docx", svc.extra["fix"])
        text = "\n".join(b.get("text", "") for b in pages[0][:8]) if pages else ""
        prev, _ = await office_preview(out, 2, text, mark)
        return single([out], prev, f"{len(pages)} list", units=len(pages))

    if svc.kind == "photo34":
        photo = Path(p["files"][0]).read_bytes()
        clothes = p.get("clothes", "none")
        if clothes != "none":
            photo = await photo34.dress(photo, clothes)
        out = photo34.build_sheet(photo, work / "3x4_10x15.jpg", single_out=work / "3x4_bitta.jpg")
        return single([out, work / "3x4_bitta.jpg"], [image_preview(out, mark)],
                        "10x15 sm list, 9 dona 3x4 rasm, 600 dpi (4K)",
                        extra_price=config.price_photo_clothes if clothes != "none" else 0)

    raise ValueError(f"Unknown service kind: {svc.kind}")
