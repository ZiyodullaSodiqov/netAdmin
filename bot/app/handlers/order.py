"""Buyurtma oqimi: xizmat tanlash → savollar → yaratish → himoyalangan ko'rinish → sotib olish → to'lov."""
from __future__ import annotations

import html
import logging
import shutil
import time
import uuid
from pathlib import Path

from aiogram import Bot, F, Router
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import BufferedInputFile, CallbackQuery, InputMediaPhoto, Message
from aiogram.utils.chat_action import ChatActionSender

from ..config import config
from ..db import db
from ..generators.design import HINTS
from ..generators.photo34 import CLOTHES
from ..pipeline import n_styles, produce
from ..services import SERVICES, Service, fmt_sum
from .. import ui

log = logging.getLogger(__name__)
router = Router()

MAX_REGEN = 2
MAX_FILE = 20 * 1024 * 1024  # Bot API yuklab olish chegarasi


class Flow(StatesGroup):
    step = State()
    preview = State()  # natija ko'rsatildi, tugmalar kutilmoqda
    contact = State()
    receipt = State()
    math = State()


GRADES = [(str(i), str(i)) for i in range(1, 12)]


def steps_for(svc: Service) -> list[dict]:
    lang = [{"key": "lang", "type": "lang", "q": "Qaysi tilda tayyorlansin?"}] if svc.langs else []
    pages = [{"key": "pages", "type": "choice", "q": "Hajmi (varoqlar soni)?",
              "options": [(f"{n} varoq — {fmt_sum(svc.price_for(n))}", str(n)) for n in svc.page_options],
              "per_row": 1}] if svc.page_options else []
    k = svc.kind
    if k == "slides":
        return lang + pages + [
            {"key": "topic", "type": "text", "q": "📌 Taqdimot mavzusini yozing:"},
            {"key": "author", "type": "text", "q": "Titul slayd uchun F.I.Sh (va guruh) yozing:", "skip": True},
        ]
    if k == "doc":
        s = lang + pages + [{"key": "topic", "type": "text", "q": "📌 Mavzuni yozing:"},
                            {"key": "author", "type": "text", "q": "Muallif F.I.Sh (va guruh):", "skip": True},
                            {"key": "institution", "type": "text", "q": "OTM / maktab / tashkilot nomi:",
                             "skip": True}]
        if svc.key != "maqola":
            s.append({"key": "teacher", "type": "text", "q": "Tekshiruvchi o'qituvchi F.I.Sh:", "skip": True})
        return s
    if k == "tests":
        return lang + [
            {"key": "subject", "type": "text", "q": "📚 Fan nomini yozing (masalan: Matematika):"},
            {"key": "topic", "type": "text", "q": "📌 Mavzu(lar)ni yozing:"},
            {"key": "grade", "type": "choice", "q": "Nechanchi sinf?", "options": GRADES, "per_row": 6},
            {"key": "variants", "type": "choice", "q": "Nechta variant?",
             "options": [(str(i), str(i)) for i in (1, 2, 3, 4, 5)], "per_row": 5},
            {"key": "count", "type": "choice", "q": "Har variantda nechta savol?",
             "options": [(str(i), str(i)) for i in (10, 15, 20, 25, 30)], "per_row": 5},
        ]
    if k == "convert":
        word = svc.extra["direction"] == "word2pdf"
        return [{"key": "files", "type": "file", "accept": "word" if word else "pdf",
                 "q": "📎 Word faylini (.doc/.docx) yuboring:" if word else "📎 PDF faylni yuboring:"}]
    if k == "ocr":
        return [{"key": "files", "type": "file", "accept": "image", "multi": True,
                 "q": f"🖼 Hujjat rasm(lar)ini yuboring (har bir list — {fmt_sum(svc.price)}). "
                      "Hammasini yuborgach «✅ Tayyor» ni bosing."}]
    if k == "design":
        return lang + [{"key": "info", "type": "text",
                        "q": "✍️ Bitta xabarda yozing:\n" + HINTS[svc.extra["doc"]]}]
    if k == "photo34":
        extra = f" (+{fmt_sum(config.price_photo_clothes)})" if config.price_photo_clothes else ""
        return [{"key": "files", "type": "file", "accept": "image",
                 "q": "📸 Yuzingiz aniq ko'ringan rasmni yuboring (to'g'ri qarab, yelkagacha, sifatli):"},
                {"key": "clothes", "type": "choice", "per_row": 1,
                 "q": "👔 Rasmda kostyum yoki kofta kiydirilsinmi?" + extra +
                      "\n(Yuz o'zgarmaydi, fon oq qilinadi)",
                 "options": [(title, key) for key, (title, _) in CLOTHES.items()]}]
    return []


async def ask(target: Message, step: dict, svc: Service) -> None:
    t = step["type"]
    if t == "lang":
        await target.answer(step["q"], reply_markup=ui.langs_kb(svc.langs))
    elif t == "choice":
        await target.answer(step["q"], reply_markup=ui.choices_kb(step["options"], step.get("per_row", 3)))
    elif step.get("skip"):
        await target.answer(step["q"], reply_markup=ui.skip_kb())
    elif step.get("multi"):
        await target.answer(step["q"], reply_markup=ui.done_kb())
    else:
        await target.answer(step["q"], reply_markup=ui.ikb([[("⬅️ Menyu", "menu")]]))


# ---------- start / menyu ----------

@router.message(CommandStart())
async def start(msg: Message, state: FSMContext):
    await state.clear()
    await db.upsert_user(msg.from_user.id, msg.from_user.username, msg.from_user.full_name)
    await db.log_event(msg.from_user.id, "start")
    await msg.answer(
        f"Assalomu alaykum, {html.escape(msg.from_user.first_name or '')}! 👋\n"
        "Slayd, referat, mustaqil ish, maqola, test, sertifikat, diplom, 3x4 rasm va boshqalarni tayyorlab beraman.\n"
        "Natijani avval ko'rasiz, yoqsa — to'lov qilib faylni olasiz.\n\nXizmatni tanlang:",
        reply_markup=ui.main_menu())
    if msg.from_user.id in config.admin_ids:
        await msg.answer("🛠 Siz adminsiz:", reply_markup=ui.ikb([[("🛠 Admin panel", "ap:home")]]))


@router.message(Command("menu"))
@router.callback_query(F.data == "menu")
async def menu(ev: Message | CallbackQuery, state: FSMContext):
    await state.clear()
    msg = ev.message if isinstance(ev, CallbackQuery) else ev
    if isinstance(ev, CallbackQuery):
        await ev.answer()
    await msg.answer("Xizmatni tanlang:", reply_markup=ui.main_menu())


@router.callback_query(F.data == "prices")
async def prices(cb: CallbackQuery):
    await cb.answer()
    await cb.message.answer(ui.prices_text(), reply_markup=ui.ikb([[("⬅️ Menyu", "menu")]]))


@router.callback_query(F.data == "my_orders")
async def my_orders(cb: CallbackQuery):
    await cb.answer()
    orders = await db.awaiting_orders(cb.from_user.id)
    if not orders:
        await cb.message.answer("To'lov kutilayotgan buyurtma yo'q.", reply_markup=ui.main_menu())
        return
    lines = ["To'lov kutilayotgan buyurtmalar:"]
    for o in orders:
        lines.append(f"#{o['id']} — {SERVICES[o['service']].title} — {fmt_sum(o['price'] + o['print_price'])}")
    lines.append("\nChekni shu yerga yuboring.")
    await cb.message.answer("\n".join(lines))


@router.callback_query(F.data.startswith("svc:"))
async def choose_service(cb: CallbackQuery, state: FSMContext):
    svc = SERVICES[cb.data.split(":", 1)[1]]
    await cb.answer()
    await state.clear()
    await db.upsert_user(cb.from_user.id, cb.from_user.username, cb.from_user.full_name)
    await db.log_event(cb.from_user.id, "open", svc.key)
    if svc.kind == "math":
        from .math import enter_math
        await enter_math(cb.message, cb.from_user.id, state)
        return
    work = config.work_dir / f"{cb.from_user.id}_{int(time.time())}_{uuid.uuid4().hex[:6]}"
    await state.set_state(Flow.step)
    await state.update_data(svc=svc.key, i=0, p={}, work=str(work))
    await cb.message.answer(f"<b>{svc.title}</b>")
    await ask(cb.message, steps_for(svc)[0], svc)


# ---------- qadamlar ----------

async def _advance(msg: Message, state: FSMContext, bot: Bot, user_id: int) -> None:
    data = await state.get_data()
    svc = SERVICES[data["svc"]]
    steps = steps_for(svc)
    i = data["i"] + 1
    if i < len(steps):
        await state.update_data(i=i)
        await ask(msg, steps[i], svc)
        return
    await generate(msg, state, bot, user_id)


@router.callback_query(Flow.step, F.data.startswith("ans:"))
async def on_answer(cb: CallbackQuery, state: FSMContext, bot: Bot):
    data = await state.get_data()
    svc = SERVICES[data["svc"]]
    step = steps_for(svc)[data["i"]]
    val = cb.data.split(":", 1)[1]
    await cb.answer()
    p = data["p"]
    if step["type"] == "file":
        if val != "done":
            return
        if not p.get("files"):
            await cb.message.answer("Avval kamida bitta rasm yuboring.")
            return
    elif val == "-":
        if not step.get("skip"):
            return
        p[step["key"]] = ""
    elif step["type"] in ("lang", "choice"):
        p[step["key"]] = val
    else:
        return
    await state.update_data(p=p)
    await cb.message.edit_reply_markup(reply_markup=None)
    await _advance(cb.message, state, bot, cb.from_user.id)


@router.message(Flow.step, F.text)
async def on_text(msg: Message, state: FSMContext, bot: Bot):
    data = await state.get_data()
    svc = SERVICES[data["svc"]]
    step = steps_for(svc)[data["i"]]
    if step["type"] != "text":
        await msg.answer("Iltimos, yuqoridagi tugmalardan foydalaning yoki so'ralgan faylni yuboring.")
        return
    text = msg.text.strip()
    if len(text) < 2 or len(text) > 1500:
        await msg.answer("Matn juda qisqa yoki juda uzun. Qaytadan yozing.")
        return
    p = data["p"]
    p[step["key"]] = text
    await state.update_data(p=p)
    await _advance(msg, state, bot, msg.from_user.id)


WORD_EXT = {".doc", ".docx", ".odt", ".rtf"}
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp"}


@router.message(Flow.step, F.photo | F.document)
async def on_file(msg: Message, state: FSMContext, bot: Bot):
    data = await state.get_data()
    svc = SERVICES[data["svc"]]
    step = steps_for(svc)[data["i"]]
    if step["type"] != "file":
        await msg.answer("Hozir fayl kutilmayapti — savolga javob bering.")
        return
    accept = step["accept"]
    if msg.photo:
        if accept != "image":
            await msg.answer("Iltimos, faylni hujjat (document) sifatida yuboring.")
            return
        obj, ext = msg.photo[-1], ".jpg"
    else:
        obj = msg.document
        ext = Path(obj.file_name or "").suffix.lower()
        ok = (accept == "word" and ext in WORD_EXT) or (accept == "pdf" and ext == ".pdf") or \
             (accept == "image" and ext in IMG_EXT)
        if not ok:
            await msg.answer("Bu turdagi fayl qabul qilinmaydi. " + step["q"])
            return
    if (obj.file_size or 0) > MAX_FILE:
        await msg.answer("Fayl 20 MB dan katta. Kichikroq fayl yuboring.")
        return
    work = Path(data["work"]) / "in"
    work.mkdir(parents=True, exist_ok=True)
    p = data["p"]
    files = p.setdefault("files", [])
    name = (msg.document.file_name if msg.document else None) or f"img{len(files) + 1}{ext}"
    dest = work / f"{len(files) + 1}_{Path(name).stem[:40]}{ext}"
    await bot.download(obj, destination=dest)
    files.append(str(dest))
    await state.update_data(p=p)
    if step.get("multi"):
        await msg.answer(f"✅ Qabul qilindi: {len(files)} ta. Yana yuboring yoki «✅ Tayyor» ni bosing.",
                         reply_markup=ui.done_kb())
        return
    await _advance(msg, state, bot, msg.from_user.id)


# ---------- yaratish va ko'rsatish ----------

async def generate(msg: Message, state: FSMContext, bot: Bot, user_id: int, order_id: int | None = None) -> None:
    data = await state.get_data()
    svc = SERVICES[data["svc"]]
    p = data["p"]
    work = Path(data["work"]) / f"v{p.get('attempt', 0)}"
    multi = svc.kind in ("slides", "doc", "tests", "design") and n_styles() > 1
    wait = await msg.answer("⏳ Tayyorlanmoqda... " + ("5 xil uslubda tayyorlanadi, " if multi else "")
                            + "bu 1-3 daqiqa vaqt olishi mumkin.")
    try:
        async with ChatActionSender.upload_document(bot=bot, chat_id=msg.chat.id):
            # Suv belgisida foydalanuvchi ID si — namuna tarqalsa, kimdan chiqqani ko'rinadi
            res = await produce(svc, p, work, mark=f"NAMUNA • ID {user_id}")
    except Exception:  # noqa: BLE001
        log.exception("produce failed: %s %s", svc.key, p)
        await db.log_event(user_id, "error", svc.key)
        await wait.edit_text("😔 Xatolik yuz berdi. Birozdan so'ng qayta urinib ko'ring yoki boshqa ma'lumot kiriting.",
                             reply_markup=ui.main_menu())
        await state.clear()
        return

    await db.log_event(user_id, "generate", svc.key)
    pages = int(p["pages"]) if p.get("pages") else None
    price = svc.price_for(pages) * res.units + res.extra_price
    print_price = svc.print_price_for(pages) * res.units

    # Namuna rasmlari diskka — web ko'rish sahifasi shulardan foydalanadi
    prev_dir = work / "previews"
    prev_dir.mkdir(parents=True, exist_ok=True)
    preview_files = []
    for vi, v in enumerate(res.variants):
        paths = []
        for ni, b in enumerate(v.previews):
            f = prev_dir / f"{vi + 1}_{ni + 1}.jpg"
            f.write_bytes(b)
            paths.append(str(f))
        preview_files.append(paths)
    variants = [[str(f) for f in v.files] for v in res.variants]
    params = {**p, "variants": variants, "preview_files": preview_files, "work": data["work"],
              "files_out": variants[0] if len(variants) == 1 else []}
    if order_id:
        await db.update_order(order_id, params=params, price=price, print_price=print_price)
    else:
        order_id = await db.create_order(user_id, svc.key, params, price, print_price)
    await state.set_state(Flow.preview)
    await state.update_data(order_id=order_id)

    url = ""
    if config.web_public_url and len(variants) > 1:
        token = await db.create_preview_link(order_id, config.preview_ttl_hours)
        url = f"{config.web_public_url.rstrip('/')}/p/{token}"

    await wait.delete()
    # protect_content: Telegram saqlash, forward qilish va (mobil ilovalarda) skrinshotni bloklaydi
    if len(res.variants) > 1:
        album = [InputMediaPhoto(media=BufferedInputFile(v.previews[0], f"s{i + 1}.jpg"), caption=f"{i + 1}-uslub")
                 for i, v in enumerate(res.variants) if v.previews]
        await msg.answer_media_group(album, protect_content=True)
    elif len(res.previews) == 1:
        await msg.answer_photo(BufferedInputFile(res.previews[0], "preview.jpg"), protect_content=True)
    elif res.previews:
        await msg.answer_media_group(
            [InputMediaPhoto(media=BufferedInputFile(b, f"p{i}.jpg")) for i, b in enumerate(res.previews)],
            protect_content=True)
    note = f" ({res.note})" if res.note else ""
    if len(res.variants) > 1:
        text = (f"👀 <b>Natija {len(res.variants)} xil uslubda tayyor{note}.</b>\n"
                + ("Barcha sahifalarni «👀 Barcha sahifalarni ko'rish» tugmasi orqali ko'ring. " if url else "")
                + f"Yoqqan uslubni tanlang — narxi: <b>{fmt_sum(price)}</b>.\n"
                  "Namunalar suv belgili va himoyalangan; asl fayl to'lovdan so'ng yuboriladi.")
    else:
        text = (f"👀 <b>Natija tayyor{note}.</b> Yuqorida — namunasi (suv belgisi bilan, saqlab bo'lmaydi).\n"
                f"Narxi: <b>{fmt_sum(price)}</b>. Yoqsa — to'lovdan so'ng asl fayl yuboriladi.")
    await msg.answer(text, protect_content=True,
                     reply_markup=ui.preview_kb(order_id, int(p.get("attempt", 0)) < MAX_REGEN, len(res.variants), url))


async def _own_order(cb: CallbackQuery, status: str = "draft") -> dict | None:
    oid = int(cb.data.split(":")[1])
    o = await db.get_order(oid)
    if not o or o["user_id"] != cb.from_user.id or o["status"] != status:
        await cb.answer("Buyurtma topilmadi yoki eskirgan.", show_alert=True)
        return None
    return o


@router.callback_query(F.data.startswith("regen:"))
async def regen(cb: CallbackQuery, state: FSMContext, bot: Bot):
    o = await _own_order(cb)
    if not o:
        return
    p = o["params"]
    if int(p.get("attempt", 0)) >= MAX_REGEN:
        await cb.answer("Qayta yaratish limiti tugadi.", show_alert=True)
        return
    await cb.answer()
    await cb.message.edit_reply_markup(reply_markup=None)
    p["attempt"] = int(p.get("attempt", 0)) + 1
    await state.set_state(Flow.step)
    await state.update_data(svc=o["service"], p=p, work=p["work"])
    await generate(cb.message, state, bot, cb.from_user.id, order_id=o["id"])


@router.callback_query(F.data.startswith("cancel:"))
async def cancel(cb: CallbackQuery, state: FSMContext):
    oid = int(cb.data.split(":")[1])
    o = await db.get_order(oid)
    if o and o["user_id"] == cb.from_user.id and o["status"] in ("draft", "awaiting_payment"):
        await db.update_order(oid, status="cancelled")
        shutil.rmtree(o["params"].get("work", ""), ignore_errors=True)
    await state.clear()
    await cb.answer("Bekor qilindi")
    await cb.message.edit_reply_markup(reply_markup=None)
    await cb.message.answer("Buyurtma bekor qilindi.", reply_markup=ui.main_menu())


@router.callback_query(F.data.startswith("buy:"))
async def buy(cb: CallbackQuery, state: FSMContext):
    o = await _own_order(cb)
    if not o:
        return
    parts = cb.data.split(":")
    variants = o["params"].get("variants") or []
    if len(parts) > 2:  # uslub tanlandi
        idx = int(parts[2])
        if not 0 <= idx < len(variants):
            await cb.answer("Bunday uslub yo'q", show_alert=True)
            return
        o["params"]["files_out"] = variants[idx]
        o["params"]["style"] = idx + 1
        await db.update_order(o["id"], params=o["params"])
        o = await db.get_order(o["id"])
    elif not o["params"].get("files_out"):
        await cb.answer("Avval uslubni tanlang", show_alert=True)
        return
    await cb.answer()
    await cb.message.edit_reply_markup(reply_markup=None)
    if o["params"].get("style"):
        await cb.message.answer(f"Tanlandi: <b>{o['params']['style']}-uslub</b>")
    await db.log_event(cb.from_user.id, "buy", o["service"])
    if o["print_price"]:
        await cb.message.answer("🖨 Qog'ozda chiqarib berilsinmi?", reply_markup=ui.print_kb(o["id"], o["print_price"]))
        return
    await to_payment(cb.message, state, o)


@router.callback_query(F.data.startswith("print:"))
async def print_choice(cb: CallbackQuery, state: FSMContext):
    o = await _own_order(cb)
    if not o:
        return
    await cb.answer()
    await cb.message.edit_reply_markup(reply_markup=None)
    with_print = cb.data.endswith(":1")
    await db.update_order(o["id"], with_print=int(with_print))
    if with_print:
        await state.set_state(Flow.contact)
        await state.update_data(order_id=o["id"])
        await cb.message.answer("📱 Telefon raqamingizni yuboring (tayyor bo'lganda bog'lanamiz):",
                                reply_markup=ui.contact_kb())
        return
    await to_payment(cb.message, state, await db.get_order(o["id"]))


@router.message(Flow.contact, F.contact | F.text)
async def got_contact(msg: Message, state: FSMContext):
    phone = msg.contact.phone_number if msg.contact else (msg.text or "").strip()
    if sum(c.isdigit() for c in phone) < 9:
        await msg.answer("Telefon raqamni to'g'ri yuboring (masalan +998901234567).")
        return
    oid = (await state.get_data())["order_id"]
    o = await db.get_order(oid)
    o["params"]["phone"] = phone
    await db.update_order(oid, params=o["params"])
    await msg.answer("✅ Qabul qilindi.", reply_markup=ui.remove_kb)
    await to_payment(msg, state, await db.get_order(oid))


async def to_payment(msg: Message, state: FSMContext, o: dict) -> None:
    pp = o["print_price"] if o["with_print"] else 0
    await db.update_order(o["id"], status="awaiting_payment")
    await state.set_state(Flow.receipt)
    await state.update_data(order_id=o["id"])
    await msg.answer(ui.payment_text(o["id"], SERVICES[o["service"]].title, o["price"], pp),
                     reply_markup=ui.ikb([[("❌ Bekor qilish", f"cancel:{o['id']}")]]))
