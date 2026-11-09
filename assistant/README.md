# 🤖 Yordamchi — Telegram uchun shaxsiy AI agent

Kompyuteringizda (lokal) ishlaydigan shaxsiy yordamchi. Telegram bot doimiy ishlab turadi, AI sifatida
**Gemini** va **OpenAI** ishlatiladi (biri ishlamasa avtomatik ikkinchisiga o'tadi).

## Nima qila oladi

| | |
|---|---|
| 🎙 **Ovozli xabarlar** | Botga ovozli xabar yuborasiz → matnga aylantiradi → vazifalarni ajratib, tushunarli va kengaytirilgan tavsif bilan saqlaydi |
| 📌 **Vazifalar** | Matn yoki ovozdan bir nechta vazifani ajratadi, sana/vaqt, muhimlik va **kimga tegishli**ligini aniqlaydi |
| 🗓 **Muddatni so'rash** | Vazifaning kuni yoki soati aytilmagan bo'lsa — so'raydi (tugmalar yoki erkin javob: *"ertaga soat 3 da"*) |
| 🔔 **Eslatmalar** | 1 kun, 1 soat, 15 daqiqa oldin va vaqti kelganda eslatadi (sozlanadi). "15 daq / 1 soat / ertaga" kechiktirish tugmalari |
| 👥 **Kontaktlar** | Telegram kontaktlaringizni o'qiydi: *"Akmalga hisobotni yuborish"* → vazifa Akmal Karimovga biriktiriladi (lotin/kirill, qo'shimchalar farqi yo'q) |
| 💬 **Chatlarni tushunish** | Barcha chatlarni o'qiydi, chat nima haqida ekanini biladi (`/chats`), shaxsiy chatlarda sizga berilgan topshiriqlarni topib, botda taklif qiladi |
| 📄 **Hujjatlar** | PDF, DOCX, XLSX, TXT, rasm — o'qiydi, xulosa qiladi, ichidagi vazifalarni (to'lov, imzolash, muddat) ajratadi |
| ❓ **Savol-javob** | *"Bugun nima ishlarim bor?"*, *"Sardor bilan nima haqida gaplashgandik?"*, *"#5 bajarildi"* |
| ☀️ **Ertalabki xabar** | Har kuni 08:00 da: ob-havo + bugungi vazifalar + muddati o'tganlar |
| 🌐 **Web sahifa** | `http://localhost:8080` — barcha, bajarilgan, bajarilmagan, muddati o'tgan vazifalar, ob-havo; qo'shish/tahrirlash |

### 🔒 Hech qayerga yozmaydi

- **Userbot** (sizning akkauntingiz) **faqat o'qish** rejimida: har bir Telegram (MTProto) so'rovi oq ro'yxat orqali
  tekshiriladi (`yordamchi/guard.py`). Xabar yuborish, tahrirlash, o'chirish, forward, reaksiya, "o'qildi" belgisi,
  "yozmoqda..." holati, guruh/kanalga qo'shilish — kod darajasida **bloklangan**. Shuning uchun chatlardagi xabarlar
  sizning nomingizdan "o'qilgan" bo'lib qolmaydi.
- **Bot** faqat sizga (`OWNER_ID`) yozadi — boshqa har qanday chatga yuborish urinishi bloklanadi, begonalarning
  xabarlariga javob bermaydi.

## O'rnatish

### 1. Kerakli kalitlar

1. **Bot token** — Telegramda [@BotFather](https://t.me/BotFather) → `/newbot`.
2. **API ID / API HASH** — <https://my.telegram.org> → *API development tools* (userbot uchun).
3. **AI kaliti** — kamida bittasi:
   - Gemini: <https://aistudio.google.com/apikey>
   - OpenAI: <https://platform.openai.com/api-keys>

### 2. O'rnatish va sozlash

Python 3.10+ kerak.

```bash
cd assistant
python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                 # Windows: copy .env.example .env
```

`.env` faylini to'ldiring (izohlar ichida).

### 3. Telegram akkauntga kirish (bir marta)

```bash
python -m yordamchi login
```

Telefon raqam va Telegram yuborgan kodni kiritasiz (2 bosqichli parol bo'lsa — uni ham). Oxirida sizning
**Telegram ID** raqamingiz chiqadi — uni `.env` dagi `OWNER_ID` ga yozing.
Sessiya `data/userbot.session` fayliga saqlanadi — **uni hech kimga bermang**, u akkauntingizga kirish kaliti.

### 4. Tekshirish va ishga tushirish

```bash
python -m yordamchi check
```

```bash
python -m yordamchi
```

Botga `/start` yozing. Web sahifa: <http://localhost:8080>

## Doimiy ishlashi uchun

- **Windows**: `start.bat` ni ishga tushiring (yiqilsa o'zi qayta ishga tushadi). Kompyuter yoqilganda avtomatik
  ishga tushishi uchun `start.bat` yorlig'ini `shell:startup` papkasiga qo'ying.
- **Linux (systemd)**: `yordamchi.service` faylidagi izohlarga qarang.
- **Docker**: avval lokal `python -m yordamchi login` qiling (sessiya `data/` ga yoziladi), keyin:

  ```bash
  docker compose up -d --build
  ```

Kompyuter o'chiq bo'lgan paytdagi xabarlar keyingi ishga tushishda va har kuni `DAILY_SYNC_TIME` da qayta
sinxronlanadi; o'tib ketgan eslatmalardan faqat eng oxirgisi yuboriladi (spam bo'lmaydi), ertalabki xabar
kompyuter kechroq yoqilsa ham soat 13:00 gacha yuboriladi.

## Bot buyruqlari

| Buyruq | |
|---|---|
| `/today` | bugungi va muddati o'tgan vazifalar |
| `/tomorrow`, `/week` | ertangi / 7 kunlik |
| `/open`, `/done`, `/overdue` | bajarilmagan / bajarilgan / muddati o'tgan |
| `/suggested` | chatlardan topilgan takliflar |
| `/chats` | oxirgi faol chatlar va ularning xulosasi |
| `/weather`, `/brief` | ob-havo / kunlik xabar |
| `/web` | web sahifa manzili |

Oddiy matn, ovozli xabar, hujjat, rasm yoki kontakt yuborish mumkin. Bot xabariga *reply* qilib yozsangiz
(masalan, *"buni juma kuniga ko'chir"*), u qaysi vazifa haqida gapirayotganingizni tushunadi.

## Ma'lumotlar

Hammasi `data/` papkasida, kompyuteringizda saqlanadi:

| Fayl | |
|---|---|
| `data/assistant.db` | vazifalar, kontaktlar, hujjat xulosalari, chat xulosalari |
| `data/archive.db` | yozishmalar bazasi (bot va web sahifada ko'rsatilmaydi) |
| `data/documents/` | botga yuborilgan hujjatlar |
| `data/media/` | `STORE_MEDIA=true` bo'lsa — chatlardagi fayllar |
| `data/userbot.session` | Telegram sessiyasi |

SQLite fayllarini [DB Browser for SQLite](https://sqlitebrowser.org/) yoki `sqlite3` bilan ochish mumkin.
`archive.db` jadvallari: `chats`, `messages` (`deleted_at`, `edited_at` ustunlari bilan), `message_edits`
(tahrirdan oldingi matn).

```sql
SELECT c.title, m.date, m.sender_name, m.text
FROM messages m JOIN chats c USING(chat_id)
WHERE m.deleted_at IS NOT NULL
ORDER BY m.date DESC;
```

## Tuzilishi

```
yordamchi/
  __main__.py      ishga tushirish (run | login | check)
  config.py        sozlamalar (.env)
  agent.py         AI agent: vazifalar, muddat so'rash, savol-javob, eslatmalar, ertalabki xabar
  ai/              Gemini va OpenAI provayderlari, zaxira mexanizmi, promptlar
  bot.py           Telegram bot (aiogram) — faqat egasi bilan
  userbot.py       Telegram userbot (Telethon) — faqat o'qish
  guard.py         userbot uchun yozish amallarini bloklash
  scheduler.py     eslatmalar, 08:00 xabari, sinxronlash, chatlardan vazifa topish
  db.py, store.py  SQLite bazalar
  contacts.py      ism bo'yicha kontakt topish (lotin/kirill)
  documents.py     PDF/DOCX/XLSX dan matn olish
  weather.py       Open-Meteo (API kalitsiz)
  web/             FastAPI + web sahifa
tests/             pytest
```

Testlar:

```bash
pip install -r requirements-dev.txt
pytest
```

## Eslatma

Userbot Telegramning rasmiy API'si (o'z API ID ingiz) orqali ishlaydi va hech narsa yozmaydi, shuning uchun xavf
past. Baribir sessiya faylini va `.env` ni maxfiy saqlang; ular `.gitignore` da.
