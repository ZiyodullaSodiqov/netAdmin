# NetAdmin School — tarmoq simulyatori va o'quv platformasi

Brauzerda ishlaydigan, **real hayotdagidek** ishlaydigan tarmoq simulyatori: routerlar, kommutatorlar, kabellar,
portlar, VLAN, Wi-Fi, IP telefonlar, serverlar va ularning yuklamasi. Har bir kadr (Ethernet frame) haqiqiy
protokol qoidalari bo'yicha qurilmadan qurilmaga o'tadi — shuning uchun tarmoqni "ichidan" o'rganish mumkin.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # dvigatel testlari (vitest)
npm run build    # production build (dist/)
```

## Nimalar bor

### Fizik qatlam
- **Kabellar**: Cat6 to'g'ri/kross, optika Multimode (550 m) va Singlemode (10 km), konsol (rollover).
  Uzunlik qurilmalar orasidagi masofadan hisoblanadi (1 grid = 1 metr): Cat6 100 m dan oshsa link ishlamaydi.
- **MDI / MDI-X va Auto-MDIX**: eski Router 1841 va PC NIC larida Auto-MDIX yo'q — noto'g'ri kabel bilan link ko'tarilmaydi.
- **Port turlari**: RJ45 (10/100 yoki 10/100/1000), SFP optika, Console, RS-232, Wi-Fi radio. Optik kabel RJ45 ga fizik jihatdan kirmaydi.
- **Tezlikni kelishish (autonegotiation)**, `speed`/`duplex` sozlamalari, port hisoblagichlari, chiqish navbati va drop lar.
- **PoE (802.3af/at)**: IP telefon va Wi-Fi AP PoE switch (2960-24PS, 3560, 3650) portidan yoki adapterdan quvvat oladi,
  switchning PoE byudjeti hisobga olinadi (`show power inline`, `power inline never`).
- **Quvvat**: qurilmani o'chirish/yoqish; saqlanmagan (`write memory` qilinmagan) konfiguratsiya qayta yuklashda yo'qoladi.

### Qurilmalar
| Qurilma | Portlar | Xususiyatlari |
|---|---|---|
| ISR 2911 / 4331 / 1841 | Gi0/0–0/2, SFP, Console | statik/OSPF, subinterfeys, DHCP, NAT/PAT, ACL, CallManager Express |
| Catalyst 2960-24TT / 24PS | Fa0/1–24, Gi0/1–2 | VLAN, trunk, DTP, STP, port-security, PoE |
| Catalyst 3560 / 3650 (L3) | Fa/Gi + SFP | SVI marshrutlash (`ip routing`), routed port (`no switchport`) |
| Access Point | Gi0 (PoE), 2.4 + 5 GHz radio | SSID → VLAN, WPA2/WPA3, kanal, quvvat, mijozlar |
| Uy Wi-Fi routeri | Internet (WAN), Ethernet1–4, Wi-Fi | DHCP, NAT, DNS proksi, port forwarding, admin panel |
| IP telefon 7960 | SW (PoE), PC | CDP → Voice VLAN, DHCP option 150, SCCP ro'yxatdan o'tish, RTP, MOS |
| PC / noutbuk / smartfon | FastEthernet0, Wi-Fi, RS-232 | Windows cmd, brauzer, Wi-Fi, konsol terminali, yuklama generatori |
| Server | 2×Gigabit | HTTP/HTTPS, DNS, DHCP, Syslog, CPU/RAM/disk yuklama modeli |

### Protokollar (haqiqiy paketlar bilan)
Ethernet II, 802.1Q, ARP (Cisco: birinchi paket ARP paytida tashlanadi — `.!!!!`), IPv4, ICMP (echo, unreachable,
TTL exceeded, rate-limit), UDP, TCP (3-bosqichli handshake, MSS segmentatsiya, ACK, qayta yuborish, RST, FIN),
DHCP (DORA, relay, APIPA, lease), DNS (A/CNAME, kesh, qayta urinish), HTTP, Telnet, SSH, STP/PVST+ va Rapid-PVST+
(root saylovi, port rollari, 15+15 s taymerlar, TC), DTP, CDP (native VLAN mismatch), OSPFv2 (hello, qo'shnilik, LSA,
Dijkstra SPF), NAT/PAT, standart/kengaytirilgan ACL, SCCP, RTP (G.711, DSCP EF), Syslog, 802.11 (RSSI, tezlik,
umumiy muhit / airtime).

### Cisco IOS CLI
Rejimlar (`>`, `#`, `(config)#`, `(config-if)#`, `(config-subif)#`, `(config-vlan)#`, `(config-line)#`,
`(config-router)#`, `(dhcp-config)#`, telefoniya rejimlari), qisqartmalar (`sh ip int br`), `?` yordam, `Tab`,
`do`, `| include`, `% Invalid input detected at '^' marker.`, parollar (enable secret, line, login local, type 5/7),
`show running-config`, `show ip route`, `show vlan brief`, `show interfaces trunk`, `show spanning-tree`,
`show mac address-table`, `show cdp neighbors`, `show ip dhcp binding`, `show ip nat translations`,
`show access-lists`, `show ip ospf neighbor`, `show ephone`, `show power inline`, `show port-security` va boshqalar.

### Real server yuklamasi
Har bir HTTP so'rov CPU yadrosini ma'lum vaqt band qiladi (sahifa sozlamasi: CPU ms + baza ms, chastotaga moslanadi,
HTTPS — TLS xarajati). Yadrolar band bo'lsa — navbat, navbat to'lsa — `503`, RAM yetmasa — swap (sekinlashuv),
disk IOPS cheklovi. Kompyuterlardagi yuklama generatori (N so'rov/s) bilan CPU, RAM, req/s, javob vaqti, xatolar
va tarmoq trafigini grafikda kuzatish mumkin.

### Rejimlar
- **Real vaqt** — tezlikni 0.1×…10× qilish, `+30s` (STP/OSPF/DHCP yaqinlashishi uchun), link LED lari faollikni ko'rsatadi.
- **Simulyatsiya** — har bir kadr alohida hodisa sifatida animatsiya qilinadi, protokol filtrlari, PDU ning OSI qatlamlari.

## Arxitektura

```
src/engine/            — renderersiz dvigatel (Node va brauzerda ishlaydi, testlanadi)
  sim.ts               — diskret voqealar rejalashtiruvchisi (ms)
  network.ts           — qurilmalar, kabellar, quvvat/PoE, link holatlari, Wi-Fi assotsiatsiya, devorlar
  port.ts, link.ts     — portlar (navbat, serializatsiya), kabellar, simsiz muhit (RSSI, airtime)
  switching.ts         — L2: VLAN, 802.1Q, DTP, MAC jadvali, port-security
  ipstack.ts, l3.ts    — L3: ARP, marshrutlash jadvali, forwarding, ICMP, UDP, NAT/ACL integratsiyasi
  protocols/           — tcp, dhcp, dns, stp, cdp, ospf, nat, acl, cme (telefoniya)
  devices/             — router, switch, host, ipphone, wireless (AP, uy routeri), server xizmatlari
  cli/                 — IOS tahlilchisi, buyruqlar, show, running-config, Windows/Linux shell, telnet/ssh
  factory.ts           — katalog, topologiyani JSON ga saqlash/yuklash
  scenarios.ts         — tayyor laboratoriyalar
src/ui/                — React UI (SVG maydon, qurilma oynalari, terminal, grafiklar)
tests/                 — vitest: L2/L3, VLAN, DHCP, telefonlar, Wi-Fi, NAT, OSPF, STP, yuklama, xavfsizlik
```

### Three.js (3D binolar) uchun tayyorgarlik
Dvigatel UI dan to'liq ajratilgan, shuning uchun 3D renderer xuddi SVG maydon kabi `Network` obyektini o'qiydi:
- Barcha koordinatalar **metrlarda** (`device.x`, `device.y`), `device.floor` (qavat) va `device.building` maydonlari bor.
- `network.walls` — devorlar (beton/gipsokarton/shisha) Wi-Fi signalini so'ndiradi (`wifiRssi(..., walls)`);
  3D bino rejasidan shu ro'yxatni to'ldirish kifoya.
- Kabel uzunligi masofadan hisoblanadi — 3D da kabel trassasi uzunligini `cable.manualLengthM` ga yozish mumkin.
- `network.on('tx')` hodisalari — paketlarni 3D kabellar bo'ylab animatsiya qilish uchun.

## Yo'l xaritasi
3D uylar/ofislar (Three.js), IPv6, EtherChannel (LACP), HSRP/VRRP, VTP, RIP/EIGRP/BGP, QoS policy-map,
SIP trunk va PSTN, firewall (ASA/zonalar), VPN (IPsec), NTP/SNMP, o'quv topshiriqlarini avtomatik tekshirish.
