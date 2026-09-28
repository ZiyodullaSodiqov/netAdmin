// Barcha qurilmalar uchun asosiy sinf.
import type { Network } from './network';
import { Port, PortSpec, expandIfName, shortIfName } from './port';
import type { EthernetFrame } from './packets';
import type { SimEvent } from './sim';
import { generateMac } from './util';

export type DeviceKind =
  | 'router'
  | 'switch'
  | 'l3switch'
  | 'pc'
  | 'laptop'
  | 'server'
  | 'ipphone'
  | 'accesspoint'
  | 'homerouter'
  | 'smartphone'
  | 'printer'
  | 'hub';

export interface ConsoleSink {
  (text: string): void;
}

let deviceCounter = 1;

export abstract class Device {
  readonly id: string;
  abstract readonly kind: DeviceKind;
  model: string;
  hostname: string;
  /** Diagrammada ko'rinadigan nom (hostname dan alohida, Packet Tracer kabi) */
  label: string;
  /** Joylashuv, metrlarda (keyinchalik Three.js sahnasi bilan bir xil koordinatalar) */
  x = 0;
  y = 0;
  /** Qavat / bino (3D uchun) */
  floor = 0;
  building = '';
  ports: Port[] = [];
  net!: Network;
  /** Old paneldagi quvvat tugmasi */
  powerSwitch = true;
  /** Rozetka (AC adapter) ulanganmi */
  acPower = true;
  /** Hisoblangan: qurilma yoqilganmi */
  powered = false;
  poweredViaPoe = false;
  /** PoE orqali ishlaganda talab qilinadigan quvvat (Vt) */
  poeRequiredW = 0;
  /** Kadrni qayta ishlash kechikishi (ms) */
  procDelayMs = 0.02;
  qosEnabled = false;
  bootedAt = 0;
  /** Konsol chiqishi (syslog xabarlari, CLI javoblari) */
  private consoleSinks = new Set<ConsoleSink>();
  consoleHistory: string[] = [];
  private timers = new Set<SimEvent>();
  /** Foydalanuvchi eslatmalari (3D/o'quv uchun) */
  notes = '';

  constructor(model: string, hostname: string, id?: string) {
    this.model = model;
    this.hostname = hostname;
    this.label = hostname;
    this.id = id ?? `d${deviceCounter++}`;
    const n = Number(this.id.replace(/\D/g, ''));
    if (n >= deviceCounter) deviceCounter = n + 1;
  }

  get sim() {
    return this.net.sim;
  }

  get now() {
    return this.net.sim.now;
  }

  protected addPort(spec: PortSpec, oui?: string): Port {
    const p = new Port(this, spec, generateMac(oui ?? this.macOui()));
    this.ports.push(p);
    return p;
  }

  protected macOui(): string {
    return '00:e0:f7';
  }

  /** Port nomini topish: to'liq, qisqa yoki qisqartirilgan ("g0/1") */
  port(name: string): Port | undefined {
    const direct = this.ports.find((p) => p.name === name || p.shortName === name);
    if (direct) return direct;
    const full = expandIfName(name);
    if (full) return this.ports.find((p) => p.name === full);
    const low = name.toLowerCase();
    return this.ports.find((p) => p.name.toLowerCase() === low || p.shortName.toLowerCase() === low || p.label?.toLowerCase() === low);
  }

  // -------------------------------------------------------------- taymerlar

  setTimer(ms: number, fn: () => void): SimEvent {
    const ev = this.sim.schedule(ms, () => {
      this.timers.delete(ev);
      if (this.powered) fn();
    });
    this.timers.add(ev);
    return ev;
  }

  clearTimer(ev: SimEvent | null | undefined) {
    if (!ev) return;
    ev.cancelled = true;
    this.timers.delete(ev);
  }

  /** Davriy taymer. Qaytgan funksiya — to'xtatish */
  every(ms: number, fn: () => void, firstDelay = ms): () => void {
    let ev: SimEvent | null = null;
    let stopped = false;
    const run = () => {
      if (stopped) return;
      fn();
      if (!stopped) ev = this.setTimer(ms, run);
    };
    ev = this.setTimer(firstDelay, run);
    return () => {
      stopped = true;
      this.clearTimer(ev);
    };
  }

  cancelAllTimers() {
    for (const t of this.timers) t.cancelled = true;
    this.timers.clear();
  }

  // -------------------------------------------------------------- konsol

  onConsole(sink: ConsoleSink): () => void {
    this.consoleSinks.add(sink);
    return () => this.consoleSinks.delete(sink);
  }

  /** Konsolga matn chiqarish (yangi qator bilan) */
  console(text: string) {
    this.consoleHistory.push(text);
    if (this.consoleHistory.length > 500) this.consoleHistory.splice(0, 100);
    for (const s of this.consoleSinks) s(text);
  }

  /** Cisco uslubidagi syslog xabari */
  syslog(facility: string, severity: number, mnemonic: string, text: string) {
    this.console(`%${facility}-${severity}-${mnemonic}: ${text}`);
  }

  // -------------------------------------------------------------- hayot sikli

  /** Qurilma yoqilganda (boot) */
  onPowerOn(): void {}
  /** Qurilma o'chganda — dinamik holat tozalanadi */
  onPowerOff(): void {}
  /** Port holati o'zgarganda */
  onLinkChange(_port: Port, _up: boolean): void {}
  /** Kadr qabul qilindi */
  abstract receive(port: Port, frame: EthernetFrame): void;
  /** Har soniyada (qurilma yoqiq bo'lsa) */
  tick1s(): void {}

  /** Qurilmaning barcha IP manzillari (UI uchun) */
  ipSummary(): string[] {
    return [];
  }

  /** Sozlamalarni saqlash / tiklash (topologiya fayli uchun) */
  abstract saveConfig(): any;
  abstract loadConfig(cfg: any): void;

  get displayName() {
    return this.label || this.hostname;
  }

  portShort(p: Port) {
    return shortIfName(p.name);
  }
}
