"""Telegram Business rejimi: ulanish, xabarlarni saqlash, yozishni bloklash."""
import datetime

import pytest
from aiogram.client.session.base import BaseSession
from aiogram.methods import ReadBusinessMessage, SendMessage
from aiogram.types import Chat, Update, User
from aiogram.types import Message as TgMessage

from yordamchi.agent import Agent
from yordamchi.ai.base import AI, Provider
from yordamchi.bot import AssistantBot
from yordamchi.config import Config
from yordamchi.db import Database
from yordamchi.store import MessageStore

OWNER = 42
FRIEND = 777


class FakeSession(BaseSession):
    def __init__(self, owner_id):
        super().__init__()
        self.sent = []
        self.owner_id = owner_id

    async def make_request(self, bot, method, timeout=None):
        self.sent.append(method)
        if isinstance(method, SendMessage):
            return TgMessage(message_id=len(self.sent), date=datetime.datetime.now(),
                             chat=Chat(id=method.chat_id, type="private"), text=method.text)
        if type(method).__name__ == "GetBusinessConnection":
            from aiogram.types import BusinessConnection
            return BusinessConnection(id=method.business_connection_id, user=User(id=OWNER, is_bot=False, first_name="Men"),
                                      user_chat_id=OWNER, date=datetime.datetime.now(), is_enabled=True)
        return True

    async def close(self):
        pass

    async def stream_content(self, *a, **k):
        yield b""


@pytest.fixture
def setup(tmp_path):
    cfg = Config(bot_token="123456:ABCDEF", owner_id=OWNER, data_dir=tmp_path)
    cfg.ensure_dirs()
    agent = Agent(cfg, Database(":memory:"), MessageStore(":memory:"), AI([Provider()]))
    ab = AssistantBot(cfg, agent)
    fs = FakeSession(OWNER)
    fs.middleware = ab.bot.session.middleware
    ab.bot.session = fs
    return ab, agent, fs


def upd(ab, data):
    return Update.model_validate({"update_id": 1, **data}, context={"bot": ab.bot})


def biz_msg(mid, from_id, text, conn="c1", key="business_message"):
    return {key: {"message_id": mid, "date": 1_800_000_000, "business_connection_id": conn,
                  "chat": {"id": FRIEND, "type": "private", "first_name": "Ali", "last_name": "Valiyev", "username": "ali"},
                  "from": {"id": from_id, "is_bot": False, "first_name": "Ali" if from_id == FRIEND else "Men"},
                  "text": text}}


@pytest.mark.asyncio
async def test_business_flow(setup):
    ab, agent, fs = setup
    conn = {"business_connection": {"id": "c1", "user": {"id": OWNER, "is_bot": False, "first_name": "Men"},
                                    "user_chat_id": OWNER, "date": 1_800_000_000, "is_enabled": True,
                                    "rights": {"can_reply": True, "can_read_messages": True}}}
    await ab.dp.feed_update(ab.bot, upd(ab, conn))
    notes = [m for m in fs.sent if isinstance(m, SendMessage)]
    assert notes and notes[0].chat_id == OWNER and "ulandim" in notes[0].text and "faqat xabarlarni o'qish" in notes[0].text
    assert agent.db.get_json("business_connections") == ["c1"]

    await ab.dp.feed_update(ab.bot, upd(ab, biz_msg(10, FRIEND, "Ertaga hisobotni yuboring")))
    await ab.dp.feed_update(ab.bot, upd(ab, biz_msg(11, OWNER, "Xo'p, yuboraman")))
    rows = agent.store.recent(FRIEND)
    assert [(r["msg_id"], r["out"], r["text"]) for r in rows] == [(10, 0, "Ertaga hisobotni yuboring"), (11, 1, "Xo'p, yuboraman")]
    assert agent.store.chat(FRIEND)["title"] == "Ali Valiyev"
    assert any(c["tg_id"] == FRIEND for c in agent.db.contacts())

    await ab.dp.feed_update(ab.bot, upd(ab, biz_msg(10, FRIEND, "Bugun hisobotni yuboring", key="edited_business_message")))
    assert agent.store.recent(FRIEND)[0]["text"] == "Bugun hisobotni yuboring"
    assert agent.store.q("SELECT old_text FROM message_edits")[0]["old_text"] == "Ertaga hisobotni yuboring"

    await ab.dp.feed_update(ab.bot, upd(ab, {"deleted_business_messages": {
        "business_connection_id": "c1", "chat": {"id": FRIEND, "type": "private"}, "message_ids": [10]}}))
    rows = agent.store.recent(FRIEND)
    assert rows[0]["deleted_at"] and rows[0]["text"] == "Bugun hisobotni yuboring"  # bazada qoladi

    # bot business chatlarga hech narsa yubormagan — faqat egasiga
    assert all(m.chat_id == OWNER for m in fs.sent if isinstance(m, SendMessage))
    assert not any(getattr(m, "business_connection_id", None) for m in fs.sent)


@pytest.mark.asyncio
async def test_business_ignores_foreign_connection(setup):
    ab, agent, fs = setup
    conn = {"business_connection": {"id": "x9", "user": {"id": 555, "is_bot": False, "first_name": "Begona"},
                                    "user_chat_id": 555, "date": 1_800_000_000, "is_enabled": True}}
    await ab.dp.feed_update(ab.bot, upd(ab, conn))
    assert fs.sent == [] and agent.db.get_json("business_connections") is None


@pytest.mark.asyncio
async def test_business_writes_blocked(setup):
    ab, agent, fs = setup
    with pytest.raises(PermissionError):
        await ab.bot(ReadBusinessMessage(business_connection_id="c1", chat_id=FRIEND, message_id=1))
    with pytest.raises(PermissionError):
        await ab.bot.send_message(OWNER, "x", business_connection_id="c1")
    with pytest.raises(PermissionError):
        await ab.bot.send_message(FRIEND, "salom")
    assert fs.sent == []
