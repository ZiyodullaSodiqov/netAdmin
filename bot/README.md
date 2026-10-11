# Xizmatlar boti (Telegram)

Slayd, mustaqil ish, referat, maqola, testlar, sertifikat/diplom/tashakkurnoma/faxriy yorliq, daftar usti,
3x4 rasm, Word↔PDF, rasm→Word va rasmdagi misolni yechish xizmatlarini ko'rsatadigan Telegram bot.

## Qanday ishlaydi

1. **Majburiy obuna** — web paneldagi (yoki `.env` dagi `REQUIRED_CHANNELS`) kanallarga obuna bo'lmaguncha
   bot ishlamaydi (bot kanalda admin bo'lishi kerak).
2. Mijoz xizmatni tanlaydi. Rus tili bor xizmatlarda (sertifikat, diplom, tashakkurnoma, faxriy yorliq,
   daftar usti, slayd, referat...) **o'zbek yoki rus tilida** ekanini so'raydi; testlar — uz/en/ru.
3. Bot ishni bajaradi va **avval namunasini ko'rsatadi**: suv belgili ("NAMUNA"), kichraytirilgan, 2-3-sahifalarning
   pastki qismi xiralashtirilgan rasm, `protect_content=True` bilan — Telegram saqlash, forward qilish va
   mobil ilovalarda skrinshot olishni bloklaydi. Asl fayl ko'rsatilmaydi.
4. Yoqsa — «Sotib olaman» (yoqmasa 2 marta qayta yaratish mumkin). Qog'ozda chiqarish bor xizmatlarda
   «qog'ozda chiqarilsinmi?» deb so'raydi va telefon raqamini oladi.
5. Karta raqami va aniq summa ko'rsatiladi. Mijoz to'lab, **chekni** (skrinshot / PDF / matn) yuboradi.
6. **Avtomatik tekshiruv** (`app/payments/verifier.py`):
   - OpenAI chekdan **ID, summa, vaqt, holat, qabul qiluvchi karta**ni o'qiydi;
   - chek ID avval ishlatilmagan bo'lishi, summa yetarli, vaqt buyurtmadan keyin, karta — sizniki bo'lishi shart;
   - **userbot** karta xabarlari botidan (`NOTIFY_BOT_USERNAME`) kelgan kirimlar orasidan xuddi shu summa va
     ±`PAYMENT_TIME_TOLERANCE_MIN` daqiqadagi, hali ishlatilmagan kirimni topadi (xabar kechiksa
     `PAYMENT_WAIT_SEC` kutadi);
   - hammasi mos — to'lov qabul qilinadi va asl fayl darhol yuboriladi. Bitta chek ham, bitta karta kirimi ham
     faqat bir marta ishlatiladi.
   - Shubhali holatda (kirim topilmadi, chek o'qilmadi, tahrirlangan ko'rinadi) chek adminga
     «✅ Tasdiqlash / ❌ Rad etish» tugmalari bilan boradi.
7. Asl fayl(lar) mijozga **zip arxiv** ko'rinishida yuboriladi (`DELIVER_ZIP=0` — har fayl alohida).
8. Qog'ozda chiqarish buyurtmasi bo'lsa, fayl va mijoz telefoni adminlarga yuboriladi.

### Nega userbot kerak?
Telegram'da oddiy bot boshqa botning xabarlarini o'qiy olmaydi. Shuning uchun karta xabarlari
(masalan @CardXabarBot) sizning akkauntingizga keladi va kichik **userbot** (Telethon) faqat o'sha botdan
kelgan xabarlarni o'qib bazaga yozadi. Userbot sozlanmasa, barcha cheklar admin tomonidan qo'lda tasdiqlanadi.

## Xizmatlar va narxlar (`app/services.py`)

| Xizmat | Narx | Qog'ozda | AI |
|---|---|---|---|
| Slayd (10 varoq) | 10 000 | +5 000 | OpenAI |
| Mustaqil ish (10 varoq) | 10 000 | +3 000 | OpenAI |
| Referat (10 varoq) | 10 000 | +3 000 | OpenAI |
| Maqola (7 varoq) | 10 000 | +3 000 | OpenAI |
| Word → PDF / PDF → Word | 2 000 / 5 000 | — | LibreOffice / pdf2docx |
| Rasm → Word / (fix) | 5 000 / 5 000 har list | — | OpenAI |
| Sertifikat, Diplom, Tashakkurnoma, Faxriy/maqtov yorlig'i | 3 000 | +5 000 | OpenAI (dizayn) |
| Daftar usti | 3 000 | +500 | OpenAI (dizayn) |
| 3x4 rasm (10x15 listda 9 dona, 4K) | 5 000 (+kiyim `PRICE_PHOTO_CLOTHES`) | +5 000 | OpenAI (kiyim) |
| Misol yechish (rasmdan) | 1-si bepul, 10 tasi 3 000 | — | OpenAI |
| Testlar (uz/en/ru, fan, mavzu, sinf, variantlar) | `PRICE_TESTS` (5 000) | — | OpenAI |

Hajmi ko'proq tanlansa (masalan 15 yoki 20 varoq) narx mutanosib oshadi.

Barcha AI ishlari faqat **OpenAI** orqali: matn — `OPENAI_MODEL`, rasmni o'qish — `OPENAI_VISION_MODEL`,
rasm yaratish/tahrirlash — `OPENAI_IMAGE_MODEL` (gpt-image-1).

Dizayn hujjatlarida OpenAI matnni tuzadi va ranglarni tanlaydi, `OPENAI_IMAGE_MODEL` matnsiz bezakli fon chizadi,
yozuvlar esa Pillow bilan aniq joylanadi (kirill/lotin harflari buzilmasligi uchun). Fon chizilmasa — oddiy ramkali
fon ishlatiladi.

## O'rnatish

```bash
cd bot
cp .env.example .env        # qiymatlarni to'ldiring
pip install -r requirements.txt
# Userbot uchun session satri (bir marta, telefon raqam va kodni so'raydi):
python -m app.payments.login     # chiqqan TG_SESSION_STRING ni .env ga qo'ying
python main.py
```

LibreOffice (`soffice`) kerak: Word→PDF va slayd/hujjat namunalarini rasmga aylantirish uchun.
Docker bilan hammasi tayyor:

```bash
docker build -t xizmat-bot .
docker run -d --env-file .env -v $(pwd)/data:/app/data xizmat-bot
```

### 3x4 rasm
Rasm 3:4 ga kesiladi, keskinlik va kontrast yaxshilanadi, **600 dpi** da (10x15 list = 2362x3543 px, ~4K)
tayyorlanadi. Mijozdan «kostyum yoki kofta kiydirilsinmi?» deb so'raladi: erkaklar kostyumi, ayollar kostyumi,
kofta, oq ko'ylak yoki o'zgartirmasdan. Kiyim tanlansa OpenAI rasmni tahrirlaydi (yuz o'zgarmaydi, fon oq bo'ladi).
Mijozga 10x15 list va alohida bitta 3x4 rasm yuboriladi.

## Web admin panel
Bot bilan birga ishga tushadi. `.env` da `WEB_ADMIN_PASSWORD` (kamida 8 belgi) yozing va brauzerda oching:
`http://localhost:8080` (serverda — `http://SERVER_IP:8080`). Port — `WEB_PORT`.

- **📊 Statistika** — jami/yangi/faol foydalanuvchilar, urinishlar (necha kishi, necha marta), to'lovlar, tushum,
  oxirgi 14 kun (bugun / 7 kun / 30 kun / hammasi);
- **🔁 Urinishlar** — har xizmat bo'yicha: necha kishi kirgan va necha marta, necha kishi necha marta yaratgan,
  xatolar, rad etilgan cheklar, necha kishi to'lagan, konversiya;
- **👥 Foydalanuvchilar** — qidiruv, har bir odamning urinishlari, buyurtmalari, xabarlari; unga xabar yuborish;
- **🧾 Buyurtmalar** — to'lov kutilayotganlarni tasdiqlash / rad etish, chop etish uchun telefon raqami;
- **💳 Karta kirimlari** — userbot ko'rgan tushumlar;
- **💡 Takliflar** va **📞 Murojaatlar** — foydalanuvchilar yozganlari, shu yerdan javob berish (javob botga boradi);
- **📢 Majburiy obuna** — kanallarni qo'shish/o'chirish, bot kanalda admin ekanini tekshirish;
- **📣 Xabar yuborish** — barcha foydalanuvchilarga.

Xavfsizlik: parol bilan kirish, 5 ta noto'g'ri urinishdan keyin 10 daqiqa blok, imzolangan cookie, CSRF himoya.
Internetga ochiq serverda panelni **HTTPS** orqali (masalan, nginx + Let's Encrypt yoki Cloudflare Tunnel)
oching va kuchli parol qo'ying.

Telegram ichida ham qisqa panel bor: `/admin`.

## Takliflar va admin bilan bog'lanish
Bot menyusida **💡 Taklif yuborish** va **📞 Admin bilan bog'lanish** tugmalari bor. Xabar bazaga yoziladi va
adminlarga Telegram'da `#M12` raqami bilan keladi. Admin javobni web paneldan yoki Telegram'da shu xabarga
**Reply** qilib yozadi — javob foydalanuvchiga bot orqali yetib boradi. `ADMIN_CONTACT=@username` yozilsa,
to'g'ridan-to'g'ri yozish uchun username ham ko'rsatiladi.

## Admin buyruqlari
- `/admin` — admin panel
- `/user <id>` — foydalanuvchi haqida batafsil
- `/confirm <id>` — buyurtmani qo'lda to'langan deb belgilash va faylni yuborish

## Testlar
```bash
pip install -r requirements-dev.txt
pytest
```
