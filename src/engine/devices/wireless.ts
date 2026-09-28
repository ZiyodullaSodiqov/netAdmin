// Simsiz qurilmalar: Kirish nuqtasi (Access Point) va uy Wi-Fi routeri.
import { Device, DeviceKind } from '../device';
import type { Port } from '../port';
import { defaultSwitchport } from '../port';
import { IpStack } from '../ipstack';
import { L3Interface } from '../l3';
import type { EthernetFrame, DnsMessage } from '../packets';
import { SwitchFabric } from '../switching';
import { CdpAgent, CdpHost } from '../protocols/cdp';
import { DhcpClient, DhcpServer, installDhcpPort67, installDhcpPort68 } from '../protocols/dhcp';
import { DnsResolver } from '../protocols/dns';
import { WifiBand, WifiSecurity } from '../link';
import { generateMac, isValidIp, isValidMask, networkOf, broadcastOf, ipToInt, intToIp, prefixToMask } from '../util';

export interface RadioConfig {
  enabled: boolean;
  ssid: string;
  band: WifiBand;
  channel: number;
  security: WifiSecurity;
  key: string;
  /** dBm */
  txPower: number;
  /** SSID qaysi VLAN ga bog'langan (null — tegsiz/native) */
  vlan: number | null;
  broadcastSsid: boolean;
  maxClients: number;
}

export function defaultRadio(band: WifiBand, ssid: string): RadioConfig {
  return { enabled: true, ssid, band, channel: band === '2.4GHz' ? 6 : 36, security: 'wpa2-psk', key: '', txPower: band === '2.4GHz' ? 20 : 23, vlan: null, broadcastSsid: true, maxClients: 64 };
}

/** SVI uslubidagi boshqaruv interfeysi */
function makeMgmtIface(dev: Device, fabric: SwitchFabric, vlan: number, name: string, mac: string): L3Interface {
  const i = new L3Interface({
    name,
    kind: 'svi',
    mac,
    output: (f) => fabric.sendFromSvi(vlan, f),
    lineUp: () => fabric.ports.some((p) => p.operUp && p.switchport && fabric.portCarriesVlan(p, vlan)),
  });
  i.sviVlan = vlan;
  fabric.svis.set(vlan, i);
  fabric.addCpuMac(vlan, mac);
  return i;
}

// ======================================================================= Access Point

export class AccessPoint extends Device implements CdpHost {
  readonly kind: DeviceKind = 'accesspoint';
  stack: IpStack;
  fabric: SwitchFabric;
  cdp: CdpAgent;
  uplink: Port;
  radios: { port: Port; cfg: RadioConfig }[] = [];
  mgmt: L3Interface;
  mgmtDhcp: DhcpClient;
  mgmtCfg = { mode: 'dhcp' as 'dhcp' | 'static', ip: '', mask: '', gw: '' };
  platform = 'AIR-AP2802I-E-K9';
  capabilities = 'T B I';
  version = 'Cisco AP Software, ap3g3 Version 8.10';
  baseMac: string;

  constructor(label = 'AccessPoint0', id?: string) {
    super('AIR-AP2802', label, id);
    this.procDelayMs = 0.03;
    this.poeRequiredW = 12.95;
    this.acPower = false;
    this.baseMac = generateMac('00:3a:98');
    this.uplink = this.addPort({ name: 'GigabitEthernet0', media: 'copper', speeds: [10, 100, 1000], mdi: 'MDI', autoMdix: true, poePd: true }, '00:3a:98');
    const r0 = this.addPort({ name: 'Dot11Radio0', media: 'wireless', speeds: [144], mdi: 'MDI', autoMdix: false, label: '2.4 GHz' }, '00:3a:98');
    const r1 = this.addPort({ name: 'Dot11Radio1', media: 'wireless', speeds: [867], mdi: 'MDI', autoMdix: false, label: '5 GHz' }, '00:3a:98');
    this.radios.push({ port: r0, cfg: defaultRadio('2.4GHz', 'Office-WiFi') });
    this.radios.push({ port: r1, cfg: { ...defaultRadio('5GHz', 'Office-WiFi'), enabled: false } });
    this.fabric = new SwitchFabric(this, this.baseMac);
    this.fabric.stp.enabled = false;
    this.fabric.deliverToSvi = (svi, f) => this.stack.receiveFrame(svi, f);
    for (const p of [this.uplink, r0, r1]) {
      this.fabric.addPort(p, 'access');
      p.switchport!.portfast = true;
    }
    this.stack = new IpStack(this, { ipRouting: false, defaultTtl: 255, arpQueue: 3 });
    this.mgmt = makeMgmtIface(this, this.fabric, 1, 'BVI1', this.baseMac);
    this.stack.addInterface(this.mgmt);
    this.mgmtDhcp = new DhcpClient(this.stack, this.mgmt, { hostname: () => this.label, apipa: false, onBound: () => this.onMgmtBound() });
    installDhcpPort68(this.stack, () => [this.mgmtDhcp]);
    this.cdp = new CdpAgent(this);
    this.applyRadioVlans();
  }

  get device() {
    return this;
  }

  cdpPorts() {
    return [this.uplink];
  }
  address() {
    return this.mgmt.ip ?? undefined;
  }
  portVlanInfo() {
    return {};
  }
  sendCdp(p: Port, f: EthernetFrame) {
    p.send(f);
  }

  /** SSID -> VLAN bog'lanishi: VLAN ishlatilsa uplink trunk bo'ladi */
  applyRadioVlans() {
    const f = this.fabric;
    const vlans = new Set<number>([1]);
    for (const r of this.radios) {
      const v = r.cfg.vlan ?? 1;
      vlans.add(v);
      f.createVlan(v);
      r.port.switchport!.accessVlan = v;
      r.port.adminUp = r.cfg.enabled;
    }
    const sp = this.uplink.switchport!;
    if (vlans.size > 1) {
      sp.mode = 'trunk';
      sp.operMode = 'trunk';
      sp.allowedVlans = vlans;
      sp.nativeVlan = 1;
    } else {
      sp.mode = 'access';
      sp.operMode = 'access';
      sp.accessVlan = 1;
    }
    f.flushAll();
    this.net?.refresh();
  }

  wifiRadios() {
    return this.radios.filter((r) => r.cfg.enabled && r.port.adminUp);
  }

  receive(port: Port, f: EthernetFrame) {
    if (f.payload.kind === 'cdp') {
      this.cdp.receive(port, f.payload);
      return;
    }
    this.fabric.ingress(port, f);
  }

  onPowerOn() {
    this.stack.reset();
    this.fabric.flushAll();
    this.applyMgmt();
    if (this.uplink.operUp) this.cdp.start();
  }

  onPowerOff() {
    this.stack.reset();
    this.cdp.halt();
    this.mgmtDhcp.stop();
  }

  onLinkChange(port: Port, up: boolean) {
    if (port !== this.uplink) return;
    if (up) {
      this.cdp.start();
      this.cdp.linkUp(port);
      if (this.mgmtCfg.mode === 'dhcp') this.mgmtDhcp.start();
    } else this.cdp.linkDown(port);
  }

  applyMgmt() {
    if (this.mgmtCfg.mode === 'dhcp') {
      this.mgmt.dhcp = true;
      if (this.powered && this.uplink.operUp) this.mgmtDhcp.start();
    } else {
      this.mgmtDhcp.stop();
      this.mgmt.dhcp = false;
      this.mgmt.ip = isValidIp(this.mgmtCfg.ip) ? this.mgmtCfg.ip : null;
      this.mgmt.mask = isValidMask(this.mgmtCfg.mask) ? this.mgmtCfg.mask : null;
      this.stack.defaultGateway = this.mgmtCfg.gw || null;
    }
    this.stack.invalidate();
  }

  private onMgmtBound() {
    this.stack.defaultGateway = this.mgmt.dhcpState?.gateway ?? null;
    this.stack.invalidate();
  }

  tick1s() {
    this.stack.tick();
    this.fabric.ageMacs();
  }

  ipSummary() {
    return [...(this.mgmt.ip ? [`BVI1: ${this.mgmt.ip}`] : []), ...this.radios.filter((r) => r.cfg.enabled).map((r) => `${r.cfg.band}: "${r.cfg.ssid}"`)];
  }

  saveConfig() {
    return { radios: this.radios.map((r) => r.cfg), mgmt: this.mgmtCfg, acPower: this.acPower };
  }

  loadConfig(cfg: any) {
    if (!cfg) return;
    cfg.radios?.forEach((c: RadioConfig, i: number) => this.radios[i] && (this.radios[i].cfg = { ...this.radios[i].cfg, ...c }));
    if (cfg.mgmt) this.mgmtCfg = cfg.mgmt;
    if (cfg.acPower !== undefined) this.acPower = cfg.acPower;
    this.applyRadioVlans();
    if (this.powered) this.applyMgmt();
  }
}

// ======================================================================= Uy routeri

export interface HomeRouterConfig {
  lanIp: string;
  lanMask: string;
  dhcpEnabled: boolean;
  dhcpStart: string;
  dhcpMax: number;
  wanMode: 'dhcp' | 'static';
  wanIp: string;
  wanMask: string;
  wanGw: string;
  wanDns: string;
  portForwards: { proto: 'tcp' | 'udp'; extPort: number; ip: string; intPort: number }[];
  adminPassword: string;
}

export class HomeRouter extends Device {
  readonly kind: DeviceKind = 'homerouter';
  stack: IpStack;
  fabric: SwitchFabric;
  wan: Port;
  lanPorts: Port[] = [];
  radios: { port: Port; cfg: RadioConfig }[] = [];
  wanIface: L3Interface;
  lanIface: L3Interface;
  wanDhcp: DhcpClient;
  dhcpServer: DhcpServer;
  resolver: DnsResolver;
  cfg: HomeRouterConfig = {
    lanIp: '192.168.0.1',
    lanMask: '255.255.255.0',
    dhcpEnabled: true,
    dhcpStart: '192.168.0.100',
    dhcpMax: 50,
    wanMode: 'dhcp',
    wanIp: '',
    wanMask: '',
    wanGw: '',
    wanDns: '',
    portForwards: [],
    adminPassword: 'admin',
  };
  baseMac: string;
  private dnsPending = new Map<number, { src: string; port: number; txid: number }>();

  constructor(label = 'WiFi-Router0', id?: string) {
    super('WRT-AC1200', label, id);
    this.procDelayMs = 0.1;
    this.baseMac = generateMac('c0:4a:00');
    this.wan = this.addPort({ name: 'Internet', media: 'copper', speeds: [10, 100, 1000], mdi: 'MDI', autoMdix: true, label: 'WAN' }, 'c0:4a:00');
    for (let i = 1; i <= 4; i++) this.lanPorts.push(this.addPort({ name: `Ethernet${i}`, media: 'copper', speeds: [10, 100, 1000], mdi: 'MDIX', autoMdix: true }, 'c0:4a:00'));
    const r0 = this.addPort({ name: 'Wireless2.4', media: 'wireless', speeds: [300], mdi: 'MDI', autoMdix: false, label: '2.4 GHz' }, 'c0:4a:00');
    const r1 = this.addPort({ name: 'Wireless5', media: 'wireless', speeds: [867], mdi: 'MDI', autoMdix: false, label: '5 GHz' }, 'c0:4a:00');
    this.radios.push({ port: r0, cfg: { ...defaultRadio('2.4GHz', 'Uy-WiFi'), key: '12345678' } });
    this.radios.push({ port: r1, cfg: { ...defaultRadio('5GHz', 'Uy-WiFi-5G'), key: '12345678' } });
    this.fabric = new SwitchFabric(this, this.baseMac);
    this.fabric.stp.enabled = false;
    this.fabric.deliverToSvi = (svi, f) => this.stack.receiveFrame(svi, f);
    for (const p of [...this.lanPorts, r0, r1]) {
      this.fabric.addPort(p, 'access');
      p.switchport!.portfast = true;
    }
    this.stack = new IpStack(this, { ipRouting: true, defaultTtl: 64, arpQueue: 3, arpTimeoutMs: 60_000 });
    this.wanIface = new L3Interface({ name: 'Internet', kind: 'physical', mac: this.wan.mac, port: this.wan, output: (f) => this.wan.send(f), lineUp: () => this.wan.operUp });
    this.stack.addInterface(this.wanIface);
    this.lanIface = makeMgmtIface(this, this.fabric, 1, 'LAN', this.baseMac);
    this.stack.addInterface(this.lanIface);
    this.wanDhcp = new DhcpClient(this.stack, this.wanIface, {
      hostname: () => this.label,
      apipa: false,
      onBound: () => this.applyWanFromDhcp(),
    });
    installDhcpPort68(this.stack, () => [this.wanDhcp]);
    this.dhcpServer = new DhcpServer(this.stack);
    installDhcpPort67(this.stack, () => (this.cfg.dhcpEnabled ? this.dhcpServer : null));
    this.resolver = new DnsResolver(this.stack);
    this.stack.proxyArp = false;
    this.applyConfig();
  }

  wifiRadios() {
    return this.radios.filter((r) => r.cfg.enabled);
  }

  applyRadios() {
    for (const r of this.radios) r.port.adminUp = r.cfg.enabled;
    this.net?.refresh();
  }

  /** GUI sozlamalarini qo'llash */
  applyConfig() {
    const c = this.cfg;
    this.lanIface.ip = isValidIp(c.lanIp) ? c.lanIp : '192.168.0.1';
    this.lanIface.mask = isValidMask(c.lanMask) ? c.lanMask : '255.255.255.0';
    this.lanIface.natRole = 'inside';
    this.wanIface.natRole = 'outside';
    const net = networkOf(this.lanIface.ip, this.lanIface.mask);
    this.dhcpServer.pools = [{ name: 'LAN', network: net, mask: this.lanIface.mask, startIp: c.dhcpStart, maxUsers: c.dhcpMax, defaultRouter: this.lanIface.ip, dns: [this.lanIface.ip], leaseSec: 86400 }];
    // NAT: LAN -> Internet (PAT)
    const acls = this.stack.acls;
    acls.acls.clear();
    const wild = intToIp(~ipToInt(this.lanIface.mask) >>> 0);
    acls.add('LAN', 'standard', { action: 'permit', proto: 'ip', src: { net, wildcard: wild } });
    const nat = this.stack.nat;
    nat.rules = [{ acl: 'LAN', iface: 'Internet', overload: true }];
    nat.statics = c.portForwards.map((f) => ({ local: f.ip, global: this.wanIface.ip ?? '0.0.0.0', proto: f.proto, localPort: f.intPort, globalPort: f.extPort }));
    // WAN
    if (c.wanMode === 'dhcp') {
      this.wanIface.dhcp = true;
      this.stack.staticRoutes = [];
      if (this.powered && this.wan.operUp) this.wanDhcp.start();
    } else {
      this.wanDhcp.stop();
      this.wanIface.dhcp = false;
      this.wanIface.ip = isValidIp(c.wanIp) ? c.wanIp : null;
      this.wanIface.mask = isValidMask(c.wanMask) ? c.wanMask : null;
      this.stack.staticRoutes = isValidIp(c.wanGw) ? [{ network: '0.0.0.0', mask: '0.0.0.0', nextHop: c.wanGw, ifaceName: null, ad: 1 }] : [];
      this.stack.dnsServers = isValidIp(c.wanDns) ? [c.wanDns] : [];
      this.refreshForwards();
    }
    this.stack.invalidate();
    this.net?.bump();
  }

  private refreshForwards() {
    this.stack.nat.statics = this.cfg.portForwards.map((f) => ({ local: f.ip, global: this.wanIface.ip ?? '0.0.0.0', proto: f.proto, localPort: f.intPort, globalPort: f.extPort }));
  }

  private applyWanFromDhcp() {
    const st = this.wanIface.dhcpState!;
    this.stack.staticRoutes = st.gateway ? [{ network: '0.0.0.0', mask: '0.0.0.0', nextHop: st.gateway, ifaceName: null, ad: 254 }] : [];
    this.stack.dnsServers = st.dns ?? [];
    this.refreshForwards();
    this.stack.invalidate();
  }

  /** LAN dagi qurilmalar uchun DNS proksi (router IP si DNS sifatida beriladi) */
  private installDnsProxy() {
    this.stack.udpBind(53, (pkt, udp) => {
      const m = udp.payload as DnsMessage;
      if (m.kind !== 'dns' || m.qr !== 'query') return;
      this.resolver.resolve(m.name, (ip, err) => {
        const res: DnsMessage = { kind: 'dns', qr: 'response', txid: m.txid, name: m.name, qtype: 'A', answers: ip ? [{ name: m.name, type: 'A', value: ip, ttl: 300 }] : [], rcode: ip ? 'NOERROR' : err === 'NXDOMAIN' ? 'NXDOMAIN' : 'SERVFAIL' };
        this.stack.sendUdp(pkt.src, 53, udp.srcPort, res, { src: pkt.dst });
      });
    });
    // Admin panel (http://192.168.0.1)
    this.stack.tcp.listen(80, (c) => {
      if (c.localIp !== this.lanIface.ip) return null;
      return {
        onData: (conn, msg) => {
          if (msg.kind !== 'http-req') return;
          conn.send({ kind: 'http-res', status: 200, statusText: 'OK', size: 8000, reqId: msg.reqId, serverMs: 5, body: `<title>${this.label} — Admin</title><h1>${this.model} boshqaruv paneli</h1><p>WAN: ${this.wanIface.ip ?? 'ulanmagan'} · LAN: ${this.lanIface.ip} · Wi-Fi: ${this.radios.map((r) => r.cfg.ssid).join(', ')}</p><p>Mijozlar: ${[...this.dhcpServer.bindings.values()].filter((b) => b.state === 'bound').length}</p>` });
        },
      };
    });
  }

  receive(port: Port, f: EthernetFrame) {
    if (port === this.wan) {
      if (f.vlan !== undefined) return;
      if (f.payload.kind === 'cdp' || f.payload.kind === 'bpdu' || f.payload.kind === 'dtp') return;
      this.stack.receiveFrame(this.wanIface, f);
      return;
    }
    if (f.payload.kind === 'cdp' || f.payload.kind === 'dtp') return;
    this.fabric.ingress(port, f);
  }

  onPowerOn() {
    this.stack.reset();
    this.fabric.flushAll();
    this.installDnsProxy();
    this.applyRadios();
    this.applyConfig();
  }

  onPowerOff() {
    this.stack.reset();
    this.wanDhcp.stop();
    this.dhcpServer.bindings.clear();
    if (this.cfg.wanMode === 'dhcp') {
      this.wanIface.ip = null;
      this.wanIface.mask = null;
    }
  }

  onLinkChange(port: Port, up: boolean) {
    if (port === this.wan && up && this.cfg.wanMode === 'dhcp') this.wanDhcp.start();
    this.stack.invalidate();
  }

  tick1s() {
    this.stack.tick();
    this.fabric.ageMacs();
    this.dhcpServer.expire();
  }

  ipSummary() {
    return [`WAN: ${this.wanIface.ip ?? '—'}`, `LAN: ${this.lanIface.ip}`, ...this.radios.filter((r) => r.cfg.enabled).map((r) => `Wi-Fi: "${r.cfg.ssid}"`)];
  }

  saveConfig() {
    return { cfg: this.cfg, radios: this.radios.map((r) => r.cfg) };
  }

  loadConfig(c: any) {
    if (!c) return;
    if (c.cfg) this.cfg = { ...this.cfg, ...c.cfg };
    c.radios?.forEach((rc: RadioConfig, i: number) => this.radios[i] && (this.radios[i].cfg = { ...this.radios[i].cfg, ...rc }));
    this.applyRadios();
    this.applyConfig();
  }
}

export { broadcastOf, prefixToMask, defaultSwitchport };
