// Kabellar va simsiz muhit.
import type { Port } from './port';
import type { Network } from './network';
import { EthernetFrame, frameWireSize } from './packets';

export type CableType = 'copper-straight' | 'copper-cross' | 'fiber-mm' | 'fiber-sm' | 'console';

export interface CableSpec {
  type: CableType;
  label: string;
  standard: string;
  maxLengthM: number;
  media: 'copper' | 'fiber' | 'console';
  color: string;
  /** Tarqalish tezligi (m/ms) — mis ~0.66c, optika ~0.68c */
  velocity: number;
  description: string;
}

export const CABLE_SPECS: Record<CableType, CableSpec> = {
  'copper-straight': {
    type: 'copper-straight',
    label: "To'g'ri (Straight-through) Cat6 UTP",
    standard: 'TIA/EIA-568B ↔ 568B',
    maxLengthM: 100,
    media: 'copper',
    color: '#94a3b8',
    velocity: 198_000,
    description: "Turli xil qurilmalarni ulaydi: PC↔Switch, Router↔Switch. 100 metrdan uzun bo'lsa signal so'nadi.",
  },
  'copper-cross': {
    type: 'copper-cross',
    label: 'Kross (Crossover) Cat6 UTP',
    standard: 'TIA/EIA-568A ↔ 568B',
    maxLengthM: 100,
    media: 'copper',
    color: '#94a3b8',
    velocity: 198_000,
    description: "Bir xil qurilmalarni ulaydi: Switch↔Switch, PC↔PC, Router↔PC (Auto-MDIX bo'lmasa kerak).",
  },
  'fiber-mm': {
    type: 'fiber-mm',
    label: 'Optika Multimode OM3 (1000BASE-SX)',
    standard: '850nm, LC-LC',
    maxLengthM: 550,
    media: 'fiber',
    color: '#f97316',
    velocity: 204_000,
    description: "Bino ichidagi magistral liniyalar uchun. 1 Gbit/s da 550 m gacha.",
  },
  'fiber-sm': {
    type: 'fiber-sm',
    label: 'Optika Singlemode OS2 (1000BASE-LX)',
    standard: '1310nm, LC-LC',
    maxLengthM: 10_000,
    media: 'fiber',
    color: '#eab308',
    velocity: 204_000,
    description: "Binolar orasidagi uzoq masofali ulanishlar — 10 km gacha.",
  },
  console: {
    type: 'console',
    label: 'Konsol (Rollover) kabeli',
    standard: 'RJ45 ↔ DB9 RS-232, 9600 8N1',
    maxLengthM: 15,
    media: 'console',
    color: '#38bdf8',
    velocity: 198_000,
    description: "Kompyuterning RS-232 portidan router/switch Console portiga — IP sozlanmagan qurilmani boshqarish uchun.",
  },
};

export interface Link {
  kind: 'cable' | 'wireless';
  id: string;
  peerOf(p: Port): Port | null;
  transmit(from: Port, frame: EthernetFrame, serMs?: number): void;
  ports(): Port[];
}

let cableCounter = 1;

export class Cable implements Link {
  kind = 'cable' as const;
  id: string;
  type: CableType;
  a: Port;
  b: Port;
  /** null — qurilmalar orasidagi masofadan avtomatik (+20% zaxira) */
  manualLengthM: number | null = null;
  net: Network;

  constructor(net: Network, type: CableType, a: Port, b: Port, id?: string) {
    this.net = net;
    this.type = type;
    this.a = a;
    this.b = b;
    this.id = id ?? `c${cableCounter++}`;
    const n = Number(this.id.replace(/\D/g, ''));
    if (n >= cableCounter) cableCounter = n + 1;
  }

  get spec() {
    return CABLE_SPECS[this.type];
  }

  get lengthM(): number {
    if (this.manualLengthM !== null) return this.manualLengthM;
    const da = this.a.device;
    const db = this.b.device;
    const d = Math.hypot(da.x - db.x, da.y - db.y);
    return Math.max(1, Math.round(d * 1.2 + 2));
  }

  ports() {
    return [this.a, this.b];
  }

  peerOf(p: Port): Port | null {
    return p === this.a ? this.b : p === this.b ? this.a : null;
  }

  /** Kabel fizik jihatdan yaroqlimi? (turi, uzunligi, MDI/MDI-X) */
  check(): { ok: boolean; reason?: string } {
    const s = this.spec;
    const { a, b } = this;
    if (s.media === 'console') {
      if (a.media !== 'console' || b.media !== 'console') return { ok: false, reason: 'Konsol kabeli faqat Console/RS-232 portlarga ulanadi' };
      return { ok: true };
    }
    if (a.media !== s.media || b.media !== s.media) {
      return { ok: false, reason: `${s.media === 'fiber' ? 'Optik' : 'Mis'} kabel ${a.media !== s.media ? a.name : b.name} portiga mos emas` };
    }
    if (this.lengthM > s.maxLengthM) return { ok: false, reason: `Kabel uzunligi ${this.lengthM} m — ${s.standard} uchun maksimal ${s.maxLengthM} m` };
    if (s.media === 'copper') {
      // Auto-MDIX: kamida bitta tomonda bo'lsa, istalgan kabel ishlaydi. Gigabit (1000BASE-T) uchun ham majburiy.
      const auto = a.autoMdix || b.autoMdix;
      if (!auto) {
        const same = a.mdi === b.mdi;
        if (same && this.type === 'copper-straight') return { ok: false, reason: `Bir xil turdagi portlar (${a.mdi}↔${b.mdi}) uchun kross kabel kerak (Auto-MDIX o'chirilgan)` };
        if (!same && this.type === 'copper-cross') return { ok: false, reason: `Turli portlar (${a.mdi}↔${b.mdi}) uchun to'g'ri kabel kerak (Auto-MDIX o'chirilgan)` };
      }
    }
    return { ok: true };
  }

  get propagationMs() {
    return this.lengthM / this.spec.velocity;
  }

  transmit(from: Port, frame: EthernetFrame, serMs = 0) {
    const to = this.peerOf(from);
    if (!to) return;
    const delay = serMs + this.propagationMs + to.device.procDelayMs;
    const net = this.net;
    const t0 = net.sim.now;
    net.emitTx(from, to, frame, t0, t0 + delay);
    net.sim.schedule(
      delay,
      () => {
        if (to.link !== this || !to.operUp || !from.operUp) return;
        to.account(frame, false);
        net.deliver(to, frame);
      },
      'frame',
    );
  }
}

// ------------------------------------------------------------------ Wi-Fi

export type WifiBand = '2.4GHz' | '5GHz';
export type WifiSecurity = 'open' | 'wpa2-psk' | 'wpa3-sae' | 'wpa2-enterprise';

/** Kirish nuqtasi radiosi — umumiy (half-duplex) muhit, har bir SSID uchun BSS */
export class WirelessMedium implements Link {
  kind = 'wireless' as const;
  id: string;
  apPort: Port;
  clients = new Map<Port, { rssi: number; rateMbps: number; since: number }>();
  busyUntil = 0;
  net: Network;
  /** Kanalda boshqa AP'lar bilan to'qnashuv (co-channel interference) koeffitsienti */
  contention = 1;

  constructor(net: Network, apPort: Port) {
    this.net = net;
    this.apPort = apPort;
    this.id = `w-${apPort.device.id}-${apPort.name}`;
  }

  ports() {
    return [this.apPort, ...this.clients.keys()];
  }

  peerOf(p: Port): Port | null {
    return p === this.apPort ? null : this.apPort;
  }

  transmit(from: Port, frame: EthernetFrame) {
    const net = this.net;
    const now = net.sim.now;
    const targets: Port[] = [];
    let rate: number;
    if (from === this.apPort) {
      if (frame.dst === 'ff:ff:ff:ff:ff:ff' || (parseInt(frame.dst.slice(0, 2), 16) & 1) === 1) {
        for (const c of this.clients.keys()) targets.push(c);
        rate = 12; // broadcast/multicast past (basic rate) tezlikda yuboriladi
      } else {
        for (const c of this.clients.keys()) if (c.mac === frame.dst) targets.push(c);
        if (!targets.length) {
          // noma'lum mijoz — radio orqali yuborilmaydi
          return;
        }
        rate = this.clients.get(targets[0])!.rateMbps;
      }
    } else {
      const info = this.clients.get(from);
      if (!info) return;
      targets.push(this.apPort);
      rate = info.rateMbps;
    }
    // 802.11 samaradorligi ~60% (ACK, DIFS, backoff), umumiy muhit
    const bytes = frameWireSize(frame) + 40;
    const airMs = ((bytes * 8) / (rate * 1000 * 0.6)) * this.contention + 0.05;
    const backlog = this.busyUntil - now;
    if (backlog > 80) {
      from.counters.outDrops++;
      net.emitDrop(from, frame, "Wi-Fi kanal band (airtime tugagan)");
      return;
    }
    const start = Math.max(now, this.busyUntil);
    this.busyUntil = start + airMs;
    for (const to of targets) {
      const delay = this.busyUntil - now + to.device.procDelayMs;
      net.emitTx(from, to, frame, now, now + delay);
      net.sim.schedule(
        delay,
        () => {
          if (to !== this.apPort && !this.clients.has(to)) return;
          if (from !== this.apPort && !this.clients.has(from)) return;
          to.account(frame, false);
          net.deliver(to, frame);
        },
        'frame',
      );
    }
  }
}

/** Signal kuchi (dBm) — log-distance path loss modeli, devorlar hisobga olinmagan */
export function wifiRssi(txPowerDbm: number, distanceM: number, band: WifiBand, walls = 0): number {
  const d = Math.max(1, distanceM);
  const f = band === '2.4GHz' ? 2437 : 5200;
  // FSPL(1m) + 10*n*log10(d), n=3 (ofis)
  const fspl1 = 20 * Math.log10(f) - 27.55;
  const loss = fspl1 + 10 * 3.0 * Math.log10(d) + walls * (band === '2.4GHz' ? 4 : 6);
  return txPowerDbm + 2 /* antenna */ - loss;
}

/** RSSI dan PHY tezlik (802.11n 2.4GHz 2x2 / 802.11ac 5GHz 2x2) */
export function wifiRate(rssi: number, band: WifiBand): number {
  const table24: [number, number][] = [
    [-64, 144],
    [-66, 130],
    [-68, 117],
    [-70, 86],
    [-74, 58],
    [-77, 43],
    [-79, 29],
    [-82, 14],
    [-85, 6],
  ];
  const table5: [number, number][] = [
    [-57, 867],
    [-60, 780],
    [-63, 585],
    [-66, 390],
    [-70, 234],
    [-74, 117],
    [-78, 58],
    [-82, 29],
    [-85, 6],
  ];
  const t = band === '2.4GHz' ? table24 : table5;
  for (const [th, r] of t) if (rssi >= th) return r;
  return 0;
}
