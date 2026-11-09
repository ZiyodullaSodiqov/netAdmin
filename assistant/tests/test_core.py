import json
from datetime import datetime, timedelta

import pytest

from yordamchi.agent import Agent, pick_offset
from yordamchi.ai.base import AI, Provider, parse_json
from yordamchi.config import Config
from yordamchi.contacts import find_contact, normalize
from yordamchi.db import Database
from yordamchi.guard import WriteBlockedError, check_request, is_allowed
from yordamchi.store import MessageStore, format_transcript
from yordamchi.timeutil import from_db, to_db, utcnow


class FakeProvider(Provider):
    name = "fake"

    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = []

    async def text(self, system, parts, json_mode=False):
        self.calls.append((system, parts))
        a = self.answers.pop(0)
        return a if isinstance(a, str) else json.dumps(a)

    async def transcribe(self, data, mime, filename="a.ogg"):
        return "ertaga soat 10 da Akmalga hisobotni yuborish"


class Broken(Provider):
    name = "broken"

    async def text(self, system, parts, json_mode=False):
        raise RuntimeError("down")


def make_agent(tmp_path, answers):
    cfg = Config(data_dir=tmp_path)
    cfg.ensure_dirs()
    db = Database(":memory:")
    store = MessageStore(":memory:")
    fake = FakeProvider(answers)
    return Agent(cfg, db, store, AI([fake])), fake


# ---------------- guard ----------------
def test_guard_blocks_writes_and_allows_reads():
    from telethon.tl import functions, types

    blocked = [
        functions.messages.SendMessageRequest(peer=types.InputPeerSelf(), message="x"),
        functions.messages.ReadHistoryRequest(peer=types.InputPeerSelf(), max_id=1),
        functions.messages.SetTypingRequest(peer=types.InputPeerSelf(), action=types.SendMessageTypingAction()),
        functions.messages.DeleteMessagesRequest(id=[1]),
        functions.messages.ForwardMessagesRequest(from_peer=types.InputPeerSelf(), id=[1], to_peer=types.InputPeerSelf()),
        functions.messages.SendReactionRequest(peer=types.InputPeerSelf(), msg_id=1),
        functions.account.UpdateStatusRequest(offline=False),
        functions.channels.JoinChannelRequest(channel=types.InputChannel(1, 1)),
        functions.contacts.ImportContactsRequest(contacts=[]),
    ]
    for r in blocked:
        assert not is_allowed(r), type(r).__name__
        with pytest.raises(WriteBlockedError):
            check_request(r)
    with pytest.raises(WriteBlockedError):
        check_request([functions.messages.GetDialogsRequest(None, 0, types.InputPeerEmpty(), 10, 0), blocked[0]])

    allowed = [
        functions.messages.GetHistoryRequest(types.InputPeerSelf(), 0, None, 0, 10, 0, 0, 0),
        functions.contacts.GetContactsRequest(hash=0),
        functions.updates.GetStateRequest(),
        functions.users.GetUsersRequest(id=[types.InputUserSelf()]),
        functions.auth.SendCodeRequest("+998", 1, "h", types.CodeSettings()),
        functions.upload.GetFileRequest(types.InputPhotoFileLocation(1, 1, b"", ""), 0, 1024),
    ]
    for r in allowed:
        check_request(r)


# ---------------- AI ----------------
def test_parse_json_variants():
    assert parse_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_json('Mana: {"a": [1,2]} tamom') == {"a": [1, 2]}


@pytest.mark.asyncio
async def test_ai_fallback():
    ai = AI([Broken(), FakeProvider(['{"ok": true}'])])
    assert await ai.json("s", "u") == {"ok": True}


# ---------------- contacts ----------------
def test_contact_matching():
    contacts = [
        {"tg_id": 1, "first_name": "Акмал", "last_name": "Каримов", "username": None, "is_contact": 1},
        {"tg_id": 2, "first_name": "Sardor", "last_name": None, "username": "sardor_dev", "is_contact": 1},
    ]
    assert normalize("Акмал") == "akmal"
    assert find_contact("Akmal", contacts)["tg_id"] == 1
    assert find_contact("Akmalga", contacts)["tg_id"] == 1
    assert find_contact("Sardor aka", contacts)["tg_id"] == 2
    assert find_contact("@sardor_dev", contacts)["tg_id"] == 2
    assert find_contact("Bobur", contacts) is None


# ---------------- reminders ----------------
def test_pick_offset():
    now = datetime(2026, 1, 1, 12, 0, tzinfo=from_db("2026-01-01T00:00:00Z").tzinfo)
    offs = [1440, 60, 15, 0]
    due = now + timedelta(minutes=50)
    assert pick_offset(due, offs, set(), now, True) == 60
    assert pick_offset(due, offs, {60}, now, True) is None
    assert pick_offset(due, offs, {1440}, now, True) == 60
    # kompyuter o'chiq turgan: faqat eng yaqin eslatma
    assert pick_offset(now - timedelta(minutes=5), offs, set(), now, True) == 0
    assert pick_offset(now + timedelta(days=3), offs, set(), now, True) is None
    # vaqtsiz vazifa: 60/15 daqiqalik eslatma yo'q
    assert pick_offset(now + timedelta(minutes=50), offs, set(), now, False) == 1440


# ---------------- store ----------------
def test_store_edits_and_deletes():
    s = MessageStore(":memory:")
    s.upsert_chat(5, "Ali", "user")
    s.upsert_chat(-1005, "Kanal", "supergroup")
    s.save_message(chat_id=5, msg_id=10, sender_name="Ali", out=False, date="2026-01-01T10:00:00Z", text="salom")
    s.save_message(chat_id=-1005, msg_id=10, is_channel=True, out=False, date="2026-01-01T10:00:00Z", text="kanal")
    s.record_edit(5, 10, "salom, qalaysan", None)
    assert s.q("SELECT text FROM messages WHERE chat_id=5")[0]["text"] == "salom, qalaysan"
    assert s.q("SELECT old_text FROM message_edits")[0]["old_text"] == "salom"
    # shaxsiy chatdagi o'chirish kanalga ta'sir qilmasligi kerak
    assert s.mark_deleted([10], None) == 1
    rows = {r["chat_id"]: r["deleted_at"] for r in s.q("SELECT chat_id, deleted_at FROM messages")}
    assert rows[5] and rows[-1005] is None
    # xabar o'chirilgandan keyin ham bazada qoladi
    assert s.recent(5)[0]["text"] == "salom, qalaysan"
    s.mark_deleted([10], -1005)
    assert all(r["deleted_at"] for r in s.q("SELECT deleted_at FROM messages"))
    assert "o'chirilgan" not in format_transcript(s.recent(5))


# ---------------- agent ----------------
@pytest.mark.asyncio
async def test_create_task_and_ask_due(tmp_path):
    agent, fake = make_agent(tmp_path, [
        {"intent": "create_tasks", "tasks": [
            {"title": "Hisobotni yuborish", "description": "Oylik hisobotni Akmalga yuborish.",
             "due_date": None, "due_time": None, "priority": "high", "assignee": "Akmalga", "people": []}]},
        {"is_answer": True, "due_date": (datetime.now(agent_tz()).date() + timedelta(days=1)).isoformat(),
         "due_time": "15:00", "no_deadline": False},
    ])
    agent.db.upsert_contact(77, "Akmal", "Karimov", None, None)
    replies = await agent.handle_text("Akmalga hisobotni yuborish kerak")
    t = agent.db.list_tasks("open")[0]
    assert t["assignee"] == "Akmal Karimov" and t["assignee_tg_id"] == 77
    assert t["priority"] == "high"
    assert any("qachon" in r.text.lower() for r in replies)
    assert agent.db.get_json("awaiting")["task_id"] == t["id"]

    replies = await agent.handle_text("ertaga soat 3 da")
    t = agent.db.get_task(t["id"])
    assert t["has_time"] and t["due_at"]
    loc = from_db(t["due_at"]).astimezone(agent.tz)
    assert loc.strftime("%H:%M") == "15:00"
    assert agent.db.get_json("awaiting") is None


def agent_tz():
    return Config().tz


@pytest.mark.asyncio
async def test_due_question_non_answer_falls_through(tmp_path):
    agent, fake = make_agent(tmp_path, [
        {"is_answer": False},
        {"intent": "smalltalk", "reply": "Salom!"},
    ])
    t = agent.db.add_task(title="X")
    agent.db.set_json("awaiting", {"task_id": t["id"], "need": "date"})
    replies = await agent.handle_text("salom")
    assert replies[0].text == "Salom!"
    assert agent.db.get_json("awaiting") is None


@pytest.mark.asyncio
async def test_quick_due_buttons(tmp_path):
    agent, _ = make_agent(tmp_path, [])
    t = agent.db.add_task(title="Qo'ng'iroq qilish")
    agent.db.set_json("awaiting", {"task_id": t["id"], "need": "date"})
    r = agent.quick_due(t["id"], "tomorrow")
    assert "Soat nechida" in r[0].text
    r = agent.quick_due(t["id"], "t1500")
    t = agent.db.get_task(t["id"])
    assert t["has_time"] and from_db(t["due_at"]).astimezone(agent.tz).hour == 15
    assert agent.db.get_json("awaiting") is None
    t2 = agent.db.add_task(title="Kitob o'qish")
    agent.quick_due(t2["id"], "none")
    assert agent.db.get_task(t2["id"])["no_deadline"]


@pytest.mark.asyncio
async def test_complete_and_list(tmp_path):
    agent, _ = make_agent(tmp_path, [{"intent": "complete_task", "task_id": "#1"}])
    agent.db.add_task(title="A", due_at=to_db(utcnow() - timedelta(hours=2)), has_time=1)
    assert "Muddati o'tgan" not in agent.list_tasks("today").text
    assert "#1" in agent.list_tasks("overdue").text
    r = await agent.handle_text("1-vazifa bajarildi")
    assert "Bajarildi" in r[0].text
    assert agent.db.get_task(1)["status"] == "done"
    assert agent.db.get_task(1)["completed_at"]


@pytest.mark.asyncio
async def test_reminders_flow(tmp_path):
    agent, _ = make_agent(tmp_path, [])
    t = agent.db.add_task(title="Uchrashuv", due_at=to_db(utcnow() + timedelta(minutes=30)), has_time=1)
    agent.prime_reminders(t)  # 1440 va 60 o'tib ketgan — yuborilmaydi
    assert agent.collect_reminders() == []
    agent.db.update_task(t["id"], due_at=to_db(utcnow() + timedelta(minutes=10)))
    agent.db.mark_reminders(t["id"], [1440, 60])
    r = agent.collect_reminders()
    assert len(r) == 1 and "daqiqadan keyin" in r[0].text
    assert agent.collect_reminders() == []
    agent.db.update_task(t["id"], snooze_until=to_db(utcnow() - timedelta(seconds=1)))
    assert len(agent.collect_reminders()) == 1


@pytest.mark.asyncio
async def test_voice_flow(tmp_path):
    agent, _ = make_agent(tmp_path, [
        {"intent": "create_tasks", "tasks": [{"title": "Hisobot yuborish", "description": "d",
                                              "due_date": "2030-01-02", "due_time": "10:00"}]}])
    replies = await agent.handle_voice(b"OggS", "audio/ogg")
    assert replies[0].text.startswith("🎙")
    assert agent.db.list_tasks("open")[0]["has_time"]


@pytest.mark.asyncio
async def test_chat_detection_creates_suggestions(tmp_path):
    agent, fake = make_agent(tmp_path, [
        {"tasks": [{"title": "Shartnomani yuborish", "description": "Ali shartnomani so'radi",
                    "due_date": None, "due_time": None}]}])
    s = agent.store
    s.upsert_chat(5, "Ali", "user")
    now = utcnow()
    s.save_message(chat_id=5, msg_id=1, out=True, date=to_db(now - timedelta(days=3)), text="eski")
    s.save_message(chat_id=5, msg_id=2, out=False, sender_name="Ali", date=to_db(now), text="Shartnomani yuborib yuboring")
    since = to_db(now - timedelta(hours=24))
    assert s.chats_with_new_incoming(["user"], {}, since) == [5]
    replies = await agent.detect_chat_tasks(5, since)
    assert len(replies) == 1 and "Qo'shish" in replies[0].buttons[0][0][0]
    prompt = fake.calls[0][1][0]
    assert prompt.index("eski") < prompt.index("--- YANGI ---") < prompt.index("Shartnomani yuborib")
    t = agent.db.list_tasks("suggested")[0]
    assert t["source_chat_title"] == "Ali"
    # takror tekshirilmaydi
    assert s.chats_with_new_incoming(["user"], {5: agent.db.scan_pos(5)}, since) == []
    agent.accept(t["id"])
    assert agent.db.get_task(t["id"])["status"] == "pending"


def test_web_api(tmp_path):
    from fastapi.testclient import TestClient
    from yordamchi.web.server import create_app

    agent, _ = make_agent(tmp_path, [])
    agent.cfg.web_token = "s3cret"
    c = TestClient(create_app(agent))
    assert c.get("/api/tasks").status_code == 401
    h = {"X-Token": "s3cret"}
    r = c.post("/api/tasks", json={"title": "Test", "due_date": "2030-05-01", "due_time": "10:30"}, headers=h)
    assert r.status_code == 200 and r.json()["due_time"] == "10:30"
    tid = r.json()["id"]
    assert c.patch(f"/api/tasks/{tid}", json={"status": "done"}, headers=h).json()["status"] == "done"
    assert len(c.get("/api/tasks?status=done", headers=h).json()) == 1
    assert c.get("/api/tasks?status=open", headers=h).json() == []
    assert c.get("/api/stats", headers=h).json()["done"] == 1
    assert c.get("/").status_code == 200
    assert c.delete(f"/api/tasks/{tid}", headers=h).json() == {"ok": True}
    # web da yozishmalar uchun hech qanday endpoint yo'q
    assert c.get("/api/messages", headers=h).status_code == 404


@pytest.mark.asyncio
async def test_userbot_client_cannot_send(tmp_path):
    from yordamchi.userbot import make_client

    cfg = Config(data_dir=tmp_path, api_id=1, api_hash="x")
    client = make_client(cfg)
    with pytest.raises(WriteBlockedError):
        await client.send_message("me", "salom")
    with pytest.raises(WriteBlockedError):
        await client.send_read_acknowledge("me")


@pytest.mark.asyncio
async def test_weather_parsing(monkeypatch):
    import httpx
    from yordamchi import weather

    payload = {
        "current": {"temperature_2m": 12.4, "apparent_temperature": 10.1, "weather_code": 3,
                    "wind_speed_10m": 8.2, "relative_humidity_2m": 60},
        "daily": {"time": ["2026-11-09", "2026-11-10"], "weather_code": [61, 0],
                  "temperature_2m_max": [14.2, 16.0], "temperature_2m_min": [-1.0, 3.0],
                  "precipitation_probability_max": [70, 5], "wind_speed_10m_max": [12, 9],
                  "sunrise": ["2026-11-09T06:58", "2026-11-10T06:59"], "sunset": ["2026-11-09T17:03", "2026-11-10T17:02"]},
    }
    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(
        lambda req: httpx.Response(200, json=payload)), **kw))
    weather._cache.clear()
    w = await weather.fetch(41.3, 69.2, "Asia/Tashkent")
    assert w["current"]["temp"] == 12 and w["days"][0]["text"] == "yengil yomg'ir"
    text = weather.format_brief("Toshkent", w)
    assert "Soyabon" in text and "issiq kiyining" in text and "Ertaga" in text
