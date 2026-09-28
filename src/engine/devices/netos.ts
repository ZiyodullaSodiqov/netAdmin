// Cisco IOS ga o'xshash operatsion tizimli qurilmalar (router, switch, L3 switch) uchun umumiy asos.
import { Device } from '../device';
import type { Port } from '../port';
import { shortIfName } from '../port';
import { IpStack } from '../ipstack';
import { L3Interface } from '../l3';
import type { EthernetFrame } from '../packets';
import { SwitchFabric } from '../switching';
import { CdpAgent, CdpHost } from '../protocols/cdp';
import { DhcpClient, DhcpServer, installDhcpPort67, installDhcpPort68 } from '../protocols/dhcp';
import { DnsResolver } from '../protocols/dns';
import { OspfProcess } from '../protocols/ospf';
import { MAC, generateMac } from '../util';
import { installVtyServer } from '../cli/remote';

export interface IosUser {
  name: string;
  privilege: number;
  secret?: string;
  password?: string;
}

export interface IosLine {
  password: string | null;
  login: 'none' | 'line' | 'local';
  execTimeout: number | null;
  loggingSync: boolean;
  transport: ('telnet' | 'ssh')[];
  accessClass: string | null;
}

export interface IosSettings {
  enableSecret: string | null;
  enablePassword: string | null;
  servicePasswordEncryption: boolean;
  bannerMotd: string | null;
  domainName: string;
  nameServers: string[];
  domainLookup: boolean;
  users: IosUser[];
  con: IosLine;
  vty: IosLine;
  sshVersion: 1 | 2;
  rsaBits: number | null;
  cdpRun: boolean;
  loggingHosts: string[];
  ipHosts: Map<string, string>;
  ntpServer: string | null;
  httpServer: boolean;
}

export function defaultIos(): IosSettings {
  return {
    enableSecret: null,
    enablePassword: null,
    servicePasswordEncryption: false,
    bannerMotd: null,
    domainName: '',
    nameServers: [],
    domainLookup: true,
    users: [],
    con: { password: null, login: 'none', execTimeout: null, loggingSync: false, transport: [], accessClass: null },
    vty: { password: null, login: 'line', execTimeout: null, loggingSync: false, transport: ['telnet', 'ssh'], accessClass: null },
    sshVersion: 1,
    rsaBits: null,
    cdpRun: true,
    loggingHosts: [],
    ipHosts: new Map(),
    ntpServer: null,
    httpServer: false,
  };
}

export { type5, type7, decode7 } from '../cli/crypto';

export interface CliSessionRef {
  line: 'con' | 'vty';
  user: string;
  from: string;
  since: number;
  close(): void;
}

export abstract class NetOsDevice extends Device implements CdpHost {
  stack: IpStack;
  fabric: SwitchFabric | null = null;
  cdp: CdpAgent;
  dhcpServer: DhcpServer;
  dhcpClients: DhcpClient[] = [];
  resolver: DnsResolver;
  ospf: OspfProcess | null = null;
  ios: IosSettings = defaultIos();
  startupConfig: string | null = null;
  baseMac: MAC;
  abstract platform: string;
  abstract capabilities: string;
  abstract iosVersion: string;
  abstract iosImage: string;
  sessions = new Set<CliSessionRef>();
  /** CLI dan tashqari buyruqlar tarixi (show history) */
  configRegister = '0x2102';
  lastConfigChange = 0;
  poeBudgetW = 0;
  private lineStates = new Map<string, boolean>();

  constructor(model: string, hostname: string, id?: string) {
    super(model, hostname, id);
    this.baseMac = generateMac('00:d0:97');
    this.stack = new IpStack(this, { ipRouting: false, defaultTtl: 255, arpQueue: 0, arpTimeoutMs: 14_400_000, icmpRateLimitMs: 500 });
    this.cdp = new CdpAgent(this);
    this.dhcpServer = new DhcpServer(this.stack);
    this.resolver = new DnsResolver(this.stack);
    installDhcpPort67(this.stack, () => (this.dhcpServer.pools.length ? this.dhcpServer : null));
    installDhcpPort68(this.stack, () => this.dhcpClients);
  }

  get version() {
    return this.iosVersion;
  }

  get device(): NetOsDevice {
    return this;
  }

  // ------------------------------------------------------------ CdpHost
  cdpPorts(): Port[] {
    return this.ports.filter((p) => p.media === 'copper' || p.media === 'fiber');
  }

  address(): string | undefined {
    return this.stack.interfaces.find((i) => i.hasIp && i.up)?.ip ?? undefined;
  }

  portVlanInfo(p: Port) {
    const sp = p.switchport;
    if (!sp) return {};
    return { nativeVlan: sp.operMode === 'trunk' ? sp.nativeVlan : sp.accessVlan, voiceVlan: sp.voiceVlan ?? undefined };
  }

  sendCdp(p: Port, frame: EthernetFrame) {
    p.send(frame);
  }

  // ------------------------------------------------------------ L3 interfeyslar

  /** Router porti uchun L3 interfeys */
  makePhysicalIface(p: Port): L3Interface {
    const i = new L3Interface({
      name: p.name,
      kind: 'physical',
      mac: p.mac,
      port: p,
      output: (f) => p.send(f),
      lineUp: () => p.operUp,
    });
    i.bandwidthKbps = p.maxSpeed * 1000;
    return i;
  }

  makeSubIface(parent: Port, name: string): L3Interface {
    const i: L3Interface = new L3Interface({
      name,
      kind: 'subif',
      mac: parent.mac,
      port: parent,
      output: (f) => {
        const out: EthernetFrame = { ...f };
        if (i.encapVlan !== null && !i.encapNative) out.vlan = i.encapVlan;
        parent.send(out);
      },
      lineUp: () => parent.operUp && i.encapVlan !== null,
    });
    i.bandwidthKbps = parent.maxSpeed * 1000;
    return i;
  }

  makeLoopback(n: number): L3Interface {
    const i = new L3Interface({ name: `Loopback${n}`, kind: 'loopback', mac: this.baseMac, output: () => {}, lineUp: () => true });
    i.bandwidthKbps = 8_000_000;
    return i;
  }

  makeSvi(vlan: number): L3Interface {
    const f = this.fabric!;
    const i: L3Interface = new L3Interface({
      name: `Vlan${vlan}`,
      kind: 'svi',
      mac: this.baseMac,
      output: (fr) => f.sendFromSvi(vlan, fr),
      lineUp: () => {
        if (!f.vlans.has(vlan) || f.vlans.get(vlan)!.status !== 'active') return false;
        return f.ports.some((p) => p.operUp && p.switchport && f.portCarriesVlan(p, vlan) && f.stp.canForward(p, vlan));
      },
    });
    i.sviVlan = vlan;
    return i;
  }

  ensureSvi(vlan: number): L3Interface {
    const f = this.fabric!;
    let s = f.svis.get(vlan);
    if (!s) {
      s = this.makeSvi(vlan);
      f.svis.set(vlan, s);
      f.addCpuMac(vlan, s.mac);
      this.stack.addInterface(s);
      this.sortInterfaces();
    }
    return s;
  }

  removeSvi(vlan: number) {
    const f = this.fabric!;
    const s = f.svis.get(vlan);
    if (s) {
      f.svis.delete(vlan);
      f.removeCpuMac(vlan);
      this.stack.removeInterface(s);
    }
  }

  sortInterfaces() {
    const order = (i: L3Interface) => (i.kind === 'physical' || i.kind === 'subif' ? 0 : i.kind === 'svi' ? 1 : 2);
    this.stack.interfaces.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  /** L3 interfeysni nom bo'yicha topish */
  l3(name: string): L3Interface | undefined {
    return this.stack.iface(name);
  }

  dhcpClientFor(i: L3Interface): DhcpClient {
    let c = this.dhcpClients.find((x) => x.iface === i);
    if (!c) {
      c = new DhcpClient(this.stack, i, {
        hostname: () => this.hostname,
        apipa: false,
        onBound: (iface) => {
          this.syslog('DHCP', 6, 'ADDRESS_ASSIGN', `Interface ${iface.name} assigned DHCP address ${iface.ip}, mask ${iface.mask}, hostname ${this.hostname}`);
          const st = iface.dhcpState;
          if (st?.gateway && !this.stack.staticRoutes.some((r) => r.network === '0.0.0.0' && r.permanent === undefined)) {
            // DHCP dan olingan default route (AD 254)
            this.stack.routeProviders = this.stack.routeProviders.filter((p) => (p as any).dhcp !== iface.name);
            const gw = st.gateway;
            const prov = Object.assign(() => (iface.dhcpState?.state === 'BOUND' ? [{ code: 'S*' as const, network: '0.0.0.0', mask: '0.0.0.0', prefix: 0, iface: null, nextHop: gw, ad: 254, metric: 0 }] : []), { dhcp: iface.name });
            this.stack.routeProviders.push(prov);
            this.stack.invalidate();
          }
          if (st?.dns?.length && !this.ios.nameServers.length) this.stack.dnsServers = st.dns;
        },
      });
      this.dhcpClients.push(c);
    }
    return c;
  }

  // ------------------------------------------------------------ kadrlar

  receive(port: Port, frame: EthernetFrame) {
    if (frame.payload.kind === 'cdp') {
      if (this.ios.cdpRun) this.cdp.receive(port, frame.payload);
      return;
    }
    if (port.switchport && this.fabric) {
      this.fabric.ingress(port, frame);
      return;
    }
    this.receiveRouted(port, frame);
  }

  /** Router (L3) portiga kelgan kadr */
  protected receiveRouted(port: Port, frame: EthernetFrame) {
    if (frame.payload.kind === 'bpdu' || frame.payload.kind === 'dtp') return;
    let target: L3Interface | undefined;
    if (frame.vlan !== undefined && frame.vlan !== 0) {
      target = this.stack.interfaces.find((i) => i.kind === 'subif' && i.port === port && i.encapVlan === frame.vlan && !i.encapNative);
    } else {
      target = this.stack.interfaces.find((i) => i.kind === 'subif' && i.port === port && i.encapNative) ?? this.stack.interfaces.find((i) => i.kind === 'physical' && i.port === port);
    }
    if (!target) return;
    this.stack.receiveFrame(target, frame);
  }

  deliverSviFrame(svi: L3Interface, f: EthernetFrame) {
    this.stack.receiveFrame(svi, f);
  }

  // ------------------------------------------------------------ hayot sikli

  onPowerOn() {
    this.factoryReset();
    if (this.startupConfig) this.applyConfig(this.startupConfig);
    this.startProtocols();
    this.lineStates.clear();
  }

  onPowerOff() {
    this.stack.reset();
    this.fabric?.reset();
    this.cdp.halt();
    this.ospf?.reset();
    for (const s of [...this.sessions]) s.close();
    this.sessions.clear();
  }

  startProtocols() {
    installVtyServer(this);
    if (this.ios.cdpRun) this.cdp.start();
    if (this.fabric) {
      this.fabric.stp.start();
      this.fabric.stp.sync();
    }
    this.ospf?.start();
    for (const i of this.stack.interfaces) if (i.dhcp) this.dhcpClientFor(i).start();
  }

  /** Zavod sozlamalari (running-config tozalanadi) */
  abstract factoryReset(): void;

  /** Konfiguratsiya matnini CLI orqali qo'llash */
  abstract applyConfig(text: string): string[];

  /** show running-config */
  abstract runningConfig(): string;

  onLinkChange(port: Port, up: boolean) {
    this.fabric?.linkChange(port, up);
    if (up) this.cdp.linkUp(port);
    else this.cdp.linkDown(port);
    this.syslog('LINK', up ? 3 : 5, 'UPDOWN', `Interface ${port.name}, changed state to ${up ? 'up' : 'down'}`);
    const dev = this;
    this.setTimer(up ? 1000 : 10, () => {
      if (port.operUp === up) dev.syslog('LINEPROTO', 5, 'UPDOWN', `Line protocol on Interface ${port.name}, changed state to ${up ? 'up' : 'down'}`);
    });
    this.stack.invalidate();
    for (const i of this.stack.interfaces) if (i.port === port && up) this.setTimer(50, () => this.stack.gratuitousArp(i));
    for (const c of this.dhcpClients) if (c.iface.port === port && up && c.iface.dhcp) c.start();
    this.ospf?.interfaceChange();
  }

  tick1s() {
    this.stack.tick();
    this.fabric?.ageMacs();
    this.dhcpServer.expire();
    // SVI holati o'zgarishini kuzatish (autostate)
    for (const i of this.stack.interfaces) {
      if (i.kind !== 'svi') continue;
      const up = i.up;
      const prev = this.lineStates.get(i.name);
      if (prev !== undefined && prev !== up && i.adminUp) {
        this.syslog('LINEPROTO', 5, 'UPDOWN', `Line protocol on Interface ${i.name}, changed state to ${up ? 'up' : 'down'}`);
        if (up) this.stack.gratuitousArp(i);
        this.ospf?.interfaceChange();
      }
      this.lineStates.set(i.name, up);
    }
  }

  ipSummary(): string[] {
    return this.stack.interfaces.filter((i) => i.hasIp).map((i) => `${shortIfName(i.name)}: ${i.ip}/${i.prefix}`);
  }

  saveConfig(): any {
    return { startup: this.startupConfig, running: this.runningConfig() };
  }

  loadConfig(cfg: any): void {
    this.startupConfig = cfg?.startup ?? null;
    if (cfg?.running) {
      this.factoryReset();
      this.applyConfig(cfg.running);
      if (this.powered) this.startProtocols();
    }
  }

  /** Syslog: konsol + tashqi syslog server (logging host) */
  syslog(facility: string, severity: number, mnemonic: string, text: string) {
    super.syslog(facility, severity, mnemonic, text);
    if (!this.powered || !this.ios?.loggingHosts.length) return;
    for (const h of this.ios.loggingHosts) {
      this.stack.sendUdp(h, 514, 514, { kind: 'syslog', text: `${this.hostname}: %${facility}-${severity}-${mnemonic}: ${text}` });
    }
  }

  get uptimeMs() {
    return this.now - this.bootedAt;
  }
}
