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

## 1. Dashboardni ishga tushirish (o'z kompyuteringizda)

```bash
cd server-monitor
python3 dashboard/server.py
# brauzerda oching: http://127.0.0.1:8800
```

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

Dashboardda **"+ Server qo'shish"** ni bosing — u yangi token yaratadi va tayyor buyruqni ko'rsatadi:

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

## Yuklama qanday baholanadi

Har ko'rsatkich 0–100 shkalaga keltiriladi va eng yomoni olinadi: CPU %, RAM %, eng to'la disk %,
load/yadro (1.0 = 80), IO wait ×3, swap. Natija: `<50` Yengil, `50–75` O'rtacha, `75–90` Og'ir, `≥90` Kritik.
Belgi ustiga sichqoncha olib borsangiz, sababini ko'rsatadi (masalan, "Disk 92%").

## Xavfsizlik

- Agent token bilan himoyalangan; `--allow` bilan faqat dashboard IP siga ruxsat bering.
- Trafik shifrlanmagan HTTP — internet orqali bo'lsa VPN/WireGuard yoki SSH tunnel ishlating:
  `ssh -N -L 19800:127.0.0.1:9800 root@SERVER_IP` va dashboardga `127.0.0.1:19800` ni qo'shing.
- Dashboard standart holatda faqat `127.0.0.1` da ochiladi.
