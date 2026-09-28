// Tarmoq: qurilmalar, kabellar, quvvat (PoE), link holatlari, Wi-Fi assotsiatsiya.
import { Simulator } from './sim';
import type { Device } from './device';
import type { Port } from './port';
import { Cable, CableType, CABLE_SPECS, WirelessMedium } from './link';
import type { EthernetFrame } from './packets';

export interface TxRecord {
  id: number;
  from: Port;
  to: Port;
  frame: EthernetFrame;
  t0: number;
  t1: number;
}

export interface DropRecord {
  port: Port;
  frame: EthernetFrame;
  reason: string;
  t: number;
}

export type NetEvent =
  | { type: 'tx'; rec: TxRecord }
  | { type: 'drop'; rec: DropRecord }
  | { type: 'topology' }
  | { type: 'link'; port: Port; up: boolean };

let txCounter = 1;

export class Network {
  sim = new Simulator();
  devices: Device[] = [];
  cables: Cable[] = [];
  /** AP radio porti -> muhit */
  wireless = new Map<Port, WirelessMedium>();
  private listeners = new Set<(e: NetEvent) => void>();
  /** Kadrlarni yozib olish (Simulyatsiya rejimi) */
  capture = false;
  version = 0;
  private tickStop: (() => void) | null = null;
  private lastTick = 0;
  private refreshing = false;
  private refreshQueued = false;
  /** Devorlar (metrlarda) — Wi-Fi signalini so'ndiradi; keyinchalik 3D bino rejalaridan olinadi */
  walls: { x1: number; y1: number; x2: number; y2: number; material?: 'concrete' | 'drywall' | 'glass' }[] = [];

  /** Ikki qurilma orasidagi devorlar soni */
  wallsBetween(a: Device, b: Device): number {
    let n = 0;
    for (const w of this.walls) if (segmentsIntersect(a.x, a.y, b.x, b.y, w.x1, w.y1, w.x2, w.y2)) n += w.material === 'concrete' ? 2 : w.material === 'glass' ? 0.5 : 1;
    return n;
  }

  constructor() {
    this.startTicker();
  }

  on(fn: (e: NetEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: NetEvent) {
    for (const l of this.listeners) l(e);
  }

  bump() {
    this.version++;
  }

  // -------------------------------------------------------------- qurilmalar

  addDevice<T extends Device>(d: T, x?: number, y?: number): T {
    d.net = this;
    if (x !== undefined) d.x = x;
    if (y !== undefined) d.y = y;
    this.devices.push(d);
    this.refresh();
    this.emit({ type: 'topology' });
    return d;
  }

  removeDevice(d: Device) {
    for (const c of [...this.cables]) if (c.a.device === d || c.b.device === d) this.disconnect(c);
    d.powerSwitch = false;
    this.refresh();
    d.cancelAllTimers();
    this.devices = this.devices.filter((x) => x !== d);
    for (const [p, m] of [...this.wireless]) if (p.device === d) this.wireless.delete(p);
    for (const m of this.wireless.values()) for (const c of [...m.clients.keys()]) if (c.device === d) m.clients.delete(c);
    this.refresh();
    this.emit({ type: 'topology' });
  }

  device(nameOrId: string): Device | undefined {
    return this.devices.find((d) => d.id === nameOrId) ?? this.devices.find((d) => d.hostname === nameOrId) ?? this.devices.find((d) => d.hostname.toLowerCase() === nameOrId.toLowerCase());
  }

  // -------------------------------------------------------------- kabellar

  /** Ikki portni kabel bilan ulash. Xato bo'lsa matn qaytaradi. */
  connect(a: Port, b: Port, type?: CableType, id?: string): Cable | string {
    if (a === b) return "Portni o'ziga ulab bo'lmaydi";
    if (a.link || b.link) return `Port band: ${a.link ? a.device.hostname + ' ' + a.name : b.device.hostname + ' ' + b.name}`;
    if (a.media === 'wireless' || b.media === 'wireless') return 'Simsiz interfeysga kabel ulanmaydi';
    const t = type ?? autoCableType(a, b);
    if (!t) return `Bu portlarni kabel bilan ulab bo'lmaydi (${a.media} ↔ ${b.media})`;
    const spec = CABLE_SPECS[t];
    // Fizik ulagich mos kelmasa ulab bo'lmaydi (RJ45 optika portiga kirmaydi)
    const plugOk = (p: Port) => (spec.media === 'console' ? p.media === 'console' : p.media === spec.media);
    if (!plugOk(a) || !plugOk(b)) return `${spec.label} ${!plugOk(a) ? a.name : b.name} portiga fizik jihatdan kirmaydi`;
    const c = new Cable(this, t, a, b, id);
    a.link = c;
    b.link = c;
    this.cables.push(c);
    this.refresh();
    this.emit({ type: 'topology' });
    return c;
  }

  disconnect(c: Cable) {
    c.a.link = null;
    c.b.link = null;
    this.cables = this.cables.filter((x) => x !== c);
    this.refresh();
    this.emit({ type: 'topology' });
  }

  // -------------------------------------------------------------- holatlarni hisoblash

  /** Quvvat (PoE bilan) va barcha link holatlarini qayta hisoblaydi. Har qanday o'zgarishdan keyin chaqiriladi. */
  refresh() {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      let guard = 0;
      do {
        this.refreshQueued = false;
        this.refreshPower();
        this.refreshLinks();
      } while (this.refreshQueued && guard++ < 5);
    } finally {
      this.refreshing = false;
    }
    this.bump();
  }

  private refreshPower() {
    // 1) AC orqali ishlaydigan qurilmalar
    const want = new Map<Device, boolean>();
    for (const d of this.devices) want.set(d, d.powerSwitch && d.acPower);
    // 2) PoE: PSE portdan PD qurilmaga (PSE qurilma o'zi yoqiq bo'lishi kerak)
    const budgetUsed = new Map<Device, number>();
    for (const p of this.devices.flatMap((d) => d.ports)) p.poeDrawW = 0;
    for (const d of this.devices) {
      d.poweredViaPoe = false;
      if (!d.powerSwitch || want.get(d) || d.poeRequiredW <= 0) continue;
      for (const pd of d.ports) {
        if (!pd.poePd || !pd.link || pd.link.kind !== 'cable') continue;
        const pse = pd.peer!;
        const psed = pse.device;
        if (pse.poeMaxW <= 0 || !pse.poeEnabled || !pse.adminUp || pse.errDisabled || !want.get(psed)) continue;
        if ((pd.link as Cable).spec.media !== 'copper') continue;
        const budget = (psed as any).poeBudgetW ?? 370;
        const used = budgetUsed.get(psed) ?? 0;
        if (used + d.poeRequiredW > budget || d.poeRequiredW > pse.poeMaxW) continue;
        budgetUsed.set(psed, used + d.poeRequiredW);
        pse.poeDrawW = d.poeRequiredW;
        want.set(d, true);
        d.poweredViaPoe = true;
        break;
      }
    }
    for (const d of this.devices) {
      const on = !!want.get(d);
      if (on !== d.powered) {
        d.powered = on;
        if (on) {
          d.bootedAt = this.sim.now;
          d.onPowerOn();
        } else {
          d.cancelAllTimers();
          for (const p of d.ports) p.flushQueue();
          d.onPowerOff();
        }
      }
    }
  }

  private refreshLinks() {
    const changes: [Port, boolean][] = [];
    for (const d of this.devices) {
      for (const p of d.ports) {
        const { up, speed } = this.computePortState(p);
        if (up !== p.operUp) {
          p.operUp = up;
          p.lastChange = this.sim.now;
          changes.push([p, up]);
          if (!up) p.flushQueue();
        }
        p.operSpeed = up ? speed : 0;
      }
    }
    for (const [p, up] of changes) {
      if (p.device.powered) p.device.onLinkChange(p, up);
      this.emit({ type: 'link', port: p, up });
    }
  }

  private computePortState(p: Port): { up: boolean; speed: number } {
    const d = p.device;
    if (!d.powered || !p.adminUp || p.errDisabled) return { up: false, speed: 0 };
    if (p.media === 'wireless') {
      if (this.wireless.has(p)) return { up: true, speed: 0 };
      for (const m of this.wireless.values()) {
        const info = m.clients.get(p);
        if (info) return { up: true, speed: info.rateMbps };
      }
      return { up: false, speed: 0 };
    }
    const link = p.link;
    if (!link || link.kind !== 'cable') return { up: false, speed: 0 };
    const cable = link as Cable;
    const peer = cable.peerOf(p)!;
    if (!peer.device.powered || !peer.adminUp || peer.errDisabled) return { up: false, speed: 0 };
    if (!cable.check().ok) return { up: false, speed: 0 };
    if (p.media === 'console') return { up: true, speed: 0 };
    // tezlikni kelishish (autonegotiation)
    const allowed = (x: Port) => (x.speedSetting === 'auto' ? x.speeds : x.speeds.filter((s) => s === x.speedSetting));
    const a = allowed(p);
    const b = allowed(peer);
    const common = a.filter((s) => b.includes(s));
    if (!common.length) return { up: false, speed: 0 };
    return { up: true, speed: Math.max(...common) };
  }

  // -------------------------------------------------------------- kadr yetkazish

  deliver(port: Port, frame: EthernetFrame) {
    const d = port.device;
    if (!d.powered) return;
    frame.hops = (frame.hops ?? 0) + 1;
    if (frame.hops > 64) return; // xavfsizlik chegarasi
    d.receive(port, frame);
  }

  emitTx(from: Port, to: Port, frame: EthernetFrame, t0: number, t1: number) {
    if (!this.capture && this.listeners.size === 0) return;
    this.emit({ type: 'tx', rec: { id: txCounter++, from, to, frame, t0, t1 } });
  }

  emitDrop(port: Port, frame: EthernetFrame, reason: string) {
    if (!this.capture && this.listeners.size === 0) return;
    this.emit({ type: 'drop', rec: { port, frame, reason, t: this.sim.now } });
  }

  // -------------------------------------------------------------- davriy ish

  private startTicker() {
    const loop = () => {
      const dt = this.sim.now - this.lastTick || 1000;
      this.lastTick = this.sim.now;
      for (const d of this.devices) {
        for (const p of d.ports) p.sampleRates(dt);
        if (d.powered) d.tick1s();
      }
      this.updateWireless();
      this.sim.schedule(1000, loop, 'tick');
    };
    this.sim.schedule(1000, loop, 'tick');
  }

  /** Wi-Fi: mijozlarni AP larga ulash (signal kuchi, SSID, parol) */
  updateWireless() {
    let changed = false;
    const aps = this.devices.filter((d) => d.powered && typeof (d as any).wifiRadios === 'function');
    // AP radio muhitlarini yaratish/yangilash
    const radios: { port: Port; cfg: any }[] = [];
    for (const ap of aps) {
      for (const r of (ap as any).wifiRadios() as { port: Port; cfg: any }[]) {
        radios.push(r);
        if (!this.wireless.has(r.port)) this.wireless.set(r.port, new WirelessMedium(this, r.port));
      }
    }
    for (const [p, m] of [...this.wireless]) {
      const alive = radios.find((r) => r.port === p);
      if (!alive || !p.device.powered || !p.adminUp) {
        for (const c of m.clients.keys()) {
          (c.device as any).onWifiDisassociated?.(c);
        }
        m.clients.clear();
        this.wireless.delete(p);
        changed = true;
      }
    }
    // kanal to'qnashuvlari
    for (const r of radios) {
      const m = this.wireless.get(r.port)!;
      const same = radios.filter((o) => o !== r && o.cfg.band === r.cfg.band && channelsOverlap(o.cfg.channel, r.cfg.channel, r.cfg.band) && dist(o.port.device, r.port.device) < 60);
      m.contention = 1 + same.length * 0.6;
    }
    // mijozlar
    for (const d of this.devices) {
      const fn = (d as any).wifiClients as undefined | (() => { port: Port; cfg: any }[]);
      if (!fn || !d.powered) continue;
      for (const c of fn.call(d)) {
        const cur = [...this.wireless.values()].find((m) => m.clients.has(c.port));
        const res = (d as any).chooseAp(c, radios) as { port: Port; rssi: number; rate: number } | null;
        if (cur && (!res || res.port !== cur.apPort)) {
          cur.clients.delete(c.port);
          (d as any).onWifiDisassociated?.(c.port);
          changed = true;
        }
        if (res) {
          const m = this.wireless.get(res.port)!;
          const info = m.clients.get(c.port);
          if (info) {
            info.rssi = res.rssi;
            info.rateMbps = res.rate;
          } else {
            m.clients.set(c.port, { rssi: res.rssi, rateMbps: res.rate, since: this.sim.now });
            changed = true;
            (d as any).onWifiAssociated?.(c.port, res.port);
          }
        }
      }
    }
    if (changed) this.refresh();
  }

  /** Mijoz porti qaysi AP ga ulangan */
  wifiAssociation(p: Port): { medium: WirelessMedium; rssi: number; rateMbps: number } | null {
    for (const m of this.wireless.values()) {
      const i = m.clients.get(p);
      if (i) return { medium: m, rssi: i.rssi, rateMbps: i.rateMbps };
    }
    return null;
  }

  stop() {
    this.tickStop?.();
  }
}

function segmentsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) {
  const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (d === 0) return false;
  const u = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
  const v = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
  return u > 0 && u < 1 && v > 0 && v < 1;
}

function dist(a: Device, b: Device) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function channelsOverlap(a: number, b: number, band: string) {
  if (band === '5GHz') return a === b;
  return Math.abs(a - b) < 5;
}

export function autoCableType(a: Port, b: Port): CableType | null {
  if (a.media === 'console' && b.media === 'console') return 'console';
  if (a.media === 'fiber' && b.media === 'fiber') return 'fiber-mm';
  if (a.media === 'copper' && b.media === 'copper') {
    return a.mdi === b.mdi ? 'copper-cross' : 'copper-straight';
  }
  return null;
}
