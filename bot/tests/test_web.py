import os
import re
from types import SimpleNamespace

import pytest

os.environ.setdefault("DB_PATH", "/tmp/netadmin-bot-test/bot.db")
os.environ.setdefault("WORK_DIR", "/tmp/netadmin-bot-test/files")

from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

from app import channels  # noqa: E402
from app.config import config  # noqa: E402
from app.db import db  # noqa: E402
from app.web.server import create_app  # noqa: E402

PASSWORD = "test-parol-123"


class FakeBot:
    def __init__(self):
        self.sent = []

    async def send_message(self, uid, text, **kw):
        self.sent.append((uid, text))

    async def send_document(self, uid, doc, **kw):
        self.sent.append((uid, doc.filename))

    async def me(self):
        return SimpleNamespace(id=999)

    async def get_chat(self, ch):
        return SimpleNamespace(title="Mening kanalim")

    async def get_chat_member(self, ch, uid):
        return SimpleNamespace(status="administrator")


@pytest.fixture
async def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "web_admin_password", PASSWORD)
    monkeypatch.setattr(config, "admin_ids", [])
    monkeypatch.setattr(channels, "_cache", None)
    db.path = str(tmp_path / "web.db")
    await db.connect()
    bot = FakeBot()
    c = TestClient(TestServer(create_app(bot)))
    await c.start_server()
    c.bot = bot
    yield c
    await c.close()
    await db.close()


async def login(c):
    r = await c.post("/login", data={"password": PASSWORD}, allow_redirects=False)
    assert r.status == 302


async def csrf(c, path="/broadcast"):
    html = await (await c.get(path)).text()
    return re.search(r'name="csrf" value="([0-9a-f]+)"', html).group(1)


async def test_requires_login(client):
    r = await client.get("/", allow_redirects=False)
    assert r.status == 302 and r.headers["Location"] == "/login"
    r = await client.post("/login", data={"password": "xato"})
    assert r.status == 401


async def test_all_pages_render(client):
    await db.upsert_user(1, "ali", "Ali Valiyev")
    await db.log_event(1, "open", "slides")
    await db.log_event(1, "generate", "slides")
    await db.add_message(1, "suggestion", "Yangi xizmat qo'shing <b>")
    await db.add_message(1, "contact", "Salom admin")
    oid = await db.create_order(1, "slides", {"phone": "+998"}, 10000, 5000)
    await db.update_order(oid, status="awaiting_payment", with_print=1)
    await login(client)
    for path in ["/", "/?p=all", "/attempts?p=7d", "/users", "/users?q=ali", "/users/1", "/orders",
                 "/orders?status=all", "/payments", "/messages?kind=suggestion", "/messages?kind=contact&status=all",
                 "/channels", "/broadcast"]:
        r = await client.get(path)
        assert r.status == 200, path
        text = await r.text()
        assert "<b>" not in text.split("Yangi xizmat")[-1][:10]  # foydalanuvchi matni escape qilingan
    assert "Ali Valiyev" in await (await client.get("/users")).text()


async def test_csrf_required(client):
    await login(client)
    r = await client.post("/channels", data={"channels": "@x"})
    assert r.status == 403


async def test_channels_reply_and_approve(client, tmp_path):
    await login(client)
    token = await csrf(client)
    r = await client.post("/channels", data={"csrf": token, "channels": "https://t.me/kanalim\n@ikkinchi\nkanalim"})
    assert r.status == 200
    assert await channels.get_channels() == ["@kanalim", "@ikkinchi"]

    await db.upsert_user(5, "u", "U")
    mid = await db.add_message(5, "contact", "Yordam kerak")
    await client.post(f"/messages/{mid}/reply", data={"csrf": token, "text": "Albatta!"})
    assert (await db.get_message(mid))["status"] == "answered"
    assert any(uid == 5 and "Albatta!" in t for uid, t in client.bot.sent)

    f = tmp_path / "r.pptx"
    f.write_bytes(b"x")
    oid = await db.create_order(5, "slides", {"files_out": [str(f)]}, 10000, 0)
    await db.update_order(oid, status="awaiting_payment")
    await client.post(f"/orders/{oid}/approve", data={"csrf": token})
    assert (await db.get_order(oid))["status"] == "delivered"
    assert any(uid == 5 and str(name).endswith(".zip") for uid, name in client.bot.sent)
