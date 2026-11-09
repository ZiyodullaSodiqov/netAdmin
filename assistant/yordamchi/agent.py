"""AI agent: xabarlarni tushunadi, vazifalar yaratadi, savollarga javob beradi.

Telegram kutubxonasiga bog'liq emas — natijani `Reply` ro'yxati sifatida qaytaradi, bot uni yuboradi.
"""
from __future__ import annotations

import html
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Any

from .ai import prompts as P
from .ai.base import AI, AIError, Blob
from .config import Config
from .contacts import display_name, find_contact
from .db import Database, is_overdue
from .documents import extract_text, guess_mime
from .store import MessageStore, format_transcript
from .timeutil import (WEEKDAYS_UZ, MONTHS_UZ, build_due, combine_local, fmt_local, from_db,
                       local_day_bounds, now_context, parse_hhmm, to_db, utcnow)
from . import weather

log = logging.getLogger(__name__)

PRIORITY_ICON = {"high": "🔺", "low": "🔹", "normal": ""}


@dataclass
class Reply:
    text: str
    buttons: list[list[tuple[str, str]]] = field(default_factory=list)


def esc(s: Any) -> str:
    return html.escape(str(s or ""), quote=False)


def task_card(t: dict, tz, header: str = "📌") -> str:
    meta = [f"🗓 {fmt_local(t['due_at'], tz, t['has_time'])}" if t.get("due_at") else "🗓 muddatsiz"]
    if t.get("assignee"):
        meta.append(f"👤 {esc(t['assignee'])}")
    if t.get("priority") == "high":
        meta.append("🔺 muhim")
    if t.get("source_chat_title"):
        meta.append(f"💬 {esc(t['source_chat_title'])}")
    lines = [f"{header} <b>#{t['id']} {esc(t['title'])}</b>", " · ".join(meta)]
    if t.get("description"):
        lines.append(esc(t["description"]))
    if t.get("people"):
        lines.append("Aloqador: " + ", ".join(esc(p) for p in t["people"]))
    return "\n".join(lines)


def task_line(t: dict, tz) -> str:
    mark = "✅" if t["status"] == "done" else ("⚠️" if is_overdue(t) else "▫️")
    due = fmt_local(t["due_at"], tz, t["has_time"]) if t.get("due_at") else "muddatsiz"
    extra = f" · 👤 {esc(t['assignee'])}" if t.get("assignee") else ""
    pr = PRIORITY_ICON.get(t.get("priority") or "normal", "")
    return f"{mark} <b>#{t['id']}</b> {pr}{esc(t['title'])} — <i>{due}</i>{extra}"


def task_buttons(t: dict) -> list[list[tuple[str, str]]]:
    if t["status"] == "suggested":
        return [[("✅ Qo'shish", f"acc:{t['id']}"), ("❌ Kerak emas", f"rej:{t['id']}")]]
    if t["status"] == "done":
        return [[("↩️ Qayta ochish", f"undo:{t['id']}")]]
    return [[("✅ Bajarildi", f"done:{t['id']}"), ("🗑 O'chirish", f"del:{t['id']}")]]


def pick_offset(due: datetime, offsets: list[int], sent: set[int], now: datetime, has_time: bool) -> int | None:
    """Hozir yuborilishi kerak bo'lgan eslatma (daqiqada) yoki None.

    Bir nechta eslatma vaqti o'tib ketgan bo'lsa (masalan kompyuter o'chiq turgan), faqat eng
    yaqinini yuboradi.
    """
    allowed = [o for o in offsets if has_time or o in (0, 1440) or o >= 1440]
    passed = [o for o in allowed if due - timedelta(minutes=o) <= now]
    if not passed:
        return None
    latest = min(passed)
    if latest in sent or any(s <= latest for s in sent):
        return None
    return latest


def human_delta(delta: timedelta) -> str:
    mins = int(delta.total_seconds() // 60)
    if mins <= 0:
        return "hozir"
    if mins < 60:
        return f"{mins} daqiqadan keyin"
    hours, m = divmod(mins, 60)
    if hours < 24:
        return f"{hours} soat{f' {m} daqiqa' if m else ''}dan keyin"
    days = hours // 24
    return f"{days} kundan keyin"


class Agent:
    def __init__(self, cfg: Config, db: Database, store: MessageStore | None, ai: AI):
        self.cfg = cfg
        self.db = db
        self.store = store
        self.ai = ai
        self.tz = cfg.tz
        self.default_time = parse_hhmm(cfg.default_task_time, time(9, 0))

    # ================= vazifalar =================
    def prime_reminders(self, t: dict | None) -> None:
        """Vazifa yaratilganda/muddat o'zgarganda allaqachon o'tib ketgan eslatmalarni "yuborilgan" deb belgilaydi."""
        if not t or not t.get("due_at"):
            return
        due = from_db(t["due_at"])
        now = utcnow()
        passed = [o for o in self.cfg.reminder_offsets if o > 0 and due - timedelta(minutes=o) <= now]
        if passed:
            self.db.mark_reminders(t["id"], passed)

    def _resolve_person(self, name: str | None) -> tuple[str | None, int | None]:
        if not name:
            return None, None
        c = find_contact(name, self.db.contacts())
        if c:
            return display_name(c), c["tg_id"]
        return name.strip(), None

    def _task_fields(self, item: dict, base: dict | None = None) -> dict:
        f: dict[str, Any] = {}
        if item.get("title"):
            f["title"] = str(item["title"]).strip()[:200]
        if "description" in item and item["description"] is not None:
            f["description"] = str(item["description"]).strip()
        if item.get("priority") in ("low", "normal", "high"):
            f["priority"] = item["priority"]
        if "due_date" in item or "due_time" in item:
            d = item.get("due_date")
            if not d and item.get("due_time") and base and base.get("due_at"):
                d = from_db(base["due_at"]).astimezone(self.tz).date().isoformat()
            if not d and item.get("due_time"):
                d = datetime.now(self.tz).date().isoformat()
            due_at, has_time = build_due(d, item.get("due_time"), self.tz, self.default_time)
            if due_at or base is None:
                f["due_at"], f["has_time"] = due_at, int(has_time)
                if due_at:
                    f["no_deadline"] = 0
        if "assignee" in item:
            f["assignee"], f["assignee_tg_id"] = self._resolve_person(item.get("assignee"))
        if isinstance(item.get("people"), list):
            f["people"] = [str(p) for p in item["people"] if p][:10]
        return f

    def create_tasks(self, items: list[dict], source: str, status: str = "pending",
                     chat_id: int | None = None, chat_title: str | None = None) -> list[dict]:
        out = []
        for item in items or []:
            if not isinstance(item, dict) or not item.get("title"):
                continue
            f = self._task_fields(item)
            f.update(status=status, source=source, source_chat_id=chat_id, source_chat_title=chat_title)
            t = self.db.add_task(**f)
            self.prime_reminders(t)
            out.append(t)
        if out and status == "pending":
            self.db.set("last_task_id", str(out[-1]["id"]))
        return out

    def update_task(self, tid: int, **f: Any) -> dict | None:
        old = self.db.get_task(tid)
        t = self.db.update_task(tid, **f)
        if t and old and t["due_at"] != old["due_at"]:
            self.prime_reminders(t)
        return t

    # ---- muddatni so'rash ----
    def _needs_due(self, t: dict | None) -> str | None:
        if not t or t["status"] != "pending" or t["no_deadline"]:
            return None
        if not t["due_at"]:
            return "date"
        if not t["has_time"]:
            return "time"
        return None

    def queue_due_questions(self, tasks: list[dict]) -> list[Reply]:
        q = self.db.get_json("due_queue", [])
        q += [t["id"] for t in tasks if self._needs_due(t) and t["id"] not in q]
        self.db.set_json("due_queue", q)
        if self.db.get_json("awaiting"):
            return []
        return self._ask_next_due()

    def _ask_next_due(self) -> list[Reply]:
        q = self.db.get_json("due_queue", [])
        while q:
            tid = q.pop(0)
            t = self.db.get_task(tid)
            need = self._needs_due(t)
            if need:
                self.db.set_json("due_queue", q)
                self.db.set_json("awaiting", {"task_id": tid, "need": need})
                return [self._due_question(t, need)]  # type: ignore[arg-type]
        self.db.set_json("due_queue", [])
        self.db.set_json("awaiting", None)
        return []

    def _due_question(self, t: dict, need: str) -> Reply:
        if need == "date":
            return Reply(
                f"🗓 <b>#{t['id']} {esc(t['title'])}</b>\nBu vazifani qachon bajarish kerak? Kun va vaqtini yozing "
                f"yoki ovozli xabar yuboring (masalan: <i>ertaga soat 15:00</i>).",
                [[("Bugun", f"due:{t['id']}:today"), ("Ertaga", f"due:{t['id']}:tomorrow"),
                  ("Muddatsiz", f"due:{t['id']}:none")]])
        day = fmt_local(t["due_at"], self.tz, has_time=False)
        return Reply(
            f"⏰ <b>#{t['id']} {esc(t['title'])}</b> — {day}.\nSoat nechida? (masalan: <i>14:30</i>)",
            [[("09:00", f"due:{t['id']}:t0900"), ("12:00", f"due:{t['id']}:t1200"),
              ("15:00", f"due:{t['id']}:t1500"), ("18:00", f"due:{t['id']}:t1800")],
             [("Vaqtsiz (kun davomida)", f"due:{t['id']}:notime")]])

    def _finish_due(self, tid: int) -> None:
        aw = self.db.get_json("awaiting")
        if aw and aw.get("task_id") == tid:
            self.db.set_json("awaiting", None)

    def _after_due_set(self, t: dict) -> list[Reply]:
        need = self._needs_due(t)
        aw = self.db.get_json("awaiting")
        # kun aytildi, lekin soat aytilmadi — soatini ham so'raymiz
        if need == "time" and aw and aw.get("task_id") == t["id"] and aw.get("need") == "date":
            self.db.set_json("awaiting", {"task_id": t["id"], "need": "time"})
            return [self._due_question(t, "time")]
        self._finish_due(t["id"])
        done = Reply(f"✅ <b>#{t['id']} {esc(t['title'])}</b>: "
                     + ("muddatsiz" if t["no_deadline"] else fmt_local(t["due_at"], self.tz, t["has_time"])))
        return [done] + (self._ask_next_due() if not self.db.get_json("awaiting") else [])

    async def _try_due_answer(self, text: str, aw: dict) -> list[Reply] | None:
        t = self.db.get_task(int(aw.get("task_id") or 0))
        if not t or not self._needs_due(t):
            self.db.set_json("awaiting", None)
            return None
        cur = fmt_local(t["due_at"], self.tz, False) if t["due_at"] else "noma'lum"
        try:
            data = await self.ai.json(P.DUE_ANSWER_SYSTEM, (
                f"Hozir: {now_context(self.tz)}\nVazifa: {t['title']}\nJoriy sana: {cur}"
                f" ({from_db(t['due_at']).astimezone(self.tz).date() if t['due_at'] else '-'})\n"
                f"So'ralgan: {'kun va vaqt' if aw.get('need') == 'date' else 'vaqt'}\n\nEgasining javobi:\n{text}"))
        except AIError as e:
            log.warning("Muddat javobini tahlil qilib bo'lmadi: %s", e)
            return None
        if not data.get("is_answer"):
            self.db.set_json("awaiting", None)
            self.db.set_json("due_queue", [])
            return None
        if data.get("no_deadline"):
            t = self.update_task(t["id"], no_deadline=1)
            return self._after_due_set(t)  # type: ignore[arg-type]
        f = self._task_fields({"due_date": data.get("due_date"), "due_time": data.get("due_time")}, base=t)
        if not f.get("due_at"):
            return [Reply("Tushunmadim 🤔 Kun va vaqtni aniqroq yozing, masalan: <i>15-noyabr soat 10:00</i>.")]
        t = self.update_task(t["id"], **f)
        if t and not t["has_time"] and aw.get("need") == "time":
            # vaqt so'ralgan edi, lekin aytilmadi — boshqa so'ramaymiz
            self._finish_due(t["id"])
            return [Reply(f"✅ <b>#{t['id']}</b>: {fmt_local(t['due_at'], self.tz, False)}")] + self._ask_next_due()
        return self._after_due_set(t)  # type: ignore[arg-type]

    def quick_due(self, tid: int, code: str) -> list[Reply]:
        t = self.db.get_task(tid)
        if not t:
            return [Reply("Vazifa topilmadi.")]
        today = datetime.now(self.tz).date()
        if code in ("today", "tomorrow"):
            d = today if code == "today" else today + timedelta(days=1)
            self.db.set_json("awaiting", {"task_id": tid, "need": "date"})
            t = self.update_task(tid, due_at=to_db(combine_local(d, self.default_time, self.tz)),
                                 has_time=0, no_deadline=0)
        elif code == "none":
            t = self.update_task(tid, due_at=None, has_time=0, no_deadline=1)
        elif code == "notime":
            self._finish_due(tid)
            if not t["due_at"]:
                t = self.update_task(tid, due_at=to_db(combine_local(today, self.default_time, self.tz)))
            return [Reply(f"✅ <b>#{tid}</b>: {fmt_local(t['due_at'], self.tz, False)}")] + self._ask_next_due()  # type: ignore[index]
        elif re.fullmatch(r"t\d{4}", code):
            hhmm = time(int(code[1:3]), int(code[3:5]))
            d = from_db(t["due_at"]).astimezone(self.tz).date() if t["due_at"] else today
            t = self.update_task(tid, due_at=to_db(combine_local(d, hhmm, self.tz)), has_time=1, no_deadline=0)
        return self._after_due_set(t)  # type: ignore[arg-type]

    # ---- tugmalar ----
    def complete(self, tid: int) -> Reply:
        t = self.db.update_task(tid, status="done", snooze_until=None)
        if not t:
            return Reply("Vazifa topilmadi.")
        self._finish_due(tid)
        return Reply(f"✅ Bajarildi: <b>#{tid} {esc(t['title'])}</b>", task_buttons(t))

    def reopen(self, tid: int) -> Reply:
        t = self.db.update_task(tid, status="pending")
        return Reply(task_card(t, self.tz), task_buttons(t)) if t else Reply("Vazifa topilmadi.")

    def delete(self, tid: int) -> Reply:
        t = self.db.get_task(tid)
        self._finish_due(tid)
        if t and self.db.delete_task(tid):
            return Reply(f"🗑 O'chirildi: <s>#{tid} {esc(t['title'])}</s>")
        return Reply("Vazifa topilmadi.")

    def accept(self, tid: int) -> list[Reply]:
        t = self.db.update_task(tid, status="pending")
        if not t:
            return [Reply("Vazifa topilmadi.")]
        self.prime_reminders(t)
        self.db.set("last_task_id", str(tid))
        return [Reply(task_card(t, self.tz, "✅ Qo'shildi:"), task_buttons(t))] + self.queue_due_questions([t])

    def reject(self, tid: int) -> Reply:
        t = self.db.get_task(tid)
        if t:
            self.db.update_task(tid, status="cancelled")
        return Reply("👌 Qo'shilmadi.")

    def snooze(self, tid: int, minutes: int) -> Reply:
        t = self.db.snooze(tid, minutes)
        if not t:
            return Reply("Vazifa topilmadi.")
        when = from_db(t["snooze_until"]).astimezone(self.tz)
        return Reply(f"⏰ <b>#{tid}</b> {when:%H:%M} da yana eslataman.")

    def assign_contact(self, tg_id: int | None, first: str | None, last: str | None, phone: str | None) -> Reply:
        if tg_id:
            self.db.upsert_contact(tg_id, first, last, None, phone)
        name = " ".join(x for x in (first, last) if x) or phone or "kontakt"
        tid = int(self.db.get("last_task_id") or 0)
        t = self.db.get_task(tid) if tid else None
        if not t or t["status"] != "pending":
            return Reply(f"👤 {esc(name)} kontakti saqlandi.")
        t = self.db.update_task(tid, assignee=name, assignee_tg_id=tg_id)
        return Reply(f"👤 <b>#{tid} {esc(t['title'])}</b> → {esc(name)} ga biriktirildi.")  # type: ignore[index]

    # ================= ro'yxatlar =================
    def list_tasks(self, flt: str = "today") -> Reply:
        today = datetime.now(self.tz).date()
        titles = {"today": "📋 Bugungi vazifalar", "tomorrow": "📋 Ertangi vazifalar",
                  "week": "📋 Shu hafta (7 kun)", "overdue": "⚠️ Muddati o'tgan vazifalar",
                  "open": "📋 Bajarilmagan vazifalar", "done": "✅ Bajarilgan vazifalar",
                  "all": "📋 Barcha vazifalar"}
        flt = flt if flt in titles else "open"
        if flt == "today":
            s, e = local_day_bounds(today, self.tz)
            items = self.db.list_tasks("open", overdue=True) + self.db.list_tasks("open", s, e)
            seen: set[int] = set()
            items = [t for t in items if not (t["id"] in seen or seen.add(t["id"]))]
        elif flt == "tomorrow":
            items = self.db.list_tasks("open", *local_day_bounds(today + timedelta(days=1), self.tz))
        elif flt == "week":
            s, _ = local_day_bounds(today, self.tz)
            _, e = local_day_bounds(today + timedelta(days=6), self.tz)
            items = self.db.list_tasks("open", s, e)
        elif flt == "overdue":
            items = self.db.list_tasks("open", overdue=True)
        elif flt == "done":
            items = sorted(self.db.list_tasks("done"), key=lambda t: t.get("completed_at") or "", reverse=True)[:25]
        elif flt == "all":
            items = self.db.list_tasks(None, limit=60)
        else:
            items = self.db.list_tasks("open", limit=60)
        if not items:
            empty = {"today": "Bugunga vazifa yo'q 🎉", "overdue": "Muddati o'tgan vazifa yo'q 👍"}
            return Reply(f"{titles[flt]}\n\n{empty.get(flt, 'Hech narsa yo`q.')}")
        body = "\n".join(task_line(t, self.tz) for t in items[:60])
        return Reply(f"<b>{titles[flt]}</b> ({len(items)})\n\n{body}")

    # ================= asosiy kirish nuqtalari =================
    def _router_context(self, reply_text: str | None) -> str:
        open_tasks = self.db.list_tasks("open", limit=40)
        lines = [f"Hozir: {now_context(self.tz)}", "Ochiq vazifalar:"]
        for t in open_tasks:
            due = fmt_local(t["due_at"], self.tz, t["has_time"]) if t["due_at"] else "muddatsiz"
            lines.append(f"#{t['id']} | {t['title']} | {due} | {t.get('assignee') or ''}")
        if not open_tasks:
            lines.append("(yo'q)")
        if reply_text:
            lines.append(f"\nEgasi quyidagi bot xabariga javob yozmoqda:\n{reply_text[:1000]}")
        return "\n".join(lines)

    async def handle_text(self, text: str, source: str = "text", reply_text: str | None = None) -> list[Reply]:
        text = (text or "").strip()
        if not text:
            return []
        aw = self.db.get_json("awaiting")
        if aw:
            r = await self._try_due_answer(text, aw)
            if r is not None:
                return r
        data = await self.ai.json(P.ROUTER_SYSTEM, f"{self._router_context(reply_text)}\n\nEgasining xabari:\n{text}")
        if not isinstance(data, dict):
            data = {}
        intent = data.get("intent") or "smalltalk"
        tid = data.get("task_id")
        try:
            tid = int(str(tid).lstrip("#")) if tid not in (None, "") else None
        except ValueError:
            tid = None

        if intent == "create_tasks" and data.get("tasks"):
            tasks = self.create_tasks(data["tasks"], source)
            if not tasks:
                return [Reply("Vazifani tushunmadim, qaytadan yozing.")]
            replies = [Reply(task_card(t, self.tz, "🆕"), task_buttons(t)) for t in tasks]
            return replies + self.queue_due_questions(tasks)

        if intent in ("complete_task", "update_task", "delete_task"):
            if not tid or not self.db.get_task(tid):
                return [Reply("Qaysi vazifa ekanini topa olmadim. Vazifa raqamini yozing (masalan: <i>#12 bajarildi</i>).")]
            if intent == "complete_task":
                return [self.complete(tid)]
            if intent == "delete_task":
                return [self.delete(tid)]
            base = self.db.get_task(tid)
            f = self._task_fields(data.get("changes") or {}, base=base)
            t = self.update_task(tid, **f) if f else base
            return [Reply(task_card(t, self.tz, "✏️ Yangilandi:"), task_buttons(t))] + self.queue_due_questions([t])  # type: ignore[arg-type,list-item]

        if intent == "list_tasks":
            return [self.list_tasks(data.get("list_filter") or "today")]

        if intent == "question":
            return [Reply(esc(await self.answer(text, data.get("chat_query"))))]

        reply = data.get("reply") or "Tushundim 👍"
        return [Reply(esc(reply))]

    async def handle_voice(self, data: bytes, mime: str) -> list[Reply]:
        transcript = await self.ai.transcribe(data, mime or "audio/ogg", "voice.ogg")
        if not transcript:
            return [Reply("Ovozli xabarni tushunib bo'lmadi 😕")]
        return [Reply(f"🎙 <i>{esc(transcript)}</i>")] + await self.handle_text(transcript, source="voice")

    async def handle_document(self, data: bytes, filename: str, mime: str | None, caption: str = "") -> list[Reply]:
        mime = guess_mime(filename, mime)
        safe = re.sub(r"[^\w.\-]+", "_", filename)[-120:] or "file"
        path = self.cfg.docs_dir / f"{utcnow():%Y%m%d_%H%M%S}_{safe}"
        try:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_bytes(data)
        except OSError as e:
            log.warning("Hujjatni saqlab bo'lmadi: %s", e)
        text = extract_text(data, filename, mime)
        head = f"Hozir: {now_context(self.tz)}\nFayl: {filename}\nEgasining izohi: {caption or '-'}"
        if text:
            parts: list = [f"{head}\n\nHujjat matni:\n{text[:60000]}"]
        elif mime.startswith(("image/", "application/pdf")):
            parts = [head, Blob(data, mime, filename)]
        else:
            return [Reply(f"📎 {esc(filename)} saqlandi, lekin bu turdagi faylni o'qiy olmayman.")]
        res = await self.ai.json(P.DOCUMENT_SYSTEM, parts)
        if not isinstance(res, dict):
            res = {}
        summary = str(res.get("summary") or "").strip()
        self.db.add_document(filename, mime, str(path), summary, text or str(res.get("text") or ""))
        replies = [Reply(f"📄 <b>{esc(filename)}</b>\n{esc(summary) or 'Xulosa chiqmadi.'}")]
        tasks = self.create_tasks(res.get("tasks") or [], "document")
        replies += [Reply(task_card(t, self.tz, "🆕"), task_buttons(t)) for t in tasks]
        return replies + self.queue_due_questions(tasks)

    # ================= savol-javob =================
    def _find_chat_for(self, name: str) -> tuple[int, str] | None:
        c = find_contact(name, self.db.contacts(), threshold=0.75)
        if c:
            return int(c["tg_id"]), display_name(c)
        if self.store:
            rows = self.store.find_chats(name)
            if rows:
                return int(rows[0]["chat_id"]), rows[0]["title"] or name
        return None

    async def answer(self, question: str, chat_query: str | None = None) -> str:
        ctx = [f"Hozir: {now_context(self.tz)}", "\nOchiq vazifalar:"]
        for t in self.db.list_tasks("open", limit=50):
            due = fmt_local(t["due_at"], self.tz, t["has_time"]) if t["due_at"] else "muddatsiz"
            ctx.append(f"#{t['id']} {t['title']} | {due} | {t.get('assignee') or ''} | {t['description'][:200]}")
        done = sorted(self.db.list_tasks("done"), key=lambda t: t.get("completed_at") or "", reverse=True)[:10]
        if done:
            ctx.append("\nYaqinda bajarilganlar:")
            ctx += [f"#{t['id']} {t['title']}" for t in done]
        docs = self.db.recent_documents(5)
        if docs:
            ctx.append("\nOxirgi hujjatlar:")
            ctx += [f"- {d['file_name']}: {(d['summary'] or '')[:400]}" for d in docs]
        if chat_query and self.store:
            found = self._find_chat_for(chat_query)
            if found:
                chat_id, title = found
                summ = self.db.chat_summary(chat_id)
                rows = self.store.recent(chat_id, 200)
                ctx.append(f"\n{title} bilan yozishma:")
                if summ:
                    ctx.append(f"(oldingi xulosa: {summ['summary']})")
                ctx.append(format_transcript(rows) or "(xabar yo'q)")
            else:
                ctx.append(f"\n'{chat_query}' nomli chat topilmadi.")
        return await self.ai.text(P.ANSWER_SYSTEM, "\n".join(ctx) + f"\n\nSavol: {question}")

    # ================= chatlar =================
    def list_chats(self, limit: int = 15) -> Reply:
        if not self.store:
            return Reply("Userbot o'chirilgan — chatlar haqida ma'lumot yo'q.")
        kinds = ["user", "group", "supergroup"] + (["channel"] if self.cfg.chat_scan_groups else [])
        rows = self.store.chats_by_activity(kinds, limit)
        if not rows:
            return Reply("Hozircha chatlar haqida ma'lumot yo'q.")
        lines, buttons = ["💬 <b>Oxirgi faol chatlar</b>\n"], []
        for i, r in enumerate(rows, 1):
            s = self.db.chat_summary(r["chat_id"])
            snippet = f"\n   <i>{esc((s['summary'] or '')[:160])}…</i>" if s and s.get("summary") else ""
            lines.append(f"{i}. {esc(r['title'] or r['chat_id'])}{snippet}")
            buttons.append((f"{i}. {(r['title'] or str(r['chat_id']))[:18]}", f"chat:{r['chat_id']}"))
        rows_btn = [buttons[i:i + 2] for i in range(0, len(buttons), 2)]
        return Reply("\n".join(lines) + "\n\nXulosa olish uchun chatni tanlang:", rows_btn)

    async def summarize_chat(self, chat_id: int) -> Reply:
        if not self.store:
            return Reply("Userbot o'chirilgan.")
        chat = self.store.chat(chat_id) or {}
        title = chat.get("title") or str(chat_id)
        rows = self.store.recent(chat_id, 300)
        if not rows:
            return Reply(f"{esc(title)}: ma'lumot yo'q.")
        summary = await self.ai.text(P.CHAT_SUMMARY_SYSTEM, f"Chat: {title}\n\n{format_transcript(rows)}")
        self.db.save_chat_summary(chat_id, title, summary, rows[-1]["msg_id"])
        return Reply(f"💬 <b>{esc(title)}</b>\n{esc(summary)}")

    async def detect_chat_tasks(self, chat_id: int, since: str) -> list[Reply]:
        """Chatdagi yangi xabarlardan egasiga tegishli vazifalarni topadi (taklif sifatida)."""
        if not self.store:
            return []
        pos = self.db.scan_pos(chat_id)
        rows = self.store.recent(chat_id, 60)
        if not rows:
            return []
        new = [r for r in rows if r["msg_id"] > pos and (r.get("date") or "") >= since]
        self.db.set_scan_pos(chat_id, rows[-1]["msg_id"])
        if not any(not r["out"] for r in new):
            return []
        old = [r for r in rows if r not in new]
        chat = self.store.chat(chat_id) or {}
        title = chat.get("title") or str(chat_id)
        existing = "\n".join(f"- {t['title']}" for t in self.db.list_tasks("open", limit=60)) or "(yo'q)"
        prompt = (f"Hozir: {now_context(self.tz)}\nSuhbatdosh: {title}\nMavjud vazifalar:\n{existing}\n\n"
                  f"{format_transcript(old)}\n--- YANGI ---\n{format_transcript(new)}")
        res = await self.ai.json(P.CHAT_DETECT_SYSTEM, prompt)
        items = res.get("tasks") if isinstance(res, dict) else res
        tasks = self.create_tasks(items or [], "chat", status="suggested", chat_id=chat_id, chat_title=title)
        return [Reply(task_card(t, self.tz, "💡 Yangi vazifa topildi:"), task_buttons(t)) for t in tasks]

    # ================= eslatmalar va kunlik xabar =================
    def collect_reminders(self) -> list[Reply]:
        now = utcnow()
        out = []
        for t in self.db.list_tasks("open"):
            snz = from_db(t.get("snooze_until"))
            if snz and snz <= now:
                self.db.update_task(t["id"], snooze_until=None)
                out.append(self._reminder(t, now))
                continue
            if snz or not t["due_at"]:
                continue
            due = from_db(t["due_at"])
            off = pick_offset(due, self.cfg.reminder_offsets, self.db.reminders_sent(t["id"]), now, t["has_time"])
            if off is None:
                continue
            self.db.mark_reminders(t["id"], [o for o in self.cfg.reminder_offsets if o >= off])
            out.append(self._reminder(t, now))
        return out

    def _reminder(self, t: dict, now: datetime) -> Reply:
        due = from_db(t["due_at"])
        if due is None:
            head = "🔔 Eslatma"
        elif due <= now + timedelta(minutes=1):
            head = "⏰ Vaqti keldi" if now - due < timedelta(hours=1) else "⚠️ Muddati o'tdi"
        else:
            head = f"🔔 {human_delta(due - now).capitalize()}"
        return Reply(task_card(t, self.tz, head), [
            [("✅ Bajarildi", f"done:{t['id']}"), ("⏰ 15 daq", f"snz:{t['id']}:15"), ("⏰ 1 soat", f"snz:{t['id']}:60")],
            [("🌙 Ertaga", f"snz:{t['id']}:1440")]])

    async def daily_brief(self) -> Reply:
        now = datetime.now(self.tz)
        parts = [f"☀️ <b>Xayrli tong!</b> Bugun {now.day}-{MONTHS_UZ[now.month - 1]}, {WEEKDAYS_UZ[now.weekday()].lower()}"]
        try:
            w = await weather.fetch(self.cfg.weather_lat, self.cfg.weather_lon, self.cfg.timezone)
            parts.append(weather.format_brief(self.cfg.weather_city, w))
        except Exception as e:  # noqa: BLE001
            log.warning("Ob-havo olinmadi: %s", e)
            parts.append("🌡 Ob-havo ma'lumotini olib bo'lmadi.")
        s, e = local_day_bounds(now.date(), self.tz)
        today = self.db.list_tasks("open", s, e)
        overdue = self.db.list_tasks("open", overdue=True)
        overdue = [t for t in overdue if t["due_at"] < s]
        nodue = [t for t in self.db.list_tasks("open") if not t["due_at"]]
        if today:
            parts.append(f"📋 <b>Bugungi vazifalar ({len(today)}):</b>\n" + "\n".join(task_line(t, self.tz) for t in today))
        else:
            parts.append("📋 Bugunga rejalashtirilgan vazifa yo'q.")
        if overdue:
            parts.append(f"⚠️ <b>Muddati o'tgan ({len(overdue)}):</b>\n" + "\n".join(task_line(t, self.tz) for t in overdue[:15]))
        if nodue:
            parts.append(f"📭 Muddatsiz vazifalar: {len(nodue)} ta (/open)")
        sugg = self.db.list_tasks("suggested")
        if sugg:
            parts.append(f"💡 Ko'rib chiqilmagan takliflar: {len(sugg)} ta")
        return Reply("\n\n".join(parts))
