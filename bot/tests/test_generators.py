import os

import pytest
from PIL import Image

os.environ.setdefault("DB_PATH", "/tmp/netadmin-bot-test/bot.db")
os.environ.setdefault("WORK_DIR", "/tmp/netadmin-bot-test/files")

from app.generators import design, docs, ocr, photo34, slides, tests_gen  # noqa: E402
from app.generators.convert import soffice_bin  # noqa: E402
from app.preview import office_preview  # noqa: E402
from app.services import SERVICES  # noqa: E402

needs_soffice = pytest.mark.skipif(not soffice_bin(), reason="LibreOffice yo'q")


def test_prices():
    assert SERVICES["slides"].price_for(10) == 10000
    assert SERVICES["slides"].price_for(15) == 15000
    assert SERVICES["slides"].print_price_for(10) == 5000
    assert SERVICES["maqola"].price_for(7) == 10000
    assert SERVICES["maqola"].print_price_for(7) == 3000
    assert SERVICES["daftar"].print_price == 500


def test_photo34_sheet(tmp_path):
    src = tmp_path / "p.jpg"
    Image.new("RGB", (800, 1200), (120, 160, 200)).save(src)
    out = photo34.build_sheet(src.read_bytes(), tmp_path / "s.jpg")
    im = Image.open(out)
    assert im.size == photo34.SHEET == (1181, 1772)


SLIDES = {"title": "Quyosh tizimi", "subtitle": "Sayyoralar",
          "slides": [{"title": f"Sayyora {i}", "bullets": ["Birinchi fakt", "Ikkinchi fakt", "Uchinchi"]}
                     for i in range(8)]}

DOC = {"title": "Suv resurslari", "keywords": ["suv", "ekologiya"], "references": ["A. Muallif. Kitob. 2020."],
       "sections": [{"heading": h, "paragraphs": ["Matn " * 80] * 3} for h in ("Kirish", "Asosiy", "Xulosa")]}


@needs_soffice
async def test_slides_and_preview(tmp_path):
    out = slides.build_pptx(SLIDES, tmp_path / "s.pptx", "uz", "Ali Valiyev")
    prev, total = await office_preview(out, 3)
    assert total == 10 and len(prev) == 3


@needs_soffice
@pytest.mark.parametrize("doc_type", ["referat", "ilmiy maqola"])
async def test_docs(tmp_path, doc_type):
    out = docs.build_docx({**DOC, "abstract": "Annotatsiya", "abstract_en": "Abstract"},
                          tmp_path / "d.docx", doc_type, "ru", author="Иванов И.", institution="ТГУ", teacher="Петров")
    prev, total = await office_preview(out, 3)
    assert total >= 2 and prev


def test_tests_docx(tmp_path):
    v = [[{"q": f"Savol {i}", "options": ["a", "b", "c", "d"], "answer": i % 4} for i in range(12)]] * 2
    out = tests_gen.build_docx(v, tmp_path / "t.docx", "Matematika", "Kasrlar", "5", "uz")
    assert out.stat().st_size > 0


def test_ocr_docx(tmp_path):
    blocks = [{"type": "heading", "text": "Ariza"}, {"type": "paragraph", "text": "Matn"},
              {"type": "list", "items": ["bir", "ikki"]}, {"type": "table", "rows": [["a", "b"], ["c"]]}]
    assert ocr.build_docx([blocks, blocks], tmp_path / "o.docx", fix=True).exists()


@pytest.mark.parametrize("doc", ["certificate", "notebook"])
async def test_design_fallback(tmp_path, doc):
    data = {"recipient": "Иванов Иван Иванович", "body": "За активное участие " * 5, "org": "Школа №1",
            "date": "11.10.2026", "signer": "Петров П.", "signer_title": "Директор", "subject": "Математика",
            "student_class": "5-А", "school": "Школа №1", "primary": "#1a3d7c", "accent": "#c49a3c"}
    png = await design.render(doc, "ru", data, tmp_path / "d.png", use_ai_background=False)
    pdf = design.png_to_pdf(png, tmp_path / "d.pdf")
    assert pdf.exists() and Image.open(png).size == ((1748, 2480) if doc == "notebook" else (3508, 2480))


@needs_soffice
async def test_pipeline_with_mocked_ai(tmp_path, monkeypatch):
    """To'liq produce() oqimi: AI javoblari soxta, qolgani haqiqiy."""
    from app import pipeline
    from app.generators import docs as docs_mod, slides as slides_mod, tests_gen as tg_mod

    async def fake_openai(system, user, temperature=0.7):
        if "slides massivida" in user:
            return {"title": "Mavzu", "slides": [{"title": f"S{i}", "bullets": ["a", "b"]} for i in range(20)]}
        if "asosiy bo'lim nomini" in user:
            return {"title": "Mavzu", "sections": ["Bir", "Ikki", "Uch"], "keywords": ["k"], "references": ["r"]}
        if "questions" in user:
            return {"questions": [{"q": "2+2?", "options": ["1", "2", "3", "4"], "answer": 3}] * 10}
        return {"paragraphs": ["Matn " * 60] * 4}

    for m in (slides_mod, docs_mod, tg_mod):
        monkeypatch.setattr(m, "openai_json", fake_openai)

    res = await pipeline.produce(SERVICES["slides"], {"topic": "Mavzu", "pages": "10", "lang": "uz"}, tmp_path / "a")
    assert res.note == "10 ta slayd" and res.files[0].suffix == ".pptx"
    res = await pipeline.produce(SERVICES["referat"], {"topic": "Mavzu", "pages": "10", "lang": "ru"}, tmp_path / "b")
    assert res.files[0].suffix == ".docx" and res.previews
    res = await pipeline.produce(SERVICES["tests"], {"subject": "Mat", "topic": "Qo'shish", "grade": "2",
                                                     "variants": "2", "count": "10", "lang": "uz"}, tmp_path / "c")
    assert "2 variant" in res.note
    res = await pipeline.produce(SERVICES["word2pdf"], {"files": [str(next((tmp_path / "b").glob("*.docx")))]},
                                 tmp_path / "d")
    assert res.files[0].suffix == ".pdf"
    res = await pipeline.produce(SERVICES["pdf2word"], {"files": [str(res.files[0])]}, tmp_path / "e")
    assert res.files[0].suffix == ".docx"
