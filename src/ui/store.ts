// UI holati: tarmoq, simulyatsiya sikli (real vaqt / qadamma-qadam), tanlangan qurilma va asbob.
import { useSyncExternalStore } from 'react';
import { Network, TxRecord } from '../engine/network';
import type { Device } from '../engine/device';
import type { Port } from '../engine/port';
import type { CableType } from '../engine/link';
import { buildScenario, SCENARIOS } from '../engine/scenarios';
import { createDevice, DeviceType, nextLabel, saveTopology, loadTopology, TopologyFile } from '../engine/factory';
import { describeFrame } from '../engine/packets';

export type Tool = { kind: 'select' } | { kind: 'cable'; cable: CableType | 'auto' } | { kind: 'delete' } | { kind: 'pdu' } | { kind: 'place'; type: DeviceType };

export interface SimEventRow {
  id: number;
  t: number;
  from: string;
  to: string;
  proto: string;
  info: string;
  rec: TxRecord;
}

export interface Anim {
  rec: TxRecord;
  start: number; // real ms
  dur: number; // real ms
  proto: string;
}

export const PROTO_COLORS: Record<string, string> = {
  ICMP: '#22c55e',
  ARP: '#eab308',
  DHCP: '#a855f7',
  DNS: '#06b6d4',
  HTTP: '#3b82f6',
  HTTPS: '#6366f1',
  TCP: '#64748b',
  UDP: '#94a3b8',
  STP: '#f97316',
  RSTP: '#f97316',
  CDP: '#78716c',
  DTP: '#a8a29e',
  OSPF: '#ef4444',
  SCCP: '#ec4899',
  RTP: '#f472b6',
  Telnet: '#14b8a6',
  SSH: '#0d9488',
  Syslog: '#84cc16',
  FTP: '#0ea5e9',
};

export const ALL_PROTOS = ['ICMP', 'ARP', 'DHCP', 'DNS', 'HTTP', 'HTTPS', 'TCP', 'UDP', 'STP', 'RSTP', 'CDP', 'DTP', 'OSPF', 'SCCP', 'RTP', 'Telnet', 'SSH', 'Syslog'];

class Store {
  net: Network;
  scenarioId = 'office';
  title = '';
  running = true;
  speed = 1;
  mode: 'realtime' | 'simulation' = 'realtime';
  tool: Tool = { kind: 'select' };
  selected: Device | null = null;
  windows: { id: string; device: Device; tab?: string }[] = [];
  cableStart: { device: Device; port: Port } | null = null;
  pduStart: Device | null = null;
  toast: { text: string; kind: 'info' | 'error'; at: number } | null = null;
  view = { x: 0, y: 0, scale: 12 };
  showCoverage = true;
  showIps = true;
  showLabels = true;
  // simulyatsiya rejimi
  simEvents: SimEventRow[] = [];
  simFilter = new Set(['ICMP', 'ARP', 'DHCP', 'DNS', 'HTTP', 'HTTPS', 'TCP', 'SCCP', 'Telnet', 'SSH', 'OSPF']);
  simSelected: SimEventRow | null = null;
  anims: Anim[] = [];
  lagging = false;
  private listeners = new Set<() => void>();
  private version = 0;
  private lastFrame = 0;
  private unsubNet: (() => void) | null = null;
  private pendingTx: TxRecord[] = [];
  private simBusyUntil = 0;
  private eventCounter = 1;

  constructor() {
    this.net = new Network();
    this.loadScenario('office');
    requestAnimationFrame((t) => this.frame(t));
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = () => this.version;

  emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  private attach(net: Network) {
    this.unsubNet?.();
    this.net = net;
    this.unsubNet = net.on((e) => {
      if (e.type === 'tx') this.onTx(e.rec);
    });
    this.selected = null;
    this.windows = [];
    this.simEvents = [];
    this.anims = [];
    this.pendingTx = [];
    this.fitView();
  }

  loadScenario(id: string) {
    this.scenarioId = id;
    const s = SCENARIOS.find((x) => x.id === id);
    this.title = s?.title ?? '';
    const net = buildScenario(id);
    this.attach(net);
    // Boshlang'ich holat: STP va DHCP yaqinlashishi uchun vaqtni oldinga siljitamiz
    if (id !== 'empty') net.sim.runFor(1000);
    this.emit();
  }

  newEmpty() {
    this.loadScenario('empty');
  }

  save(): TopologyFile {
    return saveTopology(this.net, this.title || 'Topologiya');
  }

  load(file: TopologyFile) {
    const net = loadTopology(file);
    this.title = file.name;
    this.scenarioId = '';
    this.attach(net);
    this.emit();
  }

  fitView() {
    const ds = this.net.devices;
    if (!ds.length) {
      this.view = { x: 0, y: 0, scale: 12 };
      return;
    }
    const xs = ds.map((d) => d.x);
    const ys = ds.map((d) => d.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const w = Math.max(40, Math.max(...xs) - Math.min(...xs) + 20);
    const h = Math.max(30, Math.max(...ys) - Math.min(...ys) + 20);
    const vw = (typeof window !== 'undefined' ? window.innerWidth - 560 : 1000) || 1000;
    const vh = (typeof window !== 'undefined' ? window.innerHeight - 140 : 700) || 700;
    const scale = Math.max(4, Math.min(20, Math.min(vw / w, vh / h)));
    this.view = { x: cx, y: cy, scale };
  }

  notify(text: string, kind: 'info' | 'error' = 'info') {
    this.toast = { text, kind, at: performance.now() };
    this.emit();
  }

  // ------------------------------------------------------------- simulyatsiya sikli
  private frame(t: number) {
    const dt = Math.min(100, t - (this.lastFrame || t));
    this.lastFrame = t;
    if (this.running) {
      if (this.mode === 'realtime') {
        const target = this.net.sim.now + dt * this.speed;
        const n = this.net.sim.runUntil(target, 300_000);
        this.lagging = n >= 300_000;
      } else this.simStep(t);
    }
    // eski animatsiyalarni tozalash
    this.anims = this.anims.filter((a) => t - a.start < a.dur);
    if (this.toast && t - this.toast.at > 4000) this.toast = null;
    this.emit();
    requestAnimationFrame((tt) => this.frame(tt));
  }

  private onTx(rec: TxRecord) {
    const { proto, info } = describeFrame(rec.frame);
    if (this.mode === 'simulation') {
      this.pendingTx.push(rec);
      return;
    }
    // Real vaqt rejimida: faqat tanlangan protokollar, yengil animatsiya
    if (this.anims.length > 60) return;
    if (!this.simFilter.has(proto)) return;
    const now = performance.now();
    this.anims.push({ rec, start: now, dur: Math.max(250, Math.min(900, (rec.t1 - rec.t0) / this.speed)), proto });
    void info;
  }

  /** Qadamma-qadam rejim: har bir uzatishni ko'rinadigan qilib animatsiya qiladi */
  private simStep(t: number) {
    if (t < this.simBusyUntil) return;
    const sim = this.net.sim;
    const limit = sim.now + 60_000;
    let guard = 0;
    while (guard++ < 20000) {
      this.pendingTx = [];
      const nt = sim.peekTime();
      if (nt === null || nt > limit) {
        sim.runUntil(Math.min(limit, sim.now + 1000));
        break;
      }
      sim.step();
      const visible = this.pendingTx.filter((r) => this.simFilter.has(describeFrame(r.frame).proto));
      if (visible.length) {
        const dur = 900 / Math.max(0.1, this.speed);
        for (const rec of visible) {
          const { proto, info } = describeFrame(rec.frame);
          const row: SimEventRow = { id: this.eventCounter++, t: rec.t0, from: `${rec.from.device.displayName}`, to: `${rec.to.device.displayName}`, proto, info, rec };
          this.simEvents.push(row);
          this.anims.push({ rec, start: t, dur, proto });
        }
        if (this.simEvents.length > 2000) this.simEvents.splice(0, 500);
        this.simBusyUntil = t + dur;
        break;
      }
    }
    this.pendingTx = [];
  }

  setMode(m: 'realtime' | 'simulation') {
    this.mode = m;
    this.net.capture = m === 'simulation';
    this.anims = [];
    if (m === 'simulation') {
      this.speed = 1;
      this.running = false;
    } else {
      this.speed = 1;
      this.running = true;
    }
    this.emit();
  }

  stepOnce() {
    const was = this.running;
    this.running = true;
    this.simBusyUntil = 0;
    this.simStep(performance.now());
    this.running = was;
    this.emit();
  }

  fastForward(ms: number) {
    const n = this.net.sim.runFor(ms, 3_000_000);
    this.notify(`Vaqt ${Math.round(ms / 1000)} soniya oldinga siljitildi (${n} voqea)`);
  }

  clearSimEvents() {
    this.simEvents = [];
    this.simSelected = null;
    this.emit();
  }

  // ------------------------------------------------------------- tahrirlash
  addDevice(type: DeviceType, x: number, y: number) {
    const d = createDevice(type, nextLabel(this.net, type));
    this.net.addDevice(d, Math.round(x), Math.round(y));
    this.selected = d;
    this.emit();
    return d;
  }

  removeDevice(d: Device) {
    this.windows = this.windows.filter((w) => w.device !== d);
    if (this.selected === d) this.selected = null;
    this.net.removeDevice(d);
    this.emit();
  }

  openWindow(d: Device, tab?: string) {
    const ex = this.windows.find((w) => w.device === d);
    if (ex) {
      if (tab) ex.tab = tab;
      this.windows = [...this.windows.filter((w) => w !== ex), ex];
    } else this.windows = [...this.windows, { id: d.id, device: d, tab }];
    this.emit();
  }

  closeWindow(id: string) {
    this.windows = this.windows.filter((w) => w.id !== id);
    this.emit();
  }

  setTool(t: Tool) {
    this.tool = t;
    this.cableStart = null;
    this.pduStart = null;
    this.emit();
  }
}

export const store = new Store();
(globalThis as any).netadmin = store;

export function useStore() {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store;
}
