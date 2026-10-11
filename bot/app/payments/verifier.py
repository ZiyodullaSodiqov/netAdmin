"""To'lovni avtomatik tasdiqlash.

1. Mijoz chek yuboradi (rasm / PDF / matn) → OpenAI chekdan ID, summa, vaqt, holat, qabul qiluvchi kartani o'qiydi.
2. Chek ID avval ishlatilmaganini tekshiramiz (bitta chek bilan ikki marta to'lab bo'lmaydi).
3. Summa buyurtma summasidan kam emasligini, vaqt buyurtma yaratilgandan keyin ekanini tekshiramiz.
4. Userbot karta xabarlari botidan olgan kirimlar orasidan xuddi shu summa va ±N daqiqa vaqtdagi,
   hali hech bir buyurtmaga bog'lanmagan kirimni qidiramiz. Xabar kechiksa biroz kutamiz.
5. Hammasi mos kelsa — buyurtma atomar ravishda 'paid' bo'ladi.
"""
from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta

from ..ai.clients import vision_json
from ..config import config
from ..db import DB, now_utc, parse_iso
from .parser import parse_amount, parse_datetime

log = logging.getLogger(__name__)

RECEIPT_PROMPT = (
    "Bu bank/to'lov ilovasi (Click, Payme, Uzum, Paynet, bank ilovasi) cheki bo'lishi mumkin. Undan ma'lumotlarni "
    "aynan o'qib ol, hech narsa to'qima.\n"
    'Faqat JSON: {"is_receipt": true, "transaction_id": "tranzaksiya/chek/operatsiya raqami yoki ID", '
    '"amount": "o\'tkazilgan summa (komissiyasiz) raqam ko\'rinishida", "datetime": "YYYY-MM-DD HH:MM", '
    '"status": "success|pending|failed", "receiver_card_last4": "qabul qiluvchi karta oxirgi 4 raqami", '
    '"edited_suspicion": false} — rasm tahrirlangan/soxta ko\'rinsa edited_suspicion=true.'
)


@dataclass
class Receipt:
    transaction_id: str | None
    amount: int
    paid_at: datetime | None
    status: str
    receiver_last4: str | None
    suspicious: bool
    is_receipt: bool


@dataclass
class VerifyResult:
    ok: bool
    reason: str  # foydalanuvchiga ko'rsatiladigan izoh
    manual: bool = False  # admin qo'lda tekshirishi kerak
    receipt: Receipt | None = None
    card_payment_id: int | None = None


async def read_receipt(image: bytes | None = None, mime: str = "image/jpeg", text: str | None = None) -> Receipt:
    if image is not None:
        d = await vision_json(RECEIPT_PROMPT, [(image, mime)], temperature=0)
    else:
        d = await vision_json(RECEIPT_PROMPT + "\n\nChek matni:\n" + (text or ""), temperature=0)
    return receipt_from_dict(d)


def receipt_from_dict(d: dict) -> Receipt:
    amount_raw = str(d.get("amount") or "0")
    tid = re.sub(r"\s+", "", str(d.get("transaction_id") or "")) or None
    last4 = re.sub(r"\D", "", str(d.get("receiver_card_last4") or ""))[-4:] or None
    return Receipt(
        transaction_id=tid,
        amount=parse_amount(re.sub(r"[^\d.,\s]", "", amount_raw)),
        paid_at=parse_datetime(str(d.get("datetime") or ""), config.tz),
        status=str(d.get("status") or "").lower(),
        receiver_last4=last4,
        suspicious=bool(d.get("edited_suspicion")),
        is_receipt=bool(d.get("is_receipt", True)),
    )


def card_last4() -> str | None:
    digits = re.sub(r"\D", "", config.card_number)
    return digits[-4:] if len(digits) >= 4 else None


async def find_card_payment(db: DB, amount: int, paid_at: datetime | None, not_before: datetime,
                            receiver_last4: str | None) -> dict | None:
    tol = timedelta(minutes=config.payment_time_tolerance_min)
    best, best_diff = None, None
    for p in await db.free_card_payments(amount):
        p_at = parse_iso(p["paid_at"])
        if p_at < not_before - tol:
            continue
        if receiver_last4 and p["card_last4"] and p["card_last4"] != receiver_last4:
            continue
        diff = abs((p_at - paid_at).total_seconds()) if paid_at else 0
        if paid_at and diff > tol.total_seconds():
            continue
        if best is None or diff < best_diff:
            best, best_diff = p, diff
    return best


async def verify(db: DB, order: dict, total: int, receipt: Receipt, wait: bool = True) -> VerifyResult:
    if not receipt.is_receipt:
        return VerifyResult(False, "Bu to'lov cheki emas. Iltimos, to'lov ilovasidagi chekni yuboring.")
    if receipt.status and receipt.status not in ("success", "successful", "ok", "paid"):
        return VerifyResult(False, "Chekda to'lov muvaffaqiyatli emas (holati: " + receipt.status + ").")
    if not receipt.transaction_id or not receipt.amount:
        return VerifyResult(False, "Chekdagi ID yoki summa o'qilmadi — admin qo'lda tekshiradi.", manual=True,
                            receipt=receipt)
    if await db.receipt_exists(receipt.transaction_id):
        return VerifyResult(False, "❌ Bu chek avval ishlatilgan.", receipt=receipt)
    if receipt.amount < total:
        return VerifyResult(False, f"❌ Chekdagi summa ({receipt.amount}) buyurtma summasidan ({total}) kam.",
                            receipt=receipt)
    our = card_last4()
    if receipt.receiver_last4 and our and receipt.receiver_last4 != our:
        return VerifyResult(False, "❌ Pul boshqa kartaga o'tkazilgan.", receipt=receipt)

    created = parse_iso(order["created_at"])
    tol = timedelta(minutes=config.payment_time_tolerance_min)
    if receipt.paid_at:
        if receipt.paid_at < created - tol:
            return VerifyResult(False, "❌ Chek buyurtma berilishidan oldingi vaqtga tegishli.", receipt=receipt)
        if receipt.paid_at > now_utc() + tol:
            return VerifyResult(False, "❌ Chekdagi vaqt noto'g'ri.", receipt=receipt)
        if now_utc() - receipt.paid_at > timedelta(minutes=config.payment_max_age_min):
            return VerifyResult(False, "Chek eskirgan — admin qo'lda tekshiradi.", manual=True, receipt=receipt)

    if receipt.suspicious:
        return VerifyResult(False, "Chek shubhali ko'rindi — admin qo'lda tekshiradi.", manual=True, receipt=receipt)

    if not (config.tg_api_id and config.tg_session_string):
        # Userbot sozlanmagan — karta xabarlarini solishtirib bo'lmaydi
        return VerifyResult(False, "Chek qabul qilindi, admin tasdiqlashini kuting.", manual=True, receipt=receipt)

    deadline = asyncio.get_running_loop().time() + (config.payment_wait_sec if wait else 0)
    while True:
        p = await find_card_payment(db, receipt.amount, receipt.paid_at, created, our)
        if p:
            return VerifyResult(True, "✅ To'lov tasdiqlandi!", receipt=receipt, card_payment_id=p["id"])
        if asyncio.get_running_loop().time() >= deadline:
            break
        await asyncio.sleep(10)
    return VerifyResult(False, "Kartaga tushum hali ko'rinmadi — admin qo'lda tekshiradi.", manual=True,
                        receipt=receipt)
