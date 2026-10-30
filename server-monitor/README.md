# NetAdmin Monitor — serverlar uchun lokal dashboard

Ko'plab Linux serverlarning holatini bitta lokal sahifada real vaqtda kuzatish:
CPU, RAM, disk, yuklama (load), tarmoq, jarayonlar, ochiq portlar, **kim kirdi** (SSH/konsol/sudo,
xato urinishlar va hujum qilayotgan IP lar) va **oxirgi API so'rovlar** (nginx/apache access log).
Har bir server uchun yuklama holati avtomatik baholanadi: **Yengil / O'rtacha / Og'ir / Kritik / Ishlamayapti**.

Hech narsa o'rnatish shart emas — faqat **Python 3** (pip, Docker, internet kerak emas).

```
 ┌──────────── sizning kompyuteringiz ───────────┐          ┌──── har bir server ────┐
 │  dashboard/server.py  ──  http://127.0.0.1:8800│ ──HTTP──▶│ agent  :9800 (token)   │
 │  (har 5 s so'raydi, tarixni SQLite ga yozadi)  │          │ /proc, wtmp, auth.log, │
 └────────────────────────────────────────────────┘          │ nginx access.log       │
                                                             └────────────────────────┘
```

## 1. O'rnatish va ishga tushirish — bitta buyruq

```bash
cd server-monitor
python3 start.py              # dashboard + shu kompyuter agenti; brauzer o'zi ochiladi
```

Windowsda `start.bat` ni ikki marta bosing (yoki `python start.py`).

`start.py` dashboardni va (Linux bo'lsa) shu kompyuterning agentini birga ishga tushiradi,
kompyuterni "Bu kompyuter" nomi bilan dashboardga o'zi qo'shadi. Ctrl+C ikkalasini to'xtatadi.

Kompyuter yonganda avtomatik ishlashi uchun:

```bash
sudo python3 start.py --install     # Linux (systemd servis)
python start.py --install           # Windows (Startup, yashirin oynada) / macOS (launchd)
python3 start.py --uninstall        # avtomatik ishga tushishni o'chirish
```

`start.py` parametrlari: `--no-agent`, `--no-browser`, `--agent-port 9800`, qolganlari dashboardga uzatiladi.
Faqat dashboardning o'zini ishga tushirish: `python3 dashboard/server.py`.

Windows, macOS va Linuxda ishlaydi (Python 3.7+). Parametrlar:

| Parametr | Standart | Ma'nosi |
|---|---|---|
| `--port` | 8800 | dashboard porti |
| `--host` | 127.0.0.1 | boshqa kompyuterdan ochish uchun `0.0.0.0` (unda `--password` qo'ying) |
| `--interval` | 5 | serverlarni necha sekundda bir so'rash |
| `--store-every` | 30 | tarixga necha sekundda bir yozish |
| `--retention-days` | 14 | tarix necha kun saqlanadi |
| `--password` | — | dashboardga kirish paroli (Basic auth) |
| `--db` | dashboard/monitor.db | ma'lumotlar bazasi fayli |

## 2. Har bir serverga agent o'rnatish

### Avtomatik (SSH kalit orqali) — tavsiya etiladi

**"+ Server qo'shish"** ni bosing, IP ni kiriting va **O'rnatish** ni bosing. Dashboard shu kompyuterdagi
`ssh`/`scp` buyruqlari va sizning SSH kalitingiz bilan serverga ulanadi, agentni o'rnatadi va serverni
ro'yxatga qo'shadi. Parol kerak emas. Shart: terminalda `ssh root@SERVER_IP` parol so'ramasdan kirishi kerak.
Kalit boshqa joyda bo'lsa, uning yo'lini dialogdagi yoki **Sozlamalar → SSH** dagi maydonga yozing.
Root bo'lmagan foydalanuvchi uchun parolsiz `sudo` kerak.

DigitalOcean ulangan bo'lsa, **DigitalOcean** sahifasida bitta tugma bilan barcha kuzatilmayotgan
dropletlarga agent o'rnatiladi.

> DigitalOcean Cloud Firewall ishlatsangiz, unda agent portini (9800) dashboard IP si uchun oching.

### Qo'lda

**"+ Server qo'shish" → "Agent o'rnatilgan — token bilan qo'shish"** — dialog token yaratadi va buyruqni ko'rsatadi:

```bash
scp agent/netadmin_agent.py agent/install.sh root@SERVER_IP:/tmp/
ssh root@SERVER_IP "bash /tmp/install.sh --token TOKEN --allow DASHBOARD_IP"
```

`install.sh` agentni `/opt/netadmin-agent` ga ko'chiradi, `netadmin-agent` systemd servisini yaratadi,
firewallda (ufw/firewalld) portni ochadi va tokenni ko'rsatadi. Token berilmasa o'zi yaratadi.

Qo'shimcha:
- `--port 9800` — agent porti
- `--allow 1.2.3.4,5.6.7.8` — faqat shu IP lardan so'rovga ruxsat (tavsiya etiladi)
- `--access-log "/var/log/nginx/*access.log"` — API so'rovlari olinadigan log fayllar
  (standart: nginx, apache, caddy loglari). Format: standart `combined`; oxiriga `$request_time`
  qo'shsangiz javob vaqti (p95) ham ko'rinadi.
- O'chirish: `bash install.sh --uninstall`
- **Yangilash:** yangi `netadmin_agent.py` va `install.sh` ni serverga nusxalab, `bash /tmp/install.sh` ni
  parametrsiz ishga tushiring — token, port va boshqa sozlamalar saqlanib qoladi.

Agent root sifatida ishlaydi (auth.log va boshqa jarayonlarning ma'lumotini o'qish uchun),
faqat o'qiydi, hech narsani o'zgartirmaydi. Tekshirish: `python3 netadmin_agent.py --once`.

Ko'p serverni birdaniga qo'shish uchun **"Ko'plab qo'shish"**: har qatorda `nomi, ip, port, token, guruh`.

## Nimalar ko'rinadi

**Umumiy sahifa** — jami / ishlayotgan / ishlamayotgan / og'ir serverlar, o'rtacha CPU/RAM, umumiy trafik,
HTTP so'rov/daqiqa, hozir kirganlar; har server kartasi (CPU, RAM, disk, load, CPU sparkline, uptime);
qidirish, guruh/holat filtri, saralash, jadval ko'rinishi; hodisalar lentasi.

**Server sahifasi**
- Grafiklar (15 daq … 30 kun): CPU + IO wait, RAM + swap, load, tarmoq ↓/↑, disk o'qish/yozish,
  HTTP so'rov/daqiqa, TCP ulanishlar, disk to'lishi
- Har bir CPU yadrosi, xotira tafsiloti, disk bo'limlari (hajm, inode), disk I/O, tarmoq interfeyslari
- Eng ko'p CPU/RAM ishlatayotgan jarayonlar (PID, foydalanuvchi, buyruq)
- **Kim kirdi**: hozir ichkaridagilar, kirish/chiqish tarixi (wtmp), muvaffaqiyatli SSH kirishlar,
  xato urinishlar, hujum qilayotgan IP lar, sudo bilan bajarilgan buyruqlar
- **Oxirgi API so'rovlar**: vaqt, IP, metod, URL, status, hajm, javob vaqti; eng ko'p chaqirilgan
  endpointlar, 5xx xatolar, mijoz IP lari, 2xx/4xx/5xx ulushi
- Ochiq portlar (qaysi jarayon), eng ko'p ulangan IP lar, ishdan chiqqan systemd servislar

**Hodisalar** (avtomatik yoziladi): server o'chdi / yana ishladi, yuklama Og'ir/Kritik bo'ldi va normallashdi,
disk 90% dan oshdi, serverga **yangi kirish** bo'ldi (kim, qaysi IP dan).

## Hujumlar xaritasi va himoya

Yuqoridagi **"Hujumlar xaritasi"** sahifasi barcha serverlardan quyidagilarni yig'adi:
- SSH parolni taxmin qilish urinishlari (auth.log);
- zaiflik qidiruvchi HTTP so'rovlar: `/.env`, `/.git`, `/wp-login.php`, `/phpmyadmin` va hokazo (nginx access log).

Hujumchi IP lar dunyo xaritasida ko'rsatiladi: doira qancha katta bo'lsa, urinishlar shuncha ko'p.
Mamlakatlar reytingi va IP jadvali (provayder, qaysi serverlarga hujum qilgani, fail2ban bloklaganmi) ham bor.
Har bir IP yonidagi **"Bloklash"** tugmasi uni bloklash buyrug'ini nusxalaydi.

Sahifada **"Serverlar xavfsizligi"** jadvali ham bor. U har bir serverni tekshiradi: fail2ban bormi,
SSH ga parol bilan kirish yoqilganmi, root login, firewall, agent porti hammaga ochiqmi.
Bajarilmagan qadamlar uchun tayyor buyruqlar shu sahifaning o'zida ko'rsatiladi.

IP joylashuvi bepul **ip-api.com** xizmatidan olinadi va `monitor.db` da keshlanadi.
Bu xizmatga faqat hujumchilarning IP manzillari yuboriladi. Buni o'chirish uchun dashboardni
`--no-geoip` bilan ishga tushiring (unda xarita bo'sh qoladi).

Xaritaga **API kalit kerak emas**. Ikki xil fon bor:
- **Oddiy** (standart) — mamlakat chegaralari dashboard ichida keladi (Natural Earth), internetsiz ham ishlaydi;
- **Batafsil** — OpenStreetMap tayllari (internet kerak, kalit kerak emas).

Leaflet kutubxonasi ham dashboard ichida keladi (`static/vendor/`).

Bu ma'lumotlar uchun agent **1.1.0+**, loglar uchun **1.2.0** versiyasi kerak. Eski agentlarda "agentni yangilang" degan yozuv chiqadi.

## Saytlar monitoringi

**Saytlar** sahifasida domen yoki URL qo'shasiz (masalan `example.uz` yoki `https://api.example.uz/health`).
Dashboard uni har 30 soniya / 1 / 5 / 15 daqiqada tashqaridan tekshiradi:
- sayt ochiladimi, status kodi (200 / 500 …), javob vaqti, uptime (24 soat, 7 kun);
- ixtiyoriy **kalit so'z**: sahifada shu matn bo'lmasa, sayt "ishlamayapti" deb hisoblanadi;
- **SSL sertifikat** muddati: 14, 7, 3 va 1 kun qolganda ogohlantiradi;
- domen IP si qaysi serveringizga tegishli ekanini aniqlaydi. Sayt ochilmasa-yu server ishlab tursa,
  "nginx yoki backend ni tekshiring" deb yozadi.

Bitta tasodifiy xato uchun ogohlantirish berilmaydi: ketma-ket 2 ta xato bo'lsagina ogohlantiradi.

## Telegram ogohlantirishlar va haftalik hisobot

**Sozlamalar → Telegram**:
1. [@BotFather](https://t.me/BotFather) ga `/newbot` yozing va tokenni oling.
2. Botingizga `/start` yozing.
3. Tokenni joylang va **"Chat ID ni aniqlash"** → **Saqlash** → **Test xabar yuborish** ni bosing.

Yuboriladigan hodisalar (har birini yoqish/o'chirish mumkin):
- server o'chdi / yana ishladi;
- yuklama Og'ir/Kritik bo'ldi; disk 90% dan oshdi; disk tez orada to'ladi (bashorat);
- **notanish IP dan serverga kirildi**. Avval kirilgan IP lar eslab qolinadi, yangisi bo'lsa ogohlantiradi;
- sayt ishlamay qoldi / tiklandi; SSL sertifikat tugayapti.

8 soniya ichidagi hodisalar bitta xabarga yig'iladi. Yuklama haqidagi xabar bir server uchun 30 daqiqada ko'pi bilan bir marta keladi.

**Haftalik hisobot** tanlangan kun va soatda keladi. Unda: uptime, eng yuklangan serverlar, disk bashorati, saytlar, SSH hujumlar va hafta hodisalari.

## DigitalOcean

**Sozlamalar → DigitalOcean** ga **Read** huquqli API token joylang
([cloud.digitalocean.com → API → Tokens](https://cloud.digitalocean.com/account/api/tokens)).
**DigitalOcean** sahifasida quyidagilar ko'rinadi:
- barcha dropletlar, oylik narx va shu oyda sarflangan summa;
- har bir droplet uchun 7 kunlik RAM/CPU (p95) bo'yicha tavsiya: **kattalashtiring**, **tejash mumkin** yoki **mos**;
- kam yuklangan dropletlarni bitta kattaroq dropletga **birlashtirish** hisobi va tejaladigan summa;
- kuzatilmayotgan dropletlarga bitta tugma bilan agent o'rnatish.

Dashboard DigitalOcean'da hech narsani o'zgartirmaydi.

## Loglar

Server sahifasidagi **Loglar** tugmasi: systemd journal (servis va daraja bo'yicha filtr), nginx/apache
xatolari, access log, auth.log, syslog. Qidirish va har 10 soniyada yangilash bor. Tayyor tugmalar ham bor:
"Faqat xatolar", "nginx xatolari", "SSH", "HTTP 5xx", "OOM (RAM tugashi)". Agent loglarni faqat o'qiydi.

## Disk to'lishi bashorati

Oxirgi 7 kunlik disk to'lishi bo'yicha har 10 daqiqada hisoblanadi: "shu tezlikda ~12 kunda to'ladi".
14 kundan kam qolsa — ogohlantirish, 3 kundan kam qolsa — kritik ogohlantirish. Kamida 6 soatlik ma'lumot kerak.

## Yuklama qanday baholanadi

Har ko'rsatkich 0–100 shkalaga keltiriladi va eng yomoni olinadi: CPU %, RAM %, eng to'la disk %,
load/yadro (1.0 = 80), IO wait ×3, swap. Natija: `<50` Yengil, `50–75` O'rtacha, `75–90` Og'ir, `≥90` Kritik.
Belgi ustiga sichqoncha olib borsangiz, sababini ko'rsatadi (masalan, "Disk 92%").

## Xavfsizlik

- Agent token bilan himoyalangan; `--allow` bilan faqat dashboard IP siga ruxsat bering.
- Trafik shifrlanmagan HTTP — internet orqali bo'lsa VPN/WireGuard yoki SSH tunnel ishlating:
  `ssh -N -L 19800:127.0.0.1:9800 root@SERVER_IP` va dashboardga `127.0.0.1:19800` ni qo'shing.
- Dashboard standart holatda faqat `127.0.0.1` da ochiladi.
- Telegram, DigitalOcean tokenlari va SSH sozlamalari faqat shu kompyuterdagi `dashboard/monitor.db` da saqlanadi.
  Bu faylni boshqalarga bermang.
