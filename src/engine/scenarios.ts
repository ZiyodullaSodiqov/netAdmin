// Tayyor o'quv laboratoriyalari (real konfiguratsiyalar bilan).
import { Network } from './network';
import type { Device } from './device';
import { createDevice, DeviceType } from './factory';
import type { NetOsDevice } from './devices/netos';
import type { Host } from './devices/host';
import type { AccessPoint } from './devices/wireless';
import type { CableType } from './link';

export interface Scenario {
  id: string;
  title: string;
  level: "Boshlang'ich" | "O'rta" | 'Yuqori';
  description: string;
  tasks: string[];
  build: (net: Network) => void;
}

function add<T extends Device = Device>(net: Network, type: DeviceType, label: string, x: number, y: number): T {
  return net.addDevice(createDevice(type, label) as T, x, y);
}

function link(net: Network, a: Device, pa: string, b: Device, pb: string, type?: CableType) {
  const r = net.connect(a.port(pa)!, b.port(pb)!, type);
  if (typeof r === 'string') throw new Error(`${a.label} ${pa} <-> ${b.label} ${pb}: ${r}`);
  return r;
}

/** IOS konfiguratsiyasini qo'llash va startup-config ga saqlash (oldindan sozlangan laboratoriya) */
function ios(d: Device, text: string) {
  const n = d as NetOsDevice;
  const errs = n.applyConfig(text);
  if (errs.length) console.warn(`[${d.label}] konfiguratsiya xatolari:`, errs);
  n.startupConfig = n.runningConfig();
}

function hostIp(h: Device, ip: string, mask: string, gw = '', dns = '') {
  const x = h as Host;
  x.gateway = gw;
  x.dnsServer = dns;
  x.setNicConfig(x.nics[0], { mode: 'static', ip, mask });
}

function hostDhcp(h: Device) {
  const x = h as Host;
  for (const n of x.nics) x.setNicConfig(n, { mode: 'dhcp' });
}

function internetServer(net: Network, x: number, y: number, label = 'Internet-Server') {
  const s = add<Host>(net, 'server', label, x, y);
  hostIp(s, '203.0.113.10', '255.255.255.0', '203.0.113.1', '203.0.113.10');
  s.setDnsService(true);
  s.dns.records = [
    { name: 'www.netadmin.uz', type: 'A', value: '203.0.113.10', ttl: 3600 },
    { name: 'netadmin.uz', type: 'A', value: '203.0.113.10', ttl: 3600 },
    { name: 'maktab.uz', type: 'CNAME', value: 'www.netadmin.uz', ttl: 3600 },
    { name: 'api.netadmin.uz', type: 'A', value: '203.0.113.10', ttl: 3600 },
  ];
  s.http.pages.set('/', { path: '/', title: 'NetAdmin School — Internet', body: "<h1>Internetga xush kelibsiz!</h1><p>Siz bu sahifani ko'ryapsizmi? Demak DNS, NAT, marshrutlash va gateway to'g'ri ishlayapti.</p>", size: 48_000, cpuMs: 5, dbMs: 0 });
  return s;
}

export const SCENARIOS: Scenario[] = [
  // ------------------------------------------------------------------------------------------
  {
    id: 'office',
    title: 'Ofis: VLAN, IP telefonlar, Wi-Fi va Internet',
    level: "O'rta",
    description:
      "Haqiqiy kichik ofis: router-on-a-stick (3 ta VLAN), PoE kommutator, IP telefonlar (CallManager Express, Voice VLAN), korporativ Wi-Fi, lokal server, NAT orqali Internet.",
    tasks: [
      'PC1 dan ping 192.168.10.1 (gateway) va ping www.netadmin.uz',
      "Phone1 dan Phone2 raqamiga (displeyda ko'rinadi) qo'ng'iroq qiling, Phone2 da javob bering — MOS ni kuzating",
      'SW1 da: show vlan brief, show interfaces trunk, show power inline, show cdp neighbors',
      'R1-Ofis da: show ip nat translations, show ephone, show ip dhcp binding',
      'Noutbukda brauzerda http://www.netadmin.uz ni oching',
    ],
    build(net) {
      const isp = add(net, 'router-2911', 'ISP', 80, -30);
      const web = internetServer(net, 110, -30);
      const r1 = add(net, 'router-2911', 'R1-Ofis', 45, -15);
      const sw = add(net, 'switch-2960-24PS', 'SW1', 45, 5);
      const ph1 = add(net, 'ipphone', 'Phone1', 15, 20);
      const ph2 = add(net, 'ipphone', 'Phone2', 32, 22);
      const pc1 = add(net, 'pc', 'PC1', 12, 32);
      const pc2 = add(net, 'pc', 'PC2', 32, 34);
      const ap = add<AccessPoint>(net, 'accesspoint', 'AP1', 68, 18);
      const lap = add<Host>(net, 'laptop', 'Laptop1', 75, 30);
      const mob = add<Host>(net, 'smartphone', 'Smartfon1', 62, 32);
      const prn = add(net, 'printer', 'Printer1', 50, 26);
      const srv = add<Host>(net, 'server', 'Server-Intranet', 20, 2);
      link(net, isp, 'g0/1', web, 'GigabitEthernet0');
      link(net, r1, 'g0/1', isp, 'g0/0');
      link(net, r1, 'g0/0', sw, 'g0/1');
      link(net, sw, 'fa0/1', ph1, 'Switch');
      link(net, sw, 'fa0/2', ph2, 'Switch');
      link(net, ph1, 'PC', pc1, 'FastEthernet0');
      link(net, ph2, 'PC', pc2, 'FastEthernet0');
      link(net, sw, 'fa0/3', ap, 'GigabitEthernet0');
      link(net, sw, 'fa0/4', prn, 'FastEthernet0');
      link(net, sw, 'fa0/10', srv, 'GigabitEthernet0');
      ios(isp, `hostname ISP
interface GigabitEthernet0/0
 description Mijoz: Ofis
 ip address 100.64.0.1 255.255.255.252
 no shutdown
interface GigabitEthernet0/1
 description Data-markaz
 ip address 203.0.113.1 255.255.255.0
 no shutdown`);
      ios(r1, `hostname R1-Ofis
enable secret cisco
ip domain-name ofis.local
username admin privilege 15 secret admin123
ip dhcp excluded-address 192.168.10.1 192.168.10.20
ip dhcp excluded-address 192.168.20.1 192.168.20.20
ip dhcp excluded-address 192.168.30.1 192.168.30.20
ip dhcp pool DATA
 network 192.168.10.0 255.255.255.0
 default-router 192.168.10.1
 dns-server 203.0.113.10
ip dhcp pool VOICE
 network 192.168.20.0 255.255.255.0
 default-router 192.168.20.1
 option 150 ip 192.168.20.1
ip dhcp pool WIFI
 network 192.168.30.0 255.255.255.0
 default-router 192.168.30.1
 dns-server 203.0.113.10
interface GigabitEthernet0/0
 description SW1 trunk
 no shutdown
interface GigabitEthernet0/0.10
 description DATA
 encapsulation dot1Q 10
 ip address 192.168.10.1 255.255.255.0
 ip nat inside
interface GigabitEthernet0/0.20
 description VOICE
 encapsulation dot1Q 20
 ip address 192.168.20.1 255.255.255.0
 ip nat inside
interface GigabitEthernet0/0.30
 description WIFI
 encapsulation dot1Q 30
 ip address 192.168.30.1 255.255.255.0
 ip nat inside
interface GigabitEthernet0/1
 description ISP uplink
 ip address 100.64.0.2 255.255.255.252
 ip nat outside
 no shutdown
access-list 1 permit 192.168.0.0 0.0.255.255
ip nat inside source list 1 interface GigabitEthernet0/1 overload
ip route 0.0.0.0 0.0.0.0 100.64.0.1
telephony-service
 max-ephones 10
 max-dn 10
 ip source-address 192.168.20.1 port 2000
 auto assign 1 to 10
ephone-dn 1
 number 1001
ephone-dn 2
 number 1002
ephone-dn 3
 number 1003
line vty 0 4
 login local
 transport input ssh telnet`);
      ios(sw, `hostname SW1
vlan 10
 name DATA
vlan 20
 name VOICE
vlan 30
 name WIFI
interface range FastEthernet0/1 - 2
 description IP telefon + PC
 switchport mode access
 switchport access vlan 10
 switchport voice vlan 20
 spanning-tree portfast
interface FastEthernet0/3
 description Wi-Fi AP
 switchport mode access
 switchport access vlan 30
 spanning-tree portfast
interface range FastEthernet0/4 , FastEthernet0/10
 switchport mode access
 switchport access vlan 10
 spanning-tree portfast
interface GigabitEthernet0/1
 description R1 trunk
 switchport mode trunk
interface Vlan1
 shutdown`);
      ap.radios[0].cfg = { ...ap.radios[0].cfg, ssid: 'Ofis-WiFi', security: 'wpa2-psk', key: 'Ofis2024!', channel: 6 };
      ap.radios[1].cfg = { ...ap.radios[1].cfg, ssid: 'Ofis-WiFi', security: 'wpa2-psk', key: 'Ofis2024!', enabled: true, channel: 36 };
      ap.applyRadioVlans();
      for (const w of [lap, mob]) w.wifi = { enabled: true, ssid: 'Ofis-WiFi', security: 'wpa2-psk', key: 'Ofis2024!' };
      hostDhcp(pc1);
      hostDhcp(pc2);
      hostDhcp(prn);
      hostDhcp(lap);
      hostDhcp(mob);
      hostIp(srv, '192.168.10.100', '255.255.255.0', '192.168.10.1', '203.0.113.10');
      srv.http.pages.set('/', { path: '/', title: 'Intranet', body: '<h1>Ofis intranet portali</h1><p>Hujjatlar, jadval, yangiliklar.</p>', size: 20_000, cpuMs: 3, dbMs: 0 });
    },
  },
  // ------------------------------------------------------------------------------------------
  {
    id: 'home',
    title: "Uy tarmog'i: Wi-Fi router va provayder",
    level: "Boshlang'ich",
    description: "Oddiy uy: provayder (ISP) DHCP orqali WAN IP beradi, Wi-Fi router NAT qiladi, noutbuk/telefonlar Wi-Fi orqali, kompyuter kabel orqali ulanadi.",
    tasks: [
      'Noutbukda ipconfig /all — IP, gateway va DNS ni tekshiring',
      'Smartfonni Wi-Fi routerdan uzoqlashtiring — signal va tezlik qanday o\'zgaradi?',
      'PC dan tracert www.netadmin.uz',
      'Wi-Fi parolini o\'zgartiring — qurilmalar uziladi, ularda ham parolni yangilang',
    ],
    build(net) {
      const isp = add(net, 'router-2911', 'ISP', 60, -30);
      internetServer(net, 90, -30);
      const hr = add(net, 'homerouter', 'WiFi-Router', 30, 0);
      const pc = add(net, 'pc', 'PC-Uy', 15, 12);
      const lap = add<Host>(net, 'laptop', 'Noutbuk', 42, 10);
      const mob = add<Host>(net, 'smartphone', 'Telefon', 24, 18);
      const tv = add<Host>(net, 'smartphone', 'Planshet', 45, -8);
      link(net, isp, 'g0/1', net.device('Internet-Server')!, 'GigabitEthernet0');
      link(net, isp, 'g0/0', hr, 'Internet');
      link(net, hr, 'Ethernet1', pc, 'FastEthernet0');
      ios(isp, `hostname ISP
ip dhcp excluded-address 100.64.1.1
ip dhcp pool MIJOZLAR
 network 100.64.1.0 255.255.255.0
 default-router 100.64.1.1
 dns-server 203.0.113.10
interface GigabitEthernet0/0
 description Abonentlar
 ip address 100.64.1.1 255.255.255.0
 no shutdown
interface GigabitEthernet0/1
 ip address 203.0.113.1 255.255.255.0
 no shutdown`);
      for (const w of [lap, mob, tv]) {
        w.wifi = { enabled: true, ssid: 'Uy-WiFi', security: 'wpa2-psk', key: '12345678' };
        hostDhcp(w);
      }
      hostDhcp(pc);
    },
  },
  // ------------------------------------------------------------------------------------------
  {
    id: 'ospf',
    title: 'Uch filial: OSPF dinamik marshrutlash',
    level: 'Yuqori',
    description: "Uchta filial routeri uchburchak shaklida ulangan, OSPF area 0. Bitta liniyani uzing — OSPF muqobil yo'lni topadi.",
    tasks: [
      'R1 da: show ip ospf neighbor, show ip route ospf',
      'PC1 dan tracert 192.168.3.10',
      "R1–R3 kabelini o'chiring va 40 soniyadan keyin marshrut qanday o'zgarganini ko'ring",
    ],
    build(net) {
      const r = [add(net, 'router-2911', 'R1', 20, -10), add(net, 'router-2911', 'R2', 70, -10), add(net, 'router-2911', 'R3', 45, -40)];
      const sws = [add(net, 'switch-2960-24TT', 'SW-1', 10, 12), add(net, 'switch-2960-24TT', 'SW-2', 80, 12), add(net, 'switch-2960-24TT', 'SW-3', 45, -62)];
      const pcs = [add(net, 'pc', 'PC1', 5, 28), add(net, 'pc', 'PC2', 85, 28), add(net, 'pc', 'PC3', 60, -70)];
      link(net, r[0], 'g0/1', r[1], 'g0/1');
      link(net, r[0], 'g0/2', r[2], 'g0/1');
      link(net, r[1], 'g0/2', r[2], 'g0/2');
      for (let i = 0; i < 3; i++) {
        link(net, r[i], 'g0/0', sws[i], 'g0/1');
        link(net, sws[i], 'fa0/1', pcs[i], 'FastEthernet0');
        ios(sws[i], `hostname SW-${i + 1}\ninterface FastEthernet0/1\n switchport mode access\n spanning-tree portfast`);
        hostIp(pcs[i], `192.168.${i + 1}.10`, '255.255.255.0', `192.168.${i + 1}.1`);
      }
      const links: Record<number, string[]> = {
        0: ['GigabitEthernet0/1 10.0.12.1', 'GigabitEthernet0/2 10.0.13.1'],
        1: ['GigabitEthernet0/1 10.0.12.2', 'GigabitEthernet0/2 10.0.23.2'],
        2: ['GigabitEthernet0/1 10.0.13.3', 'GigabitEthernet0/2 10.0.23.3'],
      };
      for (let i = 0; i < 3; i++) {
        const n = i + 1;
        ios(r[i], `hostname R${n}
interface Loopback0
 ip address ${n}.${n}.${n}.${n} 255.255.255.255
interface GigabitEthernet0/0
 ip address 192.168.${n}.1 255.255.255.0
 no shutdown
${links[i].map((l) => `interface ${l.split(' ')[0]}\n ip address ${l.split(' ')[1]} 255.255.255.0\n no shutdown`).join('\n')}
router ospf 1
 router-id ${n}.${n}.${n}.${n}
 network 192.168.${n}.0 0.0.0.255 area 0
 network 10.0.0.0 0.0.255.255 area 0
 network ${n}.${n}.${n}.${n} 0.0.0.0 area 0
 passive-interface GigabitEthernet0/0`);
      }
    },
  },
  // ------------------------------------------------------------------------------------------
  {
    id: 'stp',
    title: 'Spanning Tree: halqa va bloklangan port',
    level: "O'rta",
    description: "Uchta kommutator halqa (loop) hosil qilgan. STP root bridge ni saylaydi va bitta portni bloklaydi — broadcast bo'roni bo'lmaydi.",
    tasks: [
      'Har bir switchda show spanning-tree — Root, Desg, Altn portlarni toping',
      'SW-A da: spanning-tree vlan 1 root primary — root qanday o\'zgaradi?',
      "Root portdagi kabelni uzing — bloklangan port 30 soniyada forwarding holatiga o'tadi (RSTP da — deyarli darhol)",
    ],
    build(net) {
      const a = add(net, 'switch-2960-24TT', 'SW-A', 40, -20);
      const b = add(net, 'switch-2960-24TT', 'SW-B', 15, 15);
      const c = add(net, 'switch-2960-24TT', 'SW-C', 65, 15);
      link(net, a, 'g0/1', b, 'g0/1');
      link(net, a, 'g0/2', c, 'g0/1');
      link(net, b, 'g0/2', c, 'g0/2');
      const p1 = add(net, 'pc', 'PC-B', 5, 30);
      const p2 = add(net, 'pc', 'PC-C', 75, 30);
      link(net, b, 'fa0/1', p1, 'FastEthernet0');
      link(net, c, 'fa0/1', p2, 'FastEthernet0');
      for (const [s, n] of [
        [a, 'SW-A'],
        [b, 'SW-B'],
        [c, 'SW-C'],
      ] as const)
        ios(s, `hostname ${n}\ninterface FastEthernet0/1\n switchport mode access\n spanning-tree portfast`);
      hostIp(p1, '10.1.1.10', '255.255.255.0');
      hostIp(p2, '10.1.1.20', '255.255.255.0');
    },
  },
  // ------------------------------------------------------------------------------------------
  {
    id: 'load',
    title: 'Server yuklamasi: ko\'p foydalanuvchi',
    level: "O'rta",
    description:
      "Web server (4 yadro, 8 GB) ga 4 ta kompyuter yuklama generatori bilan so'rov yuboradi. CPU, navbat, javob vaqti va 503 xatolarni kuzating; serverni kuchaytiring yoki linkni Gigabitga o'tkazing.",
    tasks: [
      "Serverni oching → Yuklama grafigi. Har bir PC da Yuklama generatori: 100 so'rov/s, /api/data",
      'CPU 100% ga yetganda javob vaqti qanday o\'sadi? Serverda yadrolar sonini 16 ga oshiring',
      "Server Fa0/24 ga ulangan (100 Mbit/s) — katta sahifalarda tarmoq to'yinadi; kabelni Gi0/1 ga o'tkazing",
    ],
    build(net) {
      const sw = add(net, 'switch-2960-24TT', 'SW-DC', 40, 0);
      const srv = add<Host>(net, 'server', 'Web-Server', 40, -25);
      srv.hardware = { cpuCores: 4, cpuGhz: 2.4, ramMb: 8192, diskIops: 3000 };
      link(net, sw, 'fa0/24', srv, 'GigabitEthernet0');
      hostIp(srv, '10.10.10.100', '255.255.255.0', '10.10.10.1');
      ios(sw, `hostname SW-DC\nspanning-tree portfast default`);
      for (let i = 0; i < 4; i++) {
        const pc = add(net, 'pc', `Client${i + 1}`, 10 + i * 20, 25);
        link(net, sw, `fa0/${i + 1}`, pc, 'FastEthernet0');
        hostIp(pc, `10.10.10.${11 + i}`, '255.255.255.0', '10.10.10.1');
      }
    },
  },
  // ------------------------------------------------------------------------------------------
  {
    id: 'empty',
    title: "Bo'sh maydon",
    level: "Boshlang'ich",
    description: "O'zingiz noldan tarmoq quring.",
    tasks: ["Chap paneldan qurilmalarni torting, kabel bilan ulang, sozlang"],
    build() {},
  },
];

export function buildScenario(id: string): Network {
  const net = new Network();
  const s = SCENARIOS.find((x) => x.id === id) ?? SCENARIOS[SCENARIOS.length - 1];
  s.build(net);
  net.refresh();
  return net;
}
