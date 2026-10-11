"""Word ↔ PDF konvertatsiya. Word→PDF LibreOffice (soffice) orqali, PDF→Word pdf2docx orqali."""
from __future__ import annotations

import asyncio
import shutil
import tempfile
from pathlib import Path


def soffice_bin() -> str | None:
    return shutil.which("soffice") or shutil.which("libreoffice")


async def to_pdf(src: Path, out_dir: Path) -> Path:
    """DOC/DOCX/PPTX → PDF (LibreOffice headless)."""
    exe = soffice_bin()
    if not exe:
        raise RuntimeError("LibreOffice (soffice) o'rnatilmagan")
    with tempfile.TemporaryDirectory() as profile:
        proc = await asyncio.create_subprocess_exec(
            exe, f"-env:UserInstallation=file://{profile}", "--headless", "--convert-to", "pdf",
            "--outdir", str(out_dir), str(src),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        try:
            _, err = await asyncio.wait_for(proc.communicate(), timeout=180)
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError("Konvertatsiya juda uzoq davom etdi")
    out = out_dir / (src.stem + ".pdf")
    if not out.exists():
        raise RuntimeError(f"PDF yaratilmadi: {err.decode(errors='ignore')[:300]}")
    return out


def _pdf_to_docx_sync(src: Path, out: Path) -> Path:
    from pdf2docx import Converter
    cv = Converter(str(src))
    try:
        cv.convert(str(out))
    finally:
        cv.close()
    return out


async def pdf_to_docx(src: Path, out: Path) -> Path:
    return await asyncio.to_thread(_pdf_to_docx_sync, src, out)
