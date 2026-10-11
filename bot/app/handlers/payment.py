"""Chekni qabul qilish, avtomatik tekshirish, kerak bo'lsa adminga yuborish."""
from __future__ import annotations

import html
import io
import logging

from aiogram import Bot, F, Router
from aiogram.filters import StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message

from ..config import config
from ..db import db
from ..delivery import deliver, notify_admins, order_total
from ..payments.verifier import read_receipt, verify
from ..services import SERVICES, fmt_sum
from .. import ui
from .order import Flow

log = logging.getLogger(__name__)
router = Router()


async def _receipt_input(msg: Message, bot: Bot) -> tuple[bytes | None, str, str | None]:
    if msg.photo:
        buf = io.BytesIO()
        await bot.download(msg.photo[-1], destination=buf)
        return buf.getvalue(), "image/jpeg", None
    if msg.document:
        mime = msg.document.mime_type or ""
        if not (mime.startswith("image/") or mime == "application/pdf"):
            return None, "", None
        buf = io.BytesIO()
        await bot.download(msg.document, destination=buf)
        data = buf.getvalue()
        if mime == "application/pdf":
            import pymupdf as fitz
            with fitz.open(stream=data, filetype="pdf") as doc:
                data = doc[0].get_pixmap(matrix=fitz.Matrix(2, 2)).tobytes("png")
            mime = "image/png"
        return data, mime, None
    return None, "", msg.text


async def _process(msg: Message, state: FSMContext, bot: Bot, order: dict) -> None:
    image, mime, text = await _receipt_input(msg, bot)
    if image is None and not text:
        await msg.answer("Chekni rasm, PDF yoki matn ko'rinishida yuboring.")
        return
    wait = await msg.answer("🔎 Chek tekshirilmoqda...")
    await db.log_event(msg.from_user.id, "receipt", order["service"])
    total = order_total(order)
    try:
        receipt = await read_receipt(image, mime, text)
        res = await verify(db, order, total, receipt)
    except Exception:  # noqa: BLE001
        log.exception("receipt verification failed")
        receipt, res = None, None

    if res and res.ok:
        ok = await db.confirm_payment(order["id"], res.card_payment_id, receipt.transaction_id, receipt.amount,
                                      receipt.paid_at)
        if ok:
            await db.log_event(msg.from_user.id, "paid", order["service"])
            await wait.edit_text(res.reason)
            await state.clear()
            await deliver(bot, order["id"])
            return
        res.ok, res.reason, res.manual = False, "❌ Bu chek yoki to'lov allaqachon ishlatilgan.", False

    if res is None or res.manual:
        await wait.edit_text("🕐 Chek adminga yuborildi. Tasdiqlangach fayl avtomatik keladi.")
        r = receipt
        if r and r.transaction_id:
            # Admin tasdiqlaganda ham chek ID band qilinadi — qayta ishlatib bo'lmaydi
            order["params"]["pending_receipt"] = {"id": r.transaction_id, "amount": r.amount}
            await db.update_order(order["id"], params=order["params"])
        info = (f"ID: <code>{html.escape(r.transaction_id or '—')}</code>\nSumma: {r.amount}\n"
                f"Vaqt: {r.paid_at}\n" if r else "Chekni o'qib bo'lmadi\n")
        caption = (f"🧾 <b>Qo'lda tekshirish</b> — buyurtma #{order['id']} ({SERVICES[order['service']].title})\n"
                   f"Kutilgan: {fmt_sum(total)}\n{info}"
                   f"Sabab: {html.escape(res.reason if res else 'xatolik')}\n"
                   f"Mijoz: <a href='tg://user?id={msg.from_user.id}'>{msg.from_user.id}</a>")
        for aid in config.admin_ids:
            try:
                await msg.forward(aid)
            except Exception:  # noqa: BLE001
                log.exception("forward to admin failed")
        await notify_admins(bot, caption, reply_markup=ui.admin_review_kb(order["id"]))
        return

    await db.log_event(msg.from_user.id, "receipt_fail", order["service"])
    await wait.edit_text(res.reason + "\n\nTo'g'ri chekni yuboring yoki buyurtmani bekor qiling.")


@router.message(Flow.receipt, F.photo | F.document | F.text)
async def receipt_in_state(msg: Message, state: FSMContext, bot: Bot):
    if msg.text and msg.text.startswith("/"):
        return
    oid = (await state.get_data()).get("order_id")
    order = await db.get_order(oid) if oid else None
    if not order or order["status"] != "awaiting_payment":
        await state.clear()
        await msg.answer("Buyurtma topilmadi.", reply_markup=ui.main_menu())
        return
    await _process(msg, state, bot, order)


@router.message(StateFilter(None), F.photo | F.document)
async def receipt_without_state(msg: Message, state: FSMContext, bot: Bot):
    """Holat yo'qolgan bo'lsa ham (bot qayta ishga tushgan) — eng oxirgi kutilayotgan buyurtma uchun."""
    orders = await db.awaiting_orders(msg.from_user.id)
    if not orders:
        await msg.answer("Avval xizmatni tanlang:", reply_markup=ui.main_menu())
        return
    order = await db.get_order(orders[0]["id"])
    await _process(msg, state, bot, order)


# ---------- admin ----------

@router.callback_query(F.data.startswith("adm_ok:") | F.data.startswith("adm_no:"))
async def admin_decision(cb: CallbackQuery, bot: Bot):
    if cb.from_user.id not in config.admin_ids:
        await cb.answer("Ruxsat yo'q", show_alert=True)
        return
    oid = int(cb.data.split(":")[1])
    order = await db.get_order(oid)
    if not order or order["status"] != "awaiting_payment":
        await cb.answer("Buyurtma allaqachon ko'rib chiqilgan.", show_alert=True)
        await cb.message.edit_reply_markup(reply_markup=None)
        return
    if cb.data.startswith("adm_ok:"):
        pr = order["params"].get("pending_receipt") or {}
        ok = await db.confirm_payment(oid, None, pr.get("id"), pr.get("amount") or order_total(order), None)
        if not ok:
            await cb.answer("Bu chek ID boshqa buyurtmada ishlatilgan!", show_alert=True)
            return
        await db.log_event(order["user_id"], "paid", order["service"])
        await cb.message.edit_text(cb.message.html_text + "\n\n✅ Tasdiqlandi", reply_markup=None)
        await deliver(bot, oid)
    else:
        await cb.message.edit_text(cb.message.html_text + "\n\n❌ Rad etildi", reply_markup=None)
        await bot.send_message(order["user_id"], f"❌ Buyurtma #{oid} bo'yicha to'lov tasdiqlanmadi. "
                                                 "To'g'ri chekni yuboring yoki admin bilan bog'laning.")
    await cb.answer()
