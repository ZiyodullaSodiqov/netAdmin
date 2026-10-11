import os
from datetime import datetime, timedelta, timezone

import pytest

os.environ.setdefault("DB_PATH", "/tmp/netadmin-bot-test/bot.db")
os.environ.setdefault("WORK_DIR", "/tmp/netadmin-bot-test/files")

from app.config import config  # noqa: E402
from app.db import DB, iso  # noqa: E402
from app.payments import verifier  # noqa: E402
from app.payments.parser import parse_amount, parse_card_message  # noqa: E402
from app.payments.verifier import Receipt, receipt_from_dict, verify  # noqa: E402

TZ = timezone(timedelta(hours=5))


@pytest.mark.parametrize("text,amount,dt,card", [
    ("🟢 Пополнение\n➕ 10 000.00 UZS\n📍 CLICK P2P>TOSHKENT\n💳 HUMOCARD *1234\n🕓 14:25 11.10.2026\n"
     "💰 125 000.00 UZS", 10000, datetime(2026, 10, 11, 14, 25, tzinfo=TZ), "1234"),
    ("Popolnenie scheta: 13,500.00 UZS\nKarta: ***5678\nData: 11.10.26 09:05\nDostupno: 1,125,000.00 UZS",
     13500, datetime(2026, 10, 11, 9, 5, tzinfo=TZ), "5678"),
    ("To'ldirish ➕ 5 000 so'm 💳 *4321 🕓 11.10.2026 23:59 💰 Balans: 9 000 so'm",
     5000, datetime(2026, 10, 11, 23, 59, tzinfo=TZ), "4321"),
    ("🎉 Пополнение 8.000,00 сум карта ****1111 2026-10-11 10:00", 8000,
     datetime(2026, 10, 11, 10, 0, tzinfo=TZ), "1111"),
])
def test_parse_credit(text, amount, dt, card):
    tx = parse_card_message(text, TZ)
    assert tx is not None
    assert tx.amount == amount
    assert tx.paid_at == dt
    assert tx.card_last4 == card


@pytest.mark.parametrize("text", [
    "🔴 Оплата\n➖ 10 000.00 UZS\n📍 KORZINKA\n💳 HUMOCARD *1234\n🕓 14:25 11.10.2026",
    "Spisanie: 5,000.00 UZS Karta ***1234",
    "Assalomu alaykum! Yangi xizmat",
])
def test_parse_not_credit(text):
    assert parse_card_message(text, TZ) is None


def test_parse_amount():
    assert parse_amount("10 000.00") == 10000
    assert parse_amount("10,000.00") == 10000
    assert parse_amount("10.000,00") == 10000
    assert parse_amount("10.000") == 10000
    assert parse_amount("7000") == 7000


def test_receipt_from_dict():
    r = receipt_from_dict({"transaction_id": " 1234 5678 ", "amount": "10 000,00 so'm",
                           "datetime": "2026-10-11 14:26", "status": "success", "receiver_card_last4": "**** 1234"})
    assert r.transaction_id == "12345678"
    assert r.amount == 10000
    assert r.paid_at == datetime(2026, 10, 11, 14, 26, tzinfo=TZ)
    assert r.receiver_last4 == "1234"


@pytest.fixture
async def db(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "tg_api_id", 1)
    monkeypatch.setattr(config, "tg_session_string", "x")
    monkeypatch.setattr(config, "card_number", "8600 1111 2222 1234")
    monkeypatch.setattr(config, "payment_wait_sec", 0)
    d = DB(str(tmp_path / "t.db"))
    await d.connect()
    yield d
    await d.close()


def _receipt(tid="T1", amount=10000, at=None):
    return Receipt(tid, amount, at or datetime.now(timezone.utc), "success", "1234", False, True)


async def _order(db, minutes_ago=3):
    oid = await db.create_order(1, "slides", {}, 10000, 0)
    created = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    await db.update_order(oid, status="awaiting_payment", created_at=iso(created))
    return await db.get_order(oid)


async def test_verify_matches_card_payment(db):
    order = await _order(db)
    now = datetime.now(timezone.utc)
    pid = await db.add_card_payment(10000, now - timedelta(minutes=1), "1234", "raw", 1)
    res = await verify(db, order, 10000, _receipt(at=now))
    assert res.ok and res.card_payment_id == pid
    assert await db.confirm_payment(order["id"], pid, "T1", 10000, now)
    assert (await db.get_order(order["id"]))["status"] == "paid"

    # Xuddi shu chekni boshqa buyurtmaga ishlatib bo'lmaydi
    order2 = await _order(db)
    await db.add_card_payment(10000, now, "1234", "raw2", 2)
    res2 = await verify(db, order2, 10000, _receipt(at=now))
    assert not res2.ok and "ishlatilgan" in res2.reason


async def test_verify_no_card_payment_goes_manual(db):
    order = await _order(db)
    res = await verify(db, order, 10000, _receipt())
    assert not res.ok and res.manual


async def test_verify_rejects_wrong_amount_card_time(db):
    order = await _order(db)
    now = datetime.now(timezone.utc)
    await db.add_card_payment(5000, now, "1234", "raw", 1)
    assert not (await verify(db, order, 10000, _receipt(amount=5000))).ok  # summa kam
    r = _receipt()
    r.receiver_last4 = "9999"
    assert "boshqa kartaga" in (await verify(db, order, 10000, r)).reason
    old = _receipt(tid="T9", at=now - timedelta(hours=1))
    assert "oldingi" in (await verify(db, order, 10000, old)).reason


async def test_card_payment_used_once(db):
    order = await _order(db)
    order2 = await _order(db)
    now = datetime.now(timezone.utc)
    pid = await db.add_card_payment(10000, now, "1234", "raw", 1)
    assert await db.confirm_payment(order["id"], pid, "A", 10000, now)
    # Bitta kirim bilan ikkinchi buyurtmani yopib bo'lmaydi
    assert not await db.confirm_payment(order2["id"], pid, "B", 10000, now)
    assert not await verifier.find_card_payment(db, 10000, now, now - timedelta(minutes=5), "1234")
    assert (await db.get_order(order2["id"]))["status"] == "awaiting_payment"


async def test_math_credits(db):
    await db.upsert_user(7, "u", "U")
    assert await db.use_math(7) == "free"
    assert await db.use_math(7) is None
    await db.add_math_credits(7, 10)
    assert await db.use_math(7) == "credit"
    assert (await db.get_user(7))["math_credits"] == 9
