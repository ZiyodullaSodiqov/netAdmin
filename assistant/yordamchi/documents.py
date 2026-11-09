"""Hujjatlardan matn ajratib olish."""
from __future__ import annotations

import io
import logging
import mimetypes

log = logging.getLogger(__name__)

TEXT_EXT = (".txt", ".md", ".csv", ".json", ".log", ".xml", ".html", ".htm", ".yaml", ".yml", ".ini")


def guess_mime(filename: str, mime: str | None) -> str:
    if mime and mime != "application/octet-stream":
        return mime
    return mimetypes.guess_type(filename)[0] or "application/octet-stream"


def extract_text(data: bytes, filename: str, mime: str) -> str | None:
    """Matnli hujjatlar uchun matnni qaytaradi; rasm va boshqalar uchun None (AI o'zi o'qiydi)."""
    name = filename.lower()
    try:
        if mime.startswith("text/") or name.endswith(TEXT_EXT):
            for enc in ("utf-8", "cp1251", "latin-1"):
                try:
                    return data.decode(enc)
                except UnicodeDecodeError:
                    continue
        if mime == "application/pdf" or name.endswith(".pdf"):
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(data))
            text = "\n".join((p.extract_text() or "") for p in reader.pages[:60])
            return text if text.strip() else None  # skaner qilingan PDF — AI ga fayl sifatida yuboriladi
        if name.endswith(".docx"):
            import docx
            d = docx.Document(io.BytesIO(data))
            parts = [p.text for p in d.paragraphs]
            for t in d.tables:
                for row in t.rows:
                    parts.append(" | ".join(c.text for c in row.cells))
            return "\n".join(parts)
        if name.endswith(".xlsx"):
            try:
                import openpyxl
            except ImportError:
                return None
            wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
            rows = []
            for ws in wb.worksheets[:5]:
                rows.append(f"## {ws.title}")
                for r in ws.iter_rows(max_row=300, values_only=True):
                    rows.append(" | ".join("" if v is None else str(v) for v in r))
            return "\n".join(rows)
    except Exception as e:  # noqa: BLE001
        log.warning("Matn ajratib bo'lmadi (%s): %s", filename, e)
    return None
