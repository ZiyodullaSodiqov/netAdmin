// Fizik port (interfeys) — RJ45 mis, SFP optika, konsol, Wi-Fi radio.
import type { Device } from './device';
import type { Link } from './link';
import { EthernetFrame, frameWireSize } from './packets';
import { MAC } from './util';

export type PortMedia = 'copper' | 'fiber' | 'console' | 'wireless';

export type SwitchportMode = 'access' | 'trunk' | 'dynamic auto' | 'dynamic desirable';

export interface SwitchportConfig {
  mode: SwitchportMode;
  accessVlan: number;
  voiceVlan: number | null;
  nativeVlan: number;
  allowedVlans: Set<number> | 'all';
  nonegotiate: boolean;
  /** Hisoblangan (DTP natijasi) */
  operMode: 'access' | 'trunk';
  portfast: boolean;
  bpduGuard: boolean;
  stpCost: number | null;
  stpPortPriority: number;
  portSecurity: {
    enabled: boolean;
    maximum: number;
    violation: 'shutdown' | 'restrict' | 'protect';
    sticky: boolean;
    secureMacs: MAC[];
    violations: number;
  };
}

export function defaultSwitchport(mode: SwitchportMode = 'dynamic auto'): SwitchportConfig {
  return {
    mode,
    accessVlan: 1,
    voiceVlan: null,
    nativeVlan: 1,
    allowedVlans: 'all',
    nonegotiate: false,
    operMode: 'access',
    portfast: false,
    bpduGuard: false,
    stpCost: null,
    stpPortPriority: 128,
    portSecurity: { enabled: false, maximum: 1, violation: 'shutdown', sticky: false, secureMacs: [], violations: 0 },
  };
}

export interface PortCounters {
  rxFrames: number;
  txFrames: number;
  rxBytes: number;
  txBytes: number;
  rxBroadcast: number;
  txBroadcast: number;
  outDrops: number;
  inErrors: number;
  crc: number;
  collisions: number;
}

export function emptyCounters(): PortCounters {
  return { rxFrames: 0, txFrames: 0, rxBytes: 0, txBytes: 0, rxBroadcast: 0, txBroadcast: 0, outDrops: 0, inErrors: 0, crc: 0, collisions: 0 };
}

export interface PortSpec {
  name: string; // GigabitEthernet0/1
  media: PortMedia;
  speeds: number[]; // Mbit/s
  /** Qurilma turi bo'yicha: host/router — MDI, switch — MDI-X */
  mdi: 'MDI' | 'MDIX';
  autoMdix: boolean;
  /** PoE manba (PSE) — maksimal Vt */
  poeMaxW?: number;
  /** PoE iste'molchi (PD) */
  poePd?: boolean;
  /** Konsol: RS-232 (DB9 kompyuterda) yoki RJ45 (routerda) */
  label?: string;
}

export class Port {
  readonly device: Device;
  readonly name: string;
  readonly media: PortMedia;
  readonly speeds: number[];
  readonly mdi: 'MDI' | 'MDIX';
  autoMdix: boolean;
  readonly poeMaxW: number;
  readonly poePd: boolean;
  label?: string;
  mac: MAC;
  link: Link | null = null;

  /** `shutdown` / `no shutdown` */
  adminUp = true;
  errDisabled: string | null = null;
  description = '';
  speedSetting: 'auto' | number = 'auto';
  duplexSetting: 'auto' | 'full' | 'half' = 'auto';
  poeEnabled = true; // power inline auto/never
  /** Hisoblangan PoE quvvati (Vt) */
  poeDrawW = 0;

  switchport: SwitchportConfig | null = null;
  /** 802.1Q port QoS — ustuvor navbat (ovoz uchun) */
  qosTrust = false;

  counters: PortCounters = emptyCounters();
  /** Hisoblangan holatlar */
  operUp = false;
  operSpeed = 0; // Mbit/s
  lastChange = 0;
  /** LED: oxirgi faollik vaqti */
  lastActivity = -1e9;
  /** Kanal band bo'ladigan vaqt (serializatsiya) */
  busyUntil = 0;
  private queue: { frame: EthernetFrame; prio: boolean }[] = [];
  private transmitting = false;
  queueLimit = 256;
  /** Statistikalar: har soniyadagi bit/s */
  rateIn = 0;
  rateOut = 0;
  private winIn = 0;
  private winOut = 0;

  constructor(device: Device, spec: PortSpec, mac: MAC) {
    this.device = device;
    this.name = spec.name;
    this.media = spec.media;
    this.speeds = spec.speeds;
    this.mdi = spec.mdi;
    this.autoMdix = spec.autoMdix;
    this.poeMaxW = spec.poeMaxW ?? 0;
    this.poePd = !!spec.poePd;
    this.label = spec.label;
    this.mac = mac;
  }

  get shortName(): string {
    return shortIfName(this.name);
  }

  get maxSpeed() {
    return Math.max(...this.speeds);
  }

  /** Portga ulangan boshqa port(lar) */
  get peer(): Port | null {
    return this.link ? this.link.peerOf(this) : null;
  }

  get statusText(): 'up' | 'down' | 'administratively down' | 'err-disabled' {
    if (this.errDisabled) return 'err-disabled';
    if (!this.adminUp) return 'administratively down';
    return this.operUp ? 'up' : 'down';
  }

  get queueDepth() {
    return this.queue.length;
  }

  /** Kadrni jo'natish: navbatga qo'yish va serializatsiya */
  send(frame: EthernetFrame) {
    if (!this.operUp || !this.link) {
      this.counters.outDrops++;
      return;
    }
    if (this.media === 'wireless') {
      // Radio uchun alohida navbat — muhit (medium) boshqaradi
      this.link.transmit(this, frame);
      this.account(frame, true);
      return;
    }
    const prio = this.isPriority(frame);
    if (this.queue.length >= this.queueLimit) {
      this.counters.outDrops++;
      this.device.net.emitDrop(this, frame, 'Chiqish navbati to\'lgan (output drop)');
      return;
    }
    if (prio) {
      // ustuvor kadrlar oddiylar oldiga qo'yiladi
      const idx = this.queue.findIndex((q) => !q.prio);
      if (idx === -1) this.queue.push({ frame, prio });
      else this.queue.splice(idx, 0, { frame, prio });
    } else this.queue.push({ frame, prio });
    if (!this.transmitting) this.startNext();
  }

  private isPriority(f: EthernetFrame): boolean {
    if (!this.device.qosEnabled) return false;
    if (f.cos !== undefined && f.cos >= 5) return true;
    if (f.payload.kind === 'ipv4' && f.payload.dscp >= 40) return true;
    if (f.payload.kind === 'bpdu') return true;
    return false;
  }

  private startNext() {
    const item = this.queue.shift();
    if (!item) {
      this.transmitting = false;
      return;
    }
    if (!this.operUp || !this.link) {
      this.queue = [];
      this.transmitting = false;
      return;
    }
    this.transmitting = true;
    const net = this.device.net;
    const bytes = frameWireSize(item.frame);
    const serMs = (bytes * 8) / (this.operSpeed * 1000); // Mbit/s -> bit/ms = speed*1000
    const start = net.sim.now;
    this.busyUntil = start + serMs;
    this.account(item.frame, true);
    this.link.transmit(this, item.frame, serMs);
    net.sim.schedule(serMs, () => this.startNext());
  }

  account(f: EthernetFrame, tx: boolean) {
    const bytes = frameWireSize(f) - 20;
    const bc = f.dst === 'ff:ff:ff:ff:ff:ff';
    if (tx) {
      this.counters.txFrames++;
      this.counters.txBytes += bytes;
      if (bc) this.counters.txBroadcast++;
      this.winOut += bytes * 8;
    } else {
      this.counters.rxFrames++;
      this.counters.rxBytes += bytes;
      if (bc) this.counters.rxBroadcast++;
      this.winIn += bytes * 8;
    }
    this.lastActivity = this.device.net.sim.now;
  }

  /** Har soniyada chaqiriladi — o'tkazuvchanlik statistikasi */
  sampleRates(dtMs: number) {
    const a = 0.5;
    this.rateIn = this.rateIn * (1 - a) + (this.winIn * 1000) / dtMs * a;
    this.rateOut = this.rateOut * (1 - a) + (this.winOut * 1000) / dtMs * a;
    this.winIn = 0;
    this.winOut = 0;
  }

  flushQueue() {
    this.queue = [];
    this.transmitting = false;
  }

  resetCounters() {
    this.counters = emptyCounters();
  }
}

// ------------------------------------------------------------------ interfeys nomlari

const IF_PREFIXES: [string, string][] = [
  ['TenGigabitEthernet', 'Te'],
  ['GigabitEthernet', 'Gi'],
  ['FastEthernet', 'Fa'],
  ['Ethernet', 'Eth'],
  ['Serial', 'Se'],
  ['Loopback', 'Lo'],
  ['Vlan', 'Vlan'],
  ['Port-channel', 'Po'],
  ['Wireless', 'Wlan'],
  ['Dot11Radio', 'Do'],
];

export function shortIfName(name: string): string {
  for (const [long, short] of IF_PREFIXES) {
    if (name.startsWith(long)) return short + name.slice(long.length);
  }
  return name;
}

/** "g0/1", "gi 0/1", "fa0/1.10", "vlan 10", "lo0" -> to'liq nom */
export function expandIfName(input: string): string | null {
  const s = input.replace(/\s+/g, '').toLowerCase();
  const m = s.match(/^([a-z-]+)([\d/.:]+)$/);
  if (!m) return null;
  const [, pfx, num] = m;
  const table: [string, string, number][] = [
    // [to'liq, kalit, minimal prefiks uzunligi]
    ['TenGigabitEthernet', 'tengigabitethernet', 2],
    ['GigabitEthernet', 'gigabitethernet', 1],
    ['FastEthernet', 'fastethernet', 1],
    ['Ethernet', 'ethernet', 1],
    ['Serial', 'serial', 1],
    ['Loopback', 'loopback', 1],
    ['Vlan', 'vlan', 1],
    ['Port-channel', 'port-channel', 2],
    ['Dot11Radio', 'dot11radio', 2],
  ];
  // "te" — TenGig, "e" — Ethernet
  if (pfx === 'te' || pfx === 'ten') return 'TenGigabitEthernet' + num;
  if (pfx === 'po') return 'Port-channel' + num;
  for (const [full, key, min] of table) {
    if (pfx.length >= min && key.startsWith(pfx)) {
      if (full === 'Ethernet' && pfx === 'e') return full + num;
      if (full === 'TenGigabitEthernet') continue;
      if (full === 'Port-channel') continue;
      return full + num;
    }
  }
  return null;
}
