"""Admin panel (/admin): statistika, urinishlar, foydalanuvchilar, to'lovlar, xabar yuborish."""
from __future__ import annotations

import asyncio
import html

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramForbiddenError, TelegramRetryAfter
from aiogram.filters import Command, CommandObject
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, Message

from ..config import config
from ..db import db
from ..delivery import deliver, order_total
from ..services import SERVICES, fmt_sum
from .. import stats
from ..ui import admin_review_kb, ikb

router = Router()
_is_admin = F.from_user.id.in_(set(config.admin_ids))
router.message.filter(_is_admin)
router.callback_query.filter(_is_admin)


class AdminFlow(StatesGroup):
    broadcast = State()


ACTIONS = {"start": "/start", "open": "xizmatni ochgan", "generate": "yaratgan (urinish)", "error": "xatolik",
           "buy": "«sotib olaman» bosgan", "receipt": "chek yuborgan", "receipt_fail": "chek rad etilgan",
           "paid": "to'lagan"}


def home_kb():
    return ikb([
        [("📊 Umumiy statistika", "ap:ov:today"), ("🔁 Urinishlar", "ap:att:today")],
        [("👥 Faol foydalanuvchilar", "ap:top:7d"), ("🧾 To'lov kutilayotganlar", "ap:wait")],
        [("💳 Karta kirimlari", "ap:card"), ("📣 Xabar yuborish", "ap:bc")],
    ])


def period_kb(section: str, current: str):
    row = [(("• " if p == current else "") + title, f"ap:{section}:{p}") for p, title in stats.PERIODS.items()]
    return ikb([row, [("⬅️ Admin panel", "ap:home")]])


def svc_title(key: str | None) -> str:
    return SERVICES[key].title if key in SERVICES else (key or "—")


async def _show(cb: CallbackQuery, text: str, kb) -> None:
    await cb.answer()
    try:
        await cb.message.edit_text(text, reply_markup=kb, disable_web_page_preview=True)
    except Exception:  # noqa: BLE001 — matn o'zgarmagan bo'lsa
        pass


@router.message(Command("admin"))
async def admin_home(msg: Message, state: FSMContext):
    await state.clear()
    await msg.answer("🛠 <b>Admin panel</b>", reply_markup=home_kb())


@router.callback_query(F.data == "ap:home")
async def cb_home(cb: CallbackQuery, state: FSMContext):
    await state.clear()
    await _show(cb, "🛠 <b>Admin panel</b>", home_kb())


@router.callback_query(F.data.startswith("ap:ov:"))
async def cb_overview(cb: CallbackQuery):
    period = cb.data.split(":")[2]
    o = await stats.overview(db, period)
    ev = o["events"]
    lines = [f"📊 <b>Umumiy statistika — {stats.PERIODS[period]}</b>", "",
             f"👥 Jami foydalanuvchilar: <b>{o['users']}</b>",
             f"🆕 Yangi qo'shilganlar: <b>{o['new_users']}</b>",
             f"🟢 Faol (biror narsa qilgan): <b>{o['active']}</b>", ""]
    for action, label in ACTIONS.items():
        if action in ev:
            lines.append(f"• {label}: <b>{ev[action]['u']}</b> kishi, <b>{ev[action]['n']}</b> marta")
    lines += ["", f"✅ To'langan buyurtmalar: <b>{o['paid_orders']}</b>",
              f"💰 Tushum: <b>{fmt_sum(o['revenue'])}</b>",
              f"⏳ To'lov kutilmoqda: <b>{o['waiting']}</b>"]
    await _show(cb, "\n".join(lines), period_kb("ov", period))


@router.callback_query(F.data.startswith("ap:att:"))
async def cb_attempts(cb: CallbackQuery):
    period = cb.data.split(":")[2]
    rows = await stats.attempts_by_service(db, period)
    lines = [f"🔁 <b>Urinishlar — {stats.PERIODS[period]}</b>",
             "<i>kirgan: necha kishi / necha marta • yaratgan: necha kishi / necha marta • to'lagan</i>", ""]
    if not rows:
        lines.append("Hali ma'lumot yo'q.")
    tot_users = tot_gens = 0
    for r in rows:
        tot_users += r["gen_users"] or 0
        tot_gens += r["gens"] or 0
        conv = f"{round(100 * (r['paid_users'] or 0) / r['gen_users'])}%" if r["gen_users"] else "—"
        lines.append(
            f"<b>{svc_title(r['service'])}</b>\n"
            f"   kirgan: {r['open_users'] or 0} kishi / {r['opens'] or 0} marta\n"
            f"   yaratgan: {r['gen_users'] or 0} kishi / {r['gens'] or 0} marta"
            + (f" (xato: {r['errors']})" if r["errors"] else "") + "\n"
            f"   sotib olmoqchi: {r['buys'] or 0} • rad etilgan chek: {r['receipt_fails'] or 0}\n"
            f"   to'lagan: {r['paid_users'] or 0} kishi / {r['paid'] or 0} marta • konversiya: {conv}")
    if rows:
        lines += ["", f"Jami urinishlar: <b>{tot_gens}</b>"]
    text = "\n".join(lines)
    await _show(cb, text[:4000], period_kb("att", period))


@router.callback_query(F.data.startswith("ap:top:"))
async def cb_top(cb: CallbackQuery):
    period = cb.data.split(":")[2]
    rows = await stats.top_users(db, period)
    lines = [f"👥 <b>Eng faol foydalanuvchilar — {stats.PERIODS[period]}</b>", ""]
    btns = []
    for i, r in enumerate(rows, 1):
        name = html.escape(r["full_name"] or str(r["user_id"]))
        uname = f" @{r['username']}" if r["username"] else ""
        lines.append(f"{i}. {name}{uname} — urinish: <b>{r['gens'] or 0}</b>, kirgan: {r['opens'] or 0}, "
                     f"to'lagan: {r['paid'] or 0}, jami: {fmt_sum(r['spent'] or 0)}")
        btns.append((f"{i}. {(r['full_name'] or str(r['user_id']))[:18]}", f"ap:u:{r['user_id']}"))
    if not rows:
        lines.append("Hali ma'lumot yo'q.")
    kb = period_kb("top", period)
    kb.inline_keyboard[:0] = ikb([btns[i:i + 2] for i in range(0, len(btns), 2)]).inline_keyboard
    await _show(cb, "\n".join(lines)[:4000], kb)


async def user_text(uid: int) -> str | None:
    d = await stats.user_detail(db, uid)
    if not d:
        return None
    u = d["user"]
    lines = [f"👤 <b>{html.escape(u['full_name'] or '')}</b>" + (f" @{u['username']}" if u["username"] else ""),
             f"ID: <code>{uid}</code> • <a href='tg://user?id={uid}'>yozish</a>",
             f"Qo'shilgan: {u['created_at'][:10]}",
             f"Misol: bepul {'ishlatilgan' if u['free_math_used'] else 'bor'}, kredit {u['math_credits']}",
             f"Jami to'lagan: <b>{fmt_sum(d['spent'])}</b>", "", "<b>Xizmatlar bo'yicha:</b>"]
    for r in d["per_service"]:
        lines.append(f"• {svc_title(r['service'])}: kirgan {r['opens'] or 0}, urinish {r['gens'] or 0}, "
                     f"to'lagan {r['paid'] or 0}")
    if d["orders"]:
        lines += ["", "<b>Oxirgi buyurtmalar:</b>"]
        for o in d["orders"]:
            lines.append(f"#{o['id']} {svc_title(o['service'])} — {o['status']} — {fmt_sum(order_total(o))}")
    return "\n".join(lines)


@router.callback_query(F.data.startswith("ap:u:"))
async def cb_user(cb: CallbackQuery):
    text = await user_text(int(cb.data.split(":")[2]))
    await _show(cb, text or "Topilmadi", ikb([[("⬅️ Faol foydalanuvchilar", "ap:top:7d")],
                                              [("⬅️ Admin panel", "ap:home")]]))


@router.message(Command("user"))
async def cmd_user(msg: Message, command: CommandObject):
    if not command.args or not command.args.strip().lstrip("-").isdigit():
        await msg.answer("Foydalanish: /user <telegram_id>")
        return
    await msg.answer(await user_text(int(command.args)) or "Topilmadi", disable_web_page_preview=True)


@router.callback_query(F.data == "ap:wait")
async def cb_wait(cb: CallbackQuery, bot: Bot):
    rows = await db._all("SELECT * FROM orders WHERE status='awaiting_payment' ORDER BY id DESC LIMIT 10")
    await _show(cb, f"🧾 <b>To'lov kutilayotganlar</b>: {len(rows)} ta (oxirgi 10)",
                ikb([[("⬅️ Admin panel", "ap:home")]]))
    for o in rows:
        await cb.message.answer(
            f"#{o['id']} {svc_title(o['service'])}\nMijoz: <a href='tg://user?id={o['user_id']}'>{o['user_id']}</a>\n"
            f"Summa: {fmt_sum(order_total(o))}\nYaratilgan: {o['created_at'][:16]}",
            reply_markup=admin_review_kb(o["id"]))


@router.callback_query(F.data == "ap:card")
async def cb_card(cb: CallbackQuery):
    rows = await db._all("SELECT * FROM card_payments ORDER BY id DESC LIMIT 20")
    if not rows:
        text = "💳 Karta kirimlari hali yo'q. Userbot sozlanganmi (TG_SESSION_STRING)?"
    else:
        text = "💳 <b>Oxirgi karta kirimlari</b>\n\n" + "\n".join(
            f"#{r['id']} {fmt_sum(r['amount'])} — {r['paid_at'][:16]} — *{r['card_last4'] or '----'} — "
            + (f"buyurtma #{r['order_id']}" if r["order_id"] else "bog'lanmagan") for r in rows)
    await _show(cb, text, ikb([[("🔄 Yangilash", "ap:card")], [("⬅️ Admin panel", "ap:home")]]))


# ---------- xabar yuborish ----------

@router.callback_query(F.data == "ap:bc")
async def cb_broadcast(cb: CallbackQuery, state: FSMContext):
    await state.set_state(AdminFlow.broadcast)
    await _show(cb, "📣 Barcha foydalanuvchilarga yuboriladigan xabarni yuboring (matn, rasm, video — istalgan).",
                ikb([[("❌ Bekor qilish", "ap:home")]]))


@router.message(AdminFlow.broadcast)
async def do_broadcast(msg: Message, state: FSMContext, bot: Bot):
    await state.clear()
    ids = await db.all_user_ids()
    status = await msg.answer(f"📣 Yuborilmoqda: 0/{len(ids)}")
    ok = fail = 0
    for i, uid in enumerate(ids, 1):
        try:
            await msg.copy_to(uid)
            ok += 1
        except TelegramRetryAfter as e:
            await asyncio.sleep(e.retry_after)
            try:
                await msg.copy_to(uid)
                ok += 1
            except Exception:  # noqa: BLE001
                fail += 1
        except (TelegramForbiddenError, Exception):  # noqa: BLE001 — botni bloklagan va h.k.
            fail += 1
        await asyncio.sleep(0.05)  # Telegram limiti: ~20 xabar/soniya
        if i % 100 == 0:
            await status.edit_text(f"📣 Yuborilmoqda: {i}/{len(ids)}")
    await status.edit_text(f"✅ Yuborildi: {ok}\n❌ Yetib bormadi (bloklagan): {fail}", reply_markup=home_kb())


# ---------- qo'lda tasdiqlash ----------

@router.message(Command("confirm"))
async def confirm(msg: Message, command: CommandObject, bot: Bot):
    """/confirm 15 — 15-buyurtmani qo'lda to'langan deb belgilash."""
    if not command.args or not command.args.strip().isdigit():
        await msg.answer("Foydalanish: /confirm <buyurtma_id>")
        return
    oid = int(command.args)
    o = await db.get_order(oid)
    if not o or o["status"] != "awaiting_payment":
        await msg.answer("Bunday to'lov kutilayotgan buyurtma yo'q.")
        return
    if await db.confirm_payment(oid, None, None, order_total(o), None):
        await db.log_event(o["user_id"], "paid", o["service"])
        await deliver(bot, oid)
        await msg.answer(f"✅ #{oid} tasdiqlandi va yuborildi.")
