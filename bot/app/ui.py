"""Klaviaturalar va umumiy matnlar."""
from __future__ import annotations

from aiogram.types import (InlineKeyboardButton as B, InlineKeyboardMarkup, KeyboardButton,
                           ReplyKeyboardMarkup, ReplyKeyboardRemove)

from .config import config
from .services import LANG_NAMES, SERVICES, fmt_sum


def ikb(rows: list[list[tuple[str, str]]]) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[[B(text=t, callback_data=d) for t, d in row] for row in rows])


def main_menu() -> InlineKeyboardMarkup:
    items = [(s.title, f"svc:{s.key}") for s in SERVICES.values()]
    rows = [items[i:i + 2] for i in range(0, len(items), 2)]
    rows.append([("💰 Narxlar", "prices"), ("📦 Buyurtmalarim", "my_orders")])
    rows.append([("💡 Taklif yuborish", "feedback:suggestion"), ("📞 Admin bilan bog'lanish", "feedback:contact")])
    return ikb(rows)


def langs_kb(langs: tuple[str, ...]) -> InlineKeyboardMarkup:
    return ikb([[(LANG_NAMES[l], f"ans:{l}") for l in langs], [("⬅️ Menyu", "menu")]])


def choices_kb(options: list[tuple[str, str]], per_row: int = 3) -> InlineKeyboardMarkup:
    rows = [[(t, f"ans:{v}") for t, v in options[i:i + per_row]] for i in range(0, len(options), per_row)]
    rows.append([("⬅️ Menyu", "menu")])
    return ikb(rows)


def skip_kb() -> InlineKeyboardMarkup:
    return ikb([[("➡️ O'tkazib yuborish", "ans:-")], [("⬅️ Menyu", "menu")]])


def done_kb() -> InlineKeyboardMarkup:
    return ikb([[("✅ Tayyor", "ans:done")], [("⬅️ Menyu", "menu")]])


def preview_kb(order_id: int, can_regen: bool) -> InlineKeyboardMarkup:
    rows = [[("✅ Yoqdi, sotib olaman", f"buy:{order_id}")]]
    if can_regen:
        rows.append([("🔁 Qayta yaratish", f"regen:{order_id}")])
    rows.append([("❌ Bekor qilish", f"cancel:{order_id}")])
    return ikb(rows)


def print_kb(order_id: int, price: int) -> InlineKeyboardMarkup:
    return ikb([[(f"🖨 Ha, qog'ozda (+{fmt_sum(price)})", f"print:{order_id}:1")],
                [("📲 Yo'q, faqat fayl", f"print:{order_id}:0")]])


def contact_kb() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(keyboard=[[KeyboardButton(text="📱 Raqamni yuborish", request_contact=True)]],
                               resize_keyboard=True, one_time_keyboard=True)


remove_kb = ReplyKeyboardRemove()


def admin_review_kb(order_id: int) -> InlineKeyboardMarkup:
    return ikb([[("✅ Tasdiqlash", f"adm_ok:{order_id}"), ("❌ Rad etish", f"adm_no:{order_id}")]])


def payment_text(order_id: int, service_title: str, price: int, print_price: int) -> str:
    total = price + print_price
    lines = [f"🧾 <b>Buyurtma #{order_id}</b> — {service_title}", f"Xizmat: {fmt_sum(price)}"]
    if print_price:
        lines.append(f"Qog'ozda chiqarish: {fmt_sum(print_price)}")
    lines += [
        f"<b>Jami: {fmt_sum(total)}</b>", "",
        f"💳 Karta: <code>{config.card_number}</code>",
        f"👤 {config.card_owner}", "",
        f"Aynan <b>{fmt_sum(total)}</b> o'tkazing va to'lov <b>chekini</b> (skrinshot, PDF yoki chek matni) "
        "shu yerga yuboring. Chek avtomatik tekshiriladi va fayl darhol yuboriladi.",
    ]
    return "\n".join(lines)


def prices_text() -> str:
    out = ["<b>💰 Narxlar</b>"]
    for s in SERVICES.values():
        line = f"{s.title}: {fmt_sum(s.price)}"
        if s.base_pages:
            line += f" ({s.base_pages} varoq)"
        if s.kind == "ocr":
            line += " / 1 list"
        if s.kind == "math":
            line = f"{s.title}: 1-si bepul, keyin {s.extra['pack']} ta misol — {fmt_sum(s.price)}"
        if s.print_price:
            line += f", qog'ozda +{fmt_sum(s.print_price)}"
        out.append("• " + line)
    return "\n".join(out)
