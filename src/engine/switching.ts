// L2 kommutatsiya: VLAN lar, 802.1Q trunk, DTP, MAC manzillar jadvali, port-security, STP bilan integratsiya.
import type { Device } from './device';
import type { Port, SwitchportConfig } from './port';
import { defaultSwitchport } from './port';
import type { L3Interface } from './l3';
import { EthernetFrame, nextFrameId, DtpPacket } from './packets';
import { StpManager } from './protocols/stp';
import { CISCO_MCAST_MAC, MAC, BROADCAST_MAC, isMulticastMac, PVST_MCAST_MAC, STP_MCAST_MAC } from './util';

export interface VlanInfo {
  id: number;
  name: string;
  status: 'active' | 'act/lshut' | 'suspended';
}

export interface MacEntry {
  vlan: number;
  mac: MAC;
  port: Port | 'CPU';
  type: 'DYNAMIC' | 'STATIC' | 'SECURE';
  ts: number;
}

export class SwitchFabric {
  device: Device;
  ports: Port[] = [];
  baseMac: MAC;
  vlans = new Map<number, VlanInfo>();
  macTable = new Map<string, MacEntry>();
  agingMs = 300_000;
  svis = new Map<number, L3Interface>();
  stp: StpManager;
  /** DTP: qo'shnidan kelgan rejim */
  dtpPeer = new Map<Port, DtpPacket['mode']>();
  vtpDomain = '';
  vtpMode: 'server' | 'client' | 'transparent' = 'transparent';
  /** CPU ga yetkazish (SVI, CDP, DTP...) */
  onControl?: (port: Port, frame: EthernetFrame) => void;
  maxMacEntries = 8192;
  stats = { floods: 0, forwarded: 0, filtered: 0 };

  constructor(device: Device, baseMac: MAC) {
    this.device = device;
    this.baseMac = baseMac;
    this.vlans.set(1, { id: 1, name: 'default', status: 'active' });
    for (const [id, name] of [
      [1002, 'fddi-default'],
      [1003, 'token-ring-default'],
      [1004, 'fddinet-default'],
      [1005, 'trnet-default'],
    ] as [number, string][])
      this.vlans.set(id, { id, name, status: 'act/lshut' });
    this.stp = new StpManager(this);
  }

  addPort(p: Port, mode: SwitchportConfig['mode'] = 'dynamic auto') {
    p.switchport = defaultSwitchport(mode);
    this.ports.push(p);
  }

  /** Kommutator sifatida ishlaydigan (switchport) portlar */
  get activePorts() {
    return this.ports.filter((p) => p.switchport);
  }

  // ------------------------------------------------------------ VLAN

  createVlan(id: number, name?: string) {
    if (id < 1 || id > 4094) return false;
    const v = this.vlans.get(id);
    if (v) {
      if (name) v.name = name;
    } else {
      this.vlans.set(id, { id, name: name ?? `VLAN${String(id).padStart(4, '0')}`, status: 'active' });
      this.onVlansChanged();
    }
    return true;
  }

  deleteVlan(id: number) {
    if (id === 1 || id >= 1002) return false;
    this.vlans.delete(id);
    this.flushVlan(id, false);
    this.onVlansChanged();
    return true;
  }

  onVlansChanged() {
    this.stp.sync();
    this.device.net?.bump();
  }

  /** Port ushbu VLAN kadrlarini tashiydimi */
  portCarriesVlan(p: Port, vlan: number): boolean {
    const sp = p.switchport;
    if (!sp || !this.vlans.has(vlan)) return false;
    if (this.vlans.get(vlan)!.status !== 'active') return false;
    if (sp.operMode === 'access') return sp.accessVlan === vlan || sp.voiceVlan === vlan;
    return sp.allowedVlans === 'all' || sp.allowedVlans.has(vlan);
  }

  portVlans(p: Port): number[] {
    return [...this.vlans.keys()].filter((v) => this.portCarriesVlan(p, v));
  }

  // ------------------------------------------------------------ DTP

  /** Operatsion rejimni (access/trunk) hisoblash */
  computeOperMode(p: Port) {
    const sp = p.switchport;
    if (!sp) return;
    const peer = this.dtpPeer.get(p);
    let mode: 'access' | 'trunk';
    switch (sp.mode) {
      case 'access':
        mode = 'access';
        break;
      case 'trunk':
        mode = 'trunk';
        break;
      case 'dynamic desirable':
        mode = peer === 'trunk' || peer === 'dynamic desirable' || peer === 'dynamic auto' ? 'trunk' : 'access';
        break;
      case 'dynamic auto':
        mode = peer === 'trunk' || peer === 'dynamic desirable' ? 'trunk' : 'access';
        break;
    }
    if (mode !== sp.operMode) {
      sp.operMode = mode;
      this.flushPort(p);
      this.stp.sync();
      this.device.net?.bump();
    }
  }

  sendDtp(p: Port) {
    const sp = p.switchport;
    if (!sp || sp.nonegotiate || sp.mode === 'access' || !p.operUp) return;
    const f: EthernetFrame = { id: nextFrameId(), src: p.mac, dst: CISCO_MCAST_MAC, etherType: 'DTP', payload: { kind: 'dtp', mode: sp.mode, domain: this.vtpDomain } };
    p.send(f);
  }

  // ------------------------------------------------------------ port hodisalari

  linkChange(p: Port, up: boolean) {
    if (!p.switchport) return;
    if (!up) {
      this.dtpPeer.delete(p);
      this.flushPort(p);
      this.computeOperMode(p);
    } else {
      this.computeOperMode(p);
      this.device.setTimer(200, () => this.sendDtp(p));
    }
    this.stp.sync();
  }

  errDisable(p: Port, reason: string) {
    p.errDisabled = reason;
    const cause = reason === 'bpduguard' ? 'bpduguard' : reason === 'psecure-violation' ? 'psecure-violation' : reason;
    this.device.syslog('PM', 4, 'ERR_DISABLE', `${cause} error detected on ${p.name}, putting ${p.name} in err-disable state`);
    this.device.net.refresh();
  }

  // ------------------------------------------------------------ MAC jadvali

  private key(vlan: number, mac: MAC) {
    return `${vlan}|${mac}`;
  }

  learn(vlan: number, mac: MAC, port: Port) {
    if (isMulticastMac(mac)) return;
    const k = this.key(vlan, mac);
    const e = this.macTable.get(k);
    if (e && e.type !== 'DYNAMIC') return;
    if (!e && this.macTable.size >= this.maxMacEntries) return;
    this.macTable.set(k, { vlan, mac, port, type: 'DYNAMIC', ts: this.device.now });
  }

  flushPort(p: Port, vlan?: number) {
    for (const [k, e] of [...this.macTable]) if (e.port === p && e.type === 'DYNAMIC' && (vlan === undefined || e.vlan === vlan)) this.macTable.delete(k);
  }

  flushVlan(vlan: number, fastAgeOnly: boolean) {
    for (const [k, e] of [...this.macTable]) {
      if (e.vlan !== vlan || e.type !== 'DYNAMIC') continue;
      if (fastAgeOnly && e.port !== 'CPU' && e.port.switchport?.portfast) continue;
      this.macTable.delete(k);
    }
  }

  flushAll() {
    for (const [k, e] of [...this.macTable]) if (e.type === 'DYNAMIC') this.macTable.delete(k);
  }

  ageMacs() {
    const now = this.device.now;
    for (const [k, e] of [...this.macTable]) if (e.type === 'DYNAMIC' && now - e.ts > this.agingMs) this.macTable.delete(k);
  }

  addCpuMac(vlan: number, mac: MAC) {
    this.macTable.set(this.key(vlan, mac), { vlan, mac, port: 'CPU', type: 'STATIC', ts: 0 });
  }

  removeCpuMac(vlan: number) {
    for (const [k, e] of [...this.macTable]) if (e.port === 'CPU' && e.vlan === vlan) this.macTable.delete(k);
  }

  // ------------------------------------------------------------ kadrlarni qayta ishlash

  /** Kiruvchi kadrning VLAN ini aniqlash (null — tashlanadi) */
  classify(p: Port, f: EthernetFrame): number | null {
    const sp = p.switchport!;
    if (sp.operMode === 'access') {
      if (f.vlan === undefined || f.vlan === 0) return sp.accessVlan;
      if (sp.voiceVlan !== null && f.vlan === sp.voiceVlan) return sp.voiceVlan;
      return null;
    }
    const v = f.vlan === undefined || f.vlan === 0 ? sp.nativeVlan : f.vlan;
    return v;
  }

  ingress(p: Port, f: EthernetFrame) {
    const sp = p.switchport;
    if (!sp || !p.operUp) return;
    // Nazorat protokollari (hech qachon uzatilmaydi)
    if (f.dst === CISCO_MCAST_MAC) {
      if (f.payload.kind === 'dtp') {
        this.dtpPeer.set(p, f.payload.mode);
        this.computeOperMode(p);
        return;
      }
      this.onControl?.(p, f);
      return;
    }
    const isBpdu = f.dst === STP_MCAST_MAC || f.dst === PVST_MCAST_MAC;
    const vlan = this.classify(p, f);
    if (vlan === null) {
      this.stats.filtered++;
      return;
    }
    if (isBpdu && f.payload.kind === 'bpdu') {
      if (this.stp.enabled && !this.stp.disabledVlans.has(vlan)) {
        this.stp.receive(p, vlan, f.payload);
        return;
      }
      // STP o'chiq — BPDU oddiy multicast sifatida uzatiladi
    }
    if (!this.portCarriesVlan(p, vlan)) {
      this.stats.filtered++;
      return;
    }
    // Port-security
    if (sp.portSecurity.enabled && sp.operMode === 'access' && !this.portSecurityCheck(p, f.src)) return;
    if (this.stp.canLearn(p, vlan)) this.learn(vlan, f.src, p);
    if (!this.stp.canForward(p, vlan)) return;
    this.forward(vlan, f, p);
  }

  private portSecurityCheck(p: Port, src: MAC): boolean {
    const ps = p.switchport!.portSecurity;
    if (ps.secureMacs.includes(src)) return true;
    if (ps.secureMacs.length < ps.maximum) {
      ps.secureMacs.push(src);
      this.macTable.set(this.key(p.switchport!.accessVlan, src), { vlan: p.switchport!.accessVlan, mac: src, port: p, type: 'SECURE', ts: this.device.now });
      return true;
    }
    ps.violations++;
    if (ps.violation === 'shutdown') {
      this.device.syslog('PORT_SECURITY', 2, 'PSECURE_VIOLATION', `Security violation occurred, caused by MAC address ${src} on port ${p.name}.`);
      this.errDisable(p, 'psecure-violation');
    } else if (ps.violation === 'restrict') {
      this.device.syslog('PORT_SECURITY', 2, 'PSECURE_VIOLATION', `Security violation occurred, caused by MAC address ${src} on port ${p.name}.`);
    }
    return false;
  }

  /** VLAN ichida uzatish (ingress porti yoki CPU dan) */
  forward(vlan: number, f: EthernetFrame, from: Port | 'CPU') {
    const bcast = f.dst === BROADCAST_MAC || isMulticastMac(f.dst);
    if (!bcast) {
      const e = this.macTable.get(this.key(vlan, f.dst));
      if (e) {
        if (e.port === 'CPU') {
          if (from !== 'CPU') this.toCpu(vlan, f);
          return;
        }
        if (e.port === from) {
          this.stats.filtered++;
          return;
        }
        if (e.port.operUp && this.stp.canForward(e.port, vlan) && this.portCarriesVlan(e.port, vlan)) {
          this.stats.forwarded++;
          this.egress(e.port, vlan, f);
          return;
        }
      }
    }
    // flood (broadcast, multicast yoki noma'lum unicast)
    this.stats.floods++;
    for (const p of this.ports) {
      if (p === from || !p.operUp || !p.switchport) continue;
      if (!this.portCarriesVlan(p, vlan) || !this.stp.canForward(p, vlan)) continue;
      this.egress(p, vlan, f);
    }
    if (from !== 'CPU' && bcast) this.toCpu(vlan, f);
  }

  private toCpu(vlan: number, f: EthernetFrame) {
    const svi = this.svis.get(vlan);
    if (svi && svi.adminUp) this.device.net.sim.schedule(0.005, () => this.device.powered && this.deliverToSvi?.(svi, f));
  }

  deliverToSvi?: (svi: L3Interface, f: EthernetFrame) => void;

  /** Chiqish: 802.1Q tegini qo'yish/olib tashlash */
  egress(p: Port, vlan: number, f: EthernetFrame) {
    const sp = p.switchport!;
    let tag: number | undefined;
    if (sp.operMode === 'access') {
      tag = sp.voiceVlan === vlan && sp.accessVlan !== vlan ? vlan : undefined;
    } else {
      tag = vlan === sp.nativeVlan ? undefined : vlan;
    }
    const out: EthernetFrame = { ...f, vlan: tag, id: nextFrameId() };
    if (tag === undefined) delete out.vlan;
    p.send(out);
  }

  /** Nazorat kadri (BPDU) — STP holatidan qat'i nazar */
  egressControl(p: Port, vlan: number, f: EthernetFrame) {
    if (!p.switchport || !p.operUp) return;
    this.egress(p, vlan, f);
  }

  /** SVI dan chiqayotgan kadr */
  sendFromSvi(vlan: number, f: EthernetFrame) {
    this.forward(vlan, { ...f }, 'CPU');
  }

  /** Qurilma o'chganda */
  reset() {
    this.flushAll();
    this.dtpPeer.clear();
    for (const p of this.ports) if (p.switchport) p.switchport.operMode = p.switchport.mode === 'trunk' ? 'trunk' : 'access';
    this.stp.stop();
  }
}
