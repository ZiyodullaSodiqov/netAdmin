"""
Telegram bildirishnomalari va haftalik hisobot.

Hodisalar navbatga tushadi, 8 sekund ichidagilari bitta xabarga yig'iladi
(masalan, bir nechta server birdan o'chsa — bitta xabar keladi).
"""

import json
import threading
import time
import urllib.error
import urllib.request

API = "https://api.telegram.org/bot%s/%s"

# Telegramga yuboriladigan hodisa turlari va ularning standart holati
EVENT_KINDS = [
    ("offline", "Server o'chdi / javob bermayapti", True),
    ("online", "Server yana ishladi", True),
    ("load", "Yuklama Og'ir / Kritik bo'ldi", True),
    ("disk", "Disk 90% dan oshdi", True),
    ("forecast", "Disk tez orada to'ladi (bashorat)", True),
    ("login_new", "Notanish IP dan serverga kirildi", True),
    ("login", "Har qanday kirish (tanish IP dan ham)", False),
    ("site_down", "Sayt ishlamay qoldi", True),
    ("site_up", "Sayt yana ishladi", True),
    ("ssl", "SSL sertifikat tugayapti", True),
]
COOLDOWN = {"load": 1800, "forecast": 86400}  # bir xil server uchun takroriy xabarlar orasidagi minimal vaqt
EMOJI = {"crit": "🔴", "warn": "🟠", "ok": "🟢", "info": "🔵"}
WEEKDAYS = ["Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba", "Yakshanba"]


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class Notifier:
    def __init__(self, db):
        self.db = db
        self.queue = []
        self.lock = threading.Lock()
        self.last_sent = {}
        self.last_error = ""
        self.sent_count = 0
        threading.Thread(target=self.run, daemon=True).start()

    # ---- settings
    def conf(self):
        s = self.db.settings()
        try:
            kinds = json.loads(s.get("tg_kinds") or "null")
        except ValueError:
            kinds = None
        if kinds is None:
            kinds = [k for k, _, on in EVENT_KINDS if on]
        return {
            "token": s.get("tg_token", ""), "chat": s.get("tg_chat", ""), "kinds": kinds,
            "weekly": s.get("tg_weekly", "1") == "1",
            "weekly_day": int(s.get("tg_weekly_day", "0") or 0), "weekly_hour": int(s.get("tg_weekly_hour", "9") or 9),
            "last_weekly": s.get("tg_last_weekly", ""),
        }

    def configured(self):
        c = self.conf()
        return bool(c["token"] and c["chat"])

    # ---- API
    def call(self, token, method, payload=None, timeout=15):
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(API % (token, method), data=data,
                                     headers={"Content-Type": "application/json"} if data else {})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read().decode())
                raise RuntimeError(body.get("description") or "HTTP %d" % e.code)
            except ValueError:
                raise RuntimeError("HTTP %d" % e.code)
        except urllib.error.URLError as e:
            raise RuntimeError("Telegramga ulanib bo'lmadi: %s" % e.reason)

    def send(self, text, token=None, chat=None):
        c = self.conf()
        token, chat = token or c["token"], chat or c["chat"]
        if not token or not chat:
            raise RuntimeError("Telegram token yoki chat ID kiritilmagan")
        for i in range(0, len(text), 3900):  # Telegram limiti 4096 belgi
            self.call(token, "sendMessage", {"chat_id": chat, "text": text[i:i + 3900], "parse_mode": "HTML",
                                             "disable_web_page_preview": True})
        self.sent_count += 1

    def find_chats(self, token):
        """Botga yozgan foydalanuvchilar/guruhlar ro'yxati (chat ID ni aniqlash uchun)."""
        res = self.call(token, "getUpdates", {"limit": 50, "timeout": 0})
        chats = {}
        for u in res.get("result", []):
            msg = u.get("message") or u.get("channel_post") or u.get("my_chat_member") or {}
            ch = msg.get("chat") or {}
            if ch.get("id") is not None:
                name = ch.get("title") or " ".join(x for x in (ch.get("first_name"), ch.get("last_name")) if x) or ch.get("username") or ""
                chats[ch["id"]] = {"id": ch["id"], "name": name, "type": ch.get("type", "")}
        return list(chats.values())

    # ---- events
    def on_event(self, server_id, level, kind, message, server_name=None):
        c = self.conf()
        if not (c["token"] and c["chat"]) or kind not in c["kinds"]:
            return
        key = (server_id, kind)
        cd = COOLDOWN.get(kind)
        now = time.time()
        if cd and level != "ok" and now - self.last_sent.get(key, 0) < cd:
            return
        self.last_sent[key] = now
        with self.lock:
            self.queue.append((now, level, message))

    def run(self):
        while True:
            time.sleep(2)
            try:
                self._flush()
            except Exception as e:
                self.last_error = str(e)
            try:
                self._weekly_tick()
            except Exception as e:
                self.last_error = "haftalik hisobot: %s" % e

    def _flush(self):
        with self.lock:
            if not self.queue or time.time() - self.queue[0][0] < 8:
                return
            items, self.queue = self.queue, []
        lines = ["%s %s" % (EMOJI.get(lv, "•"), esc(msg)) for _, lv, msg in items]
        head = "<b>NetAdmin Monitor</b>" + (" — %d ta hodisa" % len(items) if len(items) > 1 else "")
        try:
            self.send(head + "\n" + "\n".join(lines))
            self.last_error = ""
        except Exception as e:
            self.last_error = str(e)
            with self.lock:  # bir marta qayta urinamiz, keyin tashlab yuboramiz
                if len(items) < 50 and not getattr(self, "_retrying", False):
                    self._retrying = True
                    self.queue = items + self.queue
                else:
                    self._retrying = False

    # ---- weekly report
    def _weekly_tick(self):
        c = self.conf()
        if self.report_builder is None or not (c["weekly"] and c["token"] and c["chat"]):
            return
        lt = time.localtime()
        today = time.strftime("%Y-%m-%d", lt)
        if lt.tm_wday == c["weekly_day"] and lt.tm_hour >= c["weekly_hour"] and c["last_weekly"] != today:
            self.db.set_setting("tg_last_weekly", today)
            self.send(self.report_builder())

    report_builder = None  # server.py tomonidan o'rnatiladi
