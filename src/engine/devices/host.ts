// Oxirgi qurilmalar: kompyuter, noutbuk, server, smartfon, printer.
import { Device, DeviceKind } from '../device';
import type { Port } from '../port';
import { IpStack } from '../ipstack';
import { L3Interface } from '../l3';
import type { EthernetFrame } from '../packets';
import { DhcpClient, DhcpServer, installDhcpPort67, installDhcpPort68 } from '../protocols/dhcp';
import { DnsResolver, DnsServer } from '../protocols/dns';
import { HttpService, ServerHardware, SyslogService } from './server-services';
import { BROADCAST_MAC, isValidIp, isValidMask } from '../util';
import { WifiBand, WifiSecurity, wifiRate, wifiRssi } from '../link';
import { LoadGenerator } from './host-apps';

export type HostKind = 'pc' | 'laptop' | 'server' | 'smartphone' | 'printer';

export interface NicConfig {
  mode: 'dhcp' | 'static';
  ip: string;
  mask: string;
}

export interface WifiClientConfig {
  enabled: boolean;
  ssid: string;
  security: WifiSecurity;
  key: string;
}

export interface Nic {
  port: Port;
  iface: L3Interface;
  cfg: NicConfig;
  dhcp: DhcpClient;
}

export interface HostModel {
  kind: HostKind;
  name: string;
  description: string;
  os: 'windows' | 'linux' | 'android';
}

export const HOST_MODELS: Record<HostKind, HostModel> = {
  pc: { kind: 'pc', name: 'Kompyuter (PC)', description: 'Ish stoli kompyuteri: FastEthernet0 (10/100, Auto-MDIX yo\'q), RS-232 konsol porti', os: 'windows' },
  laptop: { kind: 'laptop', name: 'Noutbuk', description: 'FastEthernet0 + Wi-Fi (802.11ac, 2.4/5 GHz)', os: 'windows' },
  server: { kind: 'server', name: 'Server', description: '2×Gigabit Ethernet, HTTP/HTTPS/DNS/DHCP/Syslog xizmatlari, real yuklama modeli', os: 'linux' },
  smartphone: { kind: 'smartphone', name: 'Smartfon', description: 'Faqat Wi-Fi (Android)', os: 'android' },
  printer: { kind: 'printer', name: 'Tarmoq printeri', description: 'FastEthernet0, IP orqali chop etish', os: 'linux' },
};

export class Host extends Device {
  readonly kind: DeviceKind;
  hostKind: HostKind;
  os: 'windows' | 'linux' | 'android';
  stack: IpStack;
  resolver: DnsResolver;
  nics: Nic[] = [];
  gateway = '';
  dnsServer = '';
  wifi: WifiClientConfig = { enabled: true, ssid: '', security: 'wpa2-psk', key: '' };
  /** Server apparati */
  hardware: ServerHardware = { cpuCores: 4, cpuGhz: 3.0, ramMb: 8192, diskIops: 5000 };
  http: HttpService;
  dns: DnsServer;
  dhcpService: DhcpServer;
  dhcpServiceEnabled = false;
  syslogService: SyslogService;
  loadGens: LoadGenerator[] = [];
  firewallIcmp = true;
  /** Wi-Fi hodisalari (UI uchun) */
  wifiLog: string[] = [];

  constructor(kind: HostKind, label: string, id?: string) {
    super(HOST_MODELS[kind].name, label, id);
    this.kind = kind;
    this.hostKind = kind;
    this.os = HOST_MODELS[kind].os;
    const linux = this.os !== 'windows';
    this.stack = new IpStack(this, { ipRouting: false, defaultTtl: linux ? 64 : 128, arpQueue: 3, arpTimeoutMs: linux ? 60_000 : 120_000 });
    this.resolver = new DnsResolver(this.stack);
    this.procDelayMs = kind === 'server' ? 0.03 : 0.05;
    const oui = kind === 'server' ? '00:25:90' : kind === 'smartphone' ? '3c:28:6d' : kind === 'printer' ? '00:1b:a9' : '00:1b:21';
    if (kind === 'server') {
      this.addNic({ name: 'GigabitEthernet0', media: 'copper', speeds: [10, 100, 1000], mdi: 'MDI', autoMdix: true }, oui);
      this.addNic({ name: 'GigabitEthernet1', media: 'copper', speeds: [10, 100, 1000], mdi: 'MDI', autoMdix: true }, oui);
    } else if (kind === 'smartphone') {
      this.addNic({ name: 'Wireless0', media: 'wireless', speeds: [867], mdi: 'MDI', autoMdix: false }, oui);
    } else {
      this.addNic({ name: 'FastEthernet0', media: 'copper', speeds: [10, 100], mdi: 'MDI', autoMdix: false }, oui);
      if (kind === 'laptop') this.addNic({ name: 'Wireless0', media: 'wireless', speeds: [867], mdi: 'MDI', autoMdix: false }, oui);
    }
    if (kind === 'pc' || kind === 'laptop') this.addPort({ name: 'RS232', media: 'console', speeds: [0], mdi: 'MDI', autoMdix: false, label: 'RS 232' }, oui);
    for (const n of this.nics) if (n.port.media === 'wireless') n.cfg.mode = 'dhcp';
    if (kind === 'smartphone' || kind === 'laptop') for (const n of this.nics) n.cfg.mode = 'dhcp';
    this.http = new HttpService(this);
    this.dns = new DnsServer(this.stack);
    this.dhcpService = new DhcpServer(this.stack);
    this.syslogService = new SyslogService(this);
    installDhcpPort68(this.stack, () => this.nics.map((n) => n.dhcp));
    if (kind === 'server') {
      installDhcpPort67(this.stack, () => (this.dhcpServiceEnabled ? this.dhcpService : null));
      this.dhcpService.pools = [{ name: 'serverPool', network: '', mask: '', startIp: '', maxUsers: 100, defaultRouter: '', dns: [], leaseSec: 86400 }];
    }
    this.stack.onDuplicateIp = (iface, mac) => {
      this.console(`Windows has detected an IP address conflict (${iface.ip} — ${mac})`);
    };
  }

  private addNic(spec: Parameters<Device['addPort']>[0], oui: string) {
    const port = this.addPort(spec, oui);
    const iface = new L3Interface({
      name: port.name,
      kind: 'host',
      mac: port.mac,
      port,
      output: (f) => port.send(f),
      lineUp: () => port.operUp,
    });
    this.stack.addInterface(iface);
    const dhcp = new DhcpClient(this.stack, iface, {
      hostname: () => this.label,
      apipa: this.os === 'windows',
      onBound: () => this.updateGateway(),
      onFail: () => this.updateGateway(),
    });
    this.nics.push({ port, iface, cfg: { mode: 'static', ip: '', mask: '' }, dhcp });
  }

  nic(name?: string): Nic | undefined {
    if (!name) return this.nics[0];
    return this.nics.find((n) => n.port.name === name || n.port.shortName === name);
  }

  get wirelessNic() {
    return this.nics.find((n) => n.port.media === 'wireless');
  }

  // ------------------------------------------------------------ IP sozlamalari

  /** GUI dagi "IP Configuration" oynasi */
  setNicConfig(nic: Nic, cfg: Partial<NicConfig>) {
    Object.assign(nic.cfg, cfg);
    this.applyNic(nic);
  }

  applyNic(nic: Nic) {
    const i = nic.iface;
    if (nic.cfg.mode === 'dhcp') {
      i.dhcp = true;
      if (this.powered && nic.port.operUp) nic.dhcp.start();
    } else {
      if (i.dhcp) nic.dhcp.stop();
      i.dhcp = false;
      i.dhcpState = null;
      i.ip = isValidIp(nic.cfg.ip) ? nic.cfg.ip : null;
      i.mask = i.ip && isValidMask(nic.cfg.mask) ? nic.cfg.mask : null;
      if (this.powered && i.up) this.setTimer(5, () => this.stack.gratuitousArp(i));
    }
    this.stack.invalidate();
    this.updateGateway();
  }

  setGateway(gw: string) {
    this.gateway = gw;
    this.updateGateway();
  }

  setDns(dns: string) {
    this.dnsServer = dns;
    this.updateGateway();
  }

  updateGateway() {
    const staticNic = this.nics.find((n) => n.cfg.mode === 'static' && n.iface.ip);
    const dhcpNic = this.nics.find((n) => n.iface.dhcpState?.state === 'BOUND' && n.iface.up) ?? this.nics.find((n) => n.iface.dhcpState?.state === 'BOUND');
    let gw: string | null = null;
    let dns: string[] = [];
    if (staticNic && isValidIp(this.gateway)) gw = this.gateway;
    if (!gw && dhcpNic) gw = dhcpNic.iface.dhcpState?.gateway ?? null;
    if (!gw && isValidIp(this.gateway)) gw = this.gateway;
    if (isValidIp(this.dnsServer) && (staticNic || !dhcpNic)) dns = [this.dnsServer];
    else if (dhcpNic?.iface.dhcpState?.dns?.length) dns = dhcpNic.iface.dhcpState.dns;
    else if (isValidIp(this.dnsServer)) dns = [this.dnsServer];
    this.stack.defaultGateway = gw;
    this.stack.dnsServers = dns;
    this.stack.invalidate();
    this.net?.bump();
  }

  /** Server DNS/HTTP xizmatlarini o'rnatish */
  private installServices() {
    if (this.hostKind === 'server') {
      this.http.install();
      if (this.dns.enabled) this.dns.install();
      this.syslogService.install();
    }
  }

  setDnsService(on: boolean) {
    this.dns.enabled = on;
    if (on && this.powered) this.dns.install();
  }

  // ------------------------------------------------------------ kadrlar

  receive(port: Port, frame: EthernetFrame) {
    const nic = this.nics.find((n) => n.port === port);
    if (!nic) return;
    if (frame.vlan !== undefined && frame.vlan !== 0) return; // oddiy NIC 802.1Q tegli kadrlarni qabul qilmaydi
    if (frame.dst !== nic.port.mac && frame.dst !== BROADCAST_MAC && !frame.dst.startsWith('01:00:5e')) return;
    if (frame.payload.kind === 'ipv4' && frame.payload.payload.kind === 'icmp' && frame.payload.payload.type === 'echo-request' && !this.firewallIcmp) return;
    this.stack.receiveFrame(nic.iface, frame);
  }

  onPowerOn() {
    this.stack.reset();
    this.installServices();
    for (const n of this.nics) this.applyNic(n);
  }

  onPowerOff() {
    this.stack.reset();
    this.http.reset();
    for (const g of this.loadGens) g.stop();
    for (const n of this.nics) {
      n.dhcp.stop();
      if (n.cfg.mode === 'dhcp') {
        n.iface.ip = null;
        n.iface.mask = null;
      }
    }
  }

  onLinkChange(port: Port, up: boolean) {
    const nic = this.nics.find((n) => n.port === port);
    if (!nic) return;
    this.stack.invalidate();
    if (up) {
      if (nic.cfg.mode === 'dhcp') nic.dhcp.start();
      else this.setTimer(10, () => this.stack.gratuitousArp(nic.iface));
    }
    this.updateGateway();
  }

  tick1s() {
    this.stack.tick();
    if (this.hostKind === 'server') {
      this.http.sample();
      this.dhcpService.expire();
    }
    for (const g of this.loadGens) g.tick();
  }

  // ------------------------------------------------------------ Wi-Fi mijoz

  wifiClients() {
    const n = this.wirelessNic;
    if (!n || !this.wifi.enabled || !this.wifi.ssid || !n.port.adminUp) return [];
    return [{ port: n.port, cfg: this.wifi }];
  }

  chooseAp(c: { port: Port; cfg: WifiClientConfig }, radios: { port: Port; cfg: any }[]) {
    return chooseAccessPoint(this, c.cfg, radios);
  }

  onWifiAssociated(_p: Port, ap: Port) {
    this.wifiLog.push(`${ap.device.displayName} (${this.wifi.ssid}) ga ulandi`);
  }

  onWifiDisassociated() {
    this.wifiLog.push(`Wi-Fi uzildi (${this.wifi.ssid})`);
  }

  /** Mavjud Wi-Fi tarmoqlarini skanerlash */
  scanWifi(): { ssid: string; security: WifiSecurity; rssi: number; band: WifiBand; channel: number; ap: string }[] {
    const out: { ssid: string; security: WifiSecurity; rssi: number; band: WifiBand; channel: number; ap: string }[] = [];
    for (const d of this.net.devices) {
      const fn = (d as any).wifiRadios as undefined | (() => { port: Port; cfg: any }[]);
      if (!fn || !d.powered) continue;
      for (const r of fn.call(d)) {
        const dist = Math.hypot(d.x - this.x, d.y - this.y);
        const rssi = wifiRssi(r.cfg.txPower ?? 20, dist, r.cfg.band, this.net.wallsBetween?.(d, this) ?? 0);
        if (rssi < -90 || !r.cfg.broadcastSsid) continue;
        out.push({ ssid: r.cfg.ssid, security: r.cfg.security, rssi: Math.round(rssi), band: r.cfg.band, channel: r.cfg.channel, ap: d.displayName });
      }
    }
    return out.sort((a, b) => b.rssi - a.rssi);
  }

  ipSummary(): string[] {
    return this.nics.filter((n) => n.iface.ip).map((n) => `${n.port.shortName}: ${n.iface.ip}/${n.iface.prefix}`);
  }

  // ------------------------------------------------------------ saqlash
  saveConfig(): any {
    return {
      nics: this.nics.map((n) => ({ port: n.port.name, ...n.cfg })),
      gateway: this.gateway,
      dns: this.dnsServer,
      wifi: this.wifi,
      hardware: this.hardware,
      firewallIcmp: this.firewallIcmp,
      services: this.hostKind === 'server'
        ? {
            http: this.http.enabled,
            https: this.http.httpsEnabled,
            pages: [...this.http.pages.values()],
            dnsEnabled: this.dns.enabled,
            dnsRecords: this.dns.records,
            dhcpEnabled: this.dhcpServiceEnabled,
            dhcpPools: this.dhcpService.pools,
            syslog: this.syslogService.enabled,
          }
        : undefined,
    };
  }

  loadConfig(cfg: any): void {
    if (!cfg) return;
    for (const nc of cfg.nics ?? []) {
      const n = this.nic(nc.port);
      if (n) n.cfg = { mode: nc.mode, ip: nc.ip, mask: nc.mask };
    }
    this.gateway = cfg.gateway ?? '';
    this.dnsServer = cfg.dns ?? '';
    if (cfg.wifi) this.wifi = { ...this.wifi, ...cfg.wifi };
    if (cfg.hardware) this.hardware = { ...this.hardware, ...cfg.hardware };
    if (cfg.firewallIcmp !== undefined) this.firewallIcmp = cfg.firewallIcmp;
    const s = cfg.services;
    if (s) {
      this.http.enabled = s.http;
      this.http.httpsEnabled = s.https;
      if (s.pages) {
        this.http.pages.clear();
        for (const p of s.pages) this.http.pages.set(p.path, p);
      }
      this.dns.enabled = s.dnsEnabled;
      this.dns.records = s.dnsRecords ?? [];
      this.dhcpServiceEnabled = s.dhcpEnabled;
      if (s.dhcpPools) this.dhcpService.pools = s.dhcpPools;
      this.syslogService.enabled = !!s.syslog;
    }
    if (this.powered) {
      if (this.dns.enabled) this.dns.install();
      for (const n of this.nics) this.applyNic(n);
    }
  }
}

/** Wi-Fi mijoz uchun eng yaxshi AP ni tanlash (SSID, xavfsizlik, parol, signal) */
export function chooseAccessPoint(dev: Device, cfg: WifiClientConfig, radios: { port: Port; cfg: any }[]) {
  let best: { port: Port; rssi: number; rate: number } | null = null;
  for (const r of radios) {
    const rc = r.cfg;
    if (!rc.enabled || rc.ssid !== cfg.ssid) continue;
    if (rc.security !== cfg.security) continue;
    if (rc.security !== 'open' && rc.key !== cfg.key) continue;
    if (rc.maxClients && dev.net.wireless.get(r.port) && dev.net.wireless.get(r.port)!.clients.size >= rc.maxClients && !dev.net.wireless.get(r.port)!.clients.has(dev.ports.find((p) => p.media === 'wireless')!)) continue;
    const apDev = r.port.device;
    const dist = Math.hypot(apDev.x - dev.x, apDev.y - dev.y);
    const rssi = wifiRssi(rc.txPower ?? 20, dist, rc.band, dev.net.wallsBetween?.(apDev, dev) ?? 0);
    if (rssi < -85) continue;
    const rate = wifiRate(rssi, rc.band);
    if (!best || rssi > best.rssi) best = { port: r.port, rssi, rate };
  }
  return best;
}
