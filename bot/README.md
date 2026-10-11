# Xizmatlar boti (Telegram)

Slayd, mustaqil ish, referat, maqola, testlar, sertifikat/diplom/tashakkurnoma/faxriy yorliq, daftar usti,
3x4 rasm, Word↔PDF, rasm→Word va rasmdagi misolni yechish xizmatlarini ko'rsatadigan Telegram bot.

## Qanday ishlaydi

1. **Majburiy obuna** — `REQUIRED_CHANNELS` dagi kanallarga obuna bo'lmaguncha bot ishlamaydi
   (bot kanalda admin bo'lishi kerak).
2. Mijoz xizmatni tanlaydi. Rus tili bor xizmatlarda (sertifikat, diplom, tashakkurnoma, faxriy yorliq,
   daftar usti, slayd, referat...) **o'zbek yoki rus tilida** ekanini so'raydi; testlar — uz/en/ru.
3. Bot ishni bajaradi va **avval namunasini ko'rsatadi**: suv belgili ("NAMUNA"), kichraytirilgan, 2-3-sahifalarning
   pastki qismi xiralashtirilgan rasm, `protect_content=True` bilan — Telegram saqlash, forward qilish va
   mobil ilovalarda skrinshot olishni bloklaydi. Asl fayl ko'rsatilmaydi.
4. Yoqsa — «Sotib olaman» (yoqmasa 2 marta qayta yaratish mumkin). Qog'ozda chiqarish bor xizmatlarda
   «qog'ozda chiqarilsinmi?» deb so'raydi va telefon raqamini oladi.
5. Karta raqami va aniq summa ko'rsatiladi. Mijoz to'lab, **chekni** (skrinshot / PDF / matn) yuboradi.
6. **Avtomatik tekshiruv** (`app/payments/verifier.py`):
   - Gemini chekdan **ID, summa, vaqt, holat, qabul qiluvchi karta**ni o'qiydi;
   - chek ID avval ishlatilmagan bo'lishi, summa yetarli, vaqt buyurtmadan keyin, karta — sizniki bo'lishi shart;
   - **userbot** karta xabarlari botidan (`NOTIFY_BOT_USERNAME`) kelgan kirimlar orasidan xuddi shu summa va
     ±`PAYMENT_TIME_TOLERANCE_MIN` daqiqadagi, hali ishlatilmagan kirimni topadi (xabar kechiksa
     `PAYMENT_WAIT_SEC` kutadi);
   - hammasi mos — to'lov qabul qilinadi va asl fayl darhol yuboriladi. Bitta chek ham, bitta karta kirimi ham
     faqat bir marta ishlatiladi.
   - Shubhali holatda (kirim topilmadi, chek o'qilmadi, tahrirlangan ko'rinadi) chek adminga
     «✅ Tasdiqlash / ❌ Rad etish» tugmalari bilan boradi.
7. Qog'ozda chiqarish buyurtmasi bo'lsa, fayl va mijoz telefoni adminlarga yuboriladi.

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
| Rasm → Word / (fix) | 5 000 / 5 000 har list | — | Gemini |
| Sertifikat, Diplom, Tashakkurnoma, Faxriy/maqtov yorlig'i | 3 000 | +5 000 | Gemini (dizayn) |
| Daftar usti | 3 000 | +500 | Gemini (dizayn) |
| 3x4 rasm (10x15 listda 9 dona) | 5 000 | +5 000 | — |
| Misol yechish (rasmdan) | 1-si bepul, 10 tasi 3 000 | — | Gemini |
| Testlar (uz/en/ru, fan, mavzu, sinf, variantlar) | `PRICE_TESTS` (5 000) | — | OpenAI |

Hajmi ko'proq tanlansa (masalan 15 yoki 20 varoq) narx mutanosib oshadi.

Dizayn hujjatlarida Gemini matnni tuzadi va ranglarni tanlaydi, `GEMINI_IMAGE_MODEL` matnsiz bezakli fon chizadi,
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

## Admin buyruqlari
- `/stats` — buyurtmalar statistikasi
- `/payments` — userbot ko'rgan oxirgi karta kirimlari
- `/confirm <id>` — buyurtmani qo'lda to'langan deb belgilash va faylni yuborish
- `/order <id>` — buyurtma tafsilotlari

## Testlar
```bash
pip install -r requirements-dev.txt
pytest
```
