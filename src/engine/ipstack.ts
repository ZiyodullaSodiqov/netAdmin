// IPv4 steki: ARP, marshrutlash, ICMP, UDP, TCP, NAT, ACL.
import type { Device } from './device';
import { L3Interface } from './l3';
import {
  ArpPacket,
  EthernetFrame,
  IPv4Packet,
  IcmpMessage,
  UdpDatagram,
  TcpSegment,
  nextFrameId,
  ipPacketSize,
} from './packets';
import {
  BROADCAST_MAC,
  MAC,
  broadcastOf,
  inNetwork,
  ipToInt,
  isMulticastIp,
  isValidIp,
  maskToPrefix,
  networkOf,
  prefixToMask,
} from './util';
import { TcpStack } from './protocols/tcp';
import { AclTable } from './protocols/acl';
import { NatTable } from './protocols/nat';

export type RouteCode = 'C' | 'L' | 'S' | 'S*' | 'O' | 'O*E2' | 'R' | 'D';

export interface Route {
  code: RouteCode;
  network: string;
  mask: string;
  prefix: number;
  iface: L3Interface | null;
  nextHop: string | null;
  ad: number;
  metric: number;
  age?: number;
}

export interface StaticRoute {
  network: string;
  mask: string;
  nextHop: string | null;
  ifaceName: string | null;
  ad: number;
  permanent?: boolean;
}

export interface ArpEntry {
  mac: MAC;
  iface: L3Interface;
  created: number;
  expires: number; // Infinity — statik
  type: 'dynamic' | 'static';
}

interface PendingArp {
  iface: L3Interface;
  queue: IPv4Packet[];
  tries: number;
  timer: ReturnType<Device['setTimer']> | null;
}

export type UdpHandler = (pkt: IPv4Packet, udp: UdpDatagram, iface: L3Interface | null) => void;
export type IcmpListener = (pkt: IPv4Packet, icmp: IcmpMessage) => void;

export interface StackOptions {
  ipRouting: boolean;
  defaultTtl: number;
  /** ARP hal qilinmaguncha navbatda saqlanadigan paketlar (Cisco IOS — 0: birinchi paket tashlanadi) */
  arpQueue: number;
  arpTimeoutMs: number;
  /** ICMP xato xabarlari tezligini cheklash (ms) */
  icmpRateLimitMs: number;
}

export type SendResult = 'ok' | 'no-route' | 'no-iface' | 'acl-deny' | 'arp-pending';

let ipIdCounter = 1;

export class IpStack {
  device: Device;
  interfaces: L3Interface[] = [];
  opts: StackOptions;
  /** Kompyuter / L2 switch uchun default gateway */
  defaultGateway: string | null = null;
  staticRoutes: StaticRoute[] = [];
  dnsServers: string[] = [];
  domainName = '';
  arp = new Map<string, ArpEntry>();
  private pending = new Map<string, PendingArp>();
  private udpHandlers = new Map<number, UdpHandler>();
  private icmpListeners = new Map<number, IcmpListener>();
  /** Boshqa manbalardan (OSPF, DHCP default route) qo'shiladigan marshrutlar */
  routeProviders: (() => Route[])[] = [];
  protocolHandlers: Partial<Record<'OSPF', (pkt: IPv4Packet, iface: L3Interface) => void>> = {};
  tcp: TcpStack;
  acls = new AclTable();
  nat = new NatTable(this);
  private lastIcmpError = -1e9;
  private routeCache: { version: number; routes: Route[] } | null = null;
  private localVersion = 0;
  stats = { forwarded: 0, delivered: 0, dropped: 0, noRoute: 0, ttlExpired: 0, aclDenied: 0 };
  /** Paket tashlanganda (UI uchun) */
  onDrop?: (pkt: IPv4Packet, reason: string) => void;

  constructor(device: Device, opts: Partial<StackOptions> = {}) {
    this.device = device;
    this.opts = { ipRouting: false, defaultTtl: 128, arpQueue: 3, arpTimeoutMs: 120_000, icmpRateLimitMs: 0, ...opts };
    this.tcp = new TcpStack(this);
  }

  get now() {
    return this.device.now;
  }

  invalidate() {
    this.localVersion++;
    this.routeCache = null;
  }

  addInterface(i: L3Interface) {
    this.interfaces.push(i);
    this.invalidate();
    return i;
  }

  removeInterface(i: L3Interface) {
    this.interfaces = this.interfaces.filter((x) => x !== i);
    for (const [ip, e] of [...this.arp]) if (e.iface === i) this.arp.delete(ip);
    this.invalidate();
  }

  iface(name: string) {
    return this.interfaces.find((i) => i.name === name || i.name.toLowerCase() === name.toLowerCase());
  }

  /** Ushbu IP qurilmaga tegishlimi (ishlayotgan interfeyslarda) */
  isLocalIp(ip: string): L3Interface | undefined {
    return this.interfaces.find((i) => i.ip === ip && i.up);
  }

  ownsIp(ip: string) {
    return this.interfaces.some((i) => i.ip === ip);
  }

  /** Qurilma yoqilganda/o'chganda dinamik holatni tozalash */
  reset() {
    for (const [ip, e] of [...this.arp]) if (e.type === 'dynamic') this.arp.delete(ip);
    for (const p of this.pending.values()) this.device.clearTimer(p.timer);
    this.pending.clear();
    this.tcp.reset();
    this.nat.clearDynamic();
    this.invalidate();
  }

  // ================================================================ marshrutlash jadvali

  routes(): Route[] {
    const v = this.device.net.version * 100000 + this.localVersion;
    if (this.routeCache && this.routeCache.version === v) return this.routeCache.routes;
    const routes: Route[] = [];
    for (const i of this.interfaces) {
      if (!i.up || !i.hasIp) continue;
      const prefix = maskToPrefix(i.mask!);
      routes.push({ code: 'C', network: networkOf(i.ip!, i.mask!), mask: i.mask!, prefix, iface: i, nextHop: null, ad: 0, metric: 0 });
      if (this.opts.ipRouting && prefix < 32) routes.push({ code: 'L', network: i.ip!, mask: '255.255.255.255', prefix: 32, iface: i, nextHop: null, ad: 0, metric: 0 });
    }
    const connected = routes.slice();
    const resolvable = (nh: string) => connected.find((r) => r.code === 'C' && inNetwork(nh, r.network, r.mask));
    for (const s of this.staticRoutes) {
      let iface: L3Interface | null = null;
      if (s.ifaceName) {
        iface = this.iface(s.ifaceName) ?? null;
        if (!iface || !iface.up) continue;
      }
      if (s.nextHop) {
        const c = resolvable(s.nextHop);
        // rekursiv qidiruv: next-hop boshqa statik marshrut orqali ham topilishi mumkin
        if (!c && !iface) {
          const viaOther = this.staticRoutes.some((o) => o !== s && o.nextHop && resolvable(o.nextHop) && inNetwork(s.nextHop!, o.network, o.mask));
          if (!viaOther) continue;
        }
        if (c && !iface) iface = null;
      }
      const prefix = maskToPrefix(s.mask);
      routes.push({ code: prefix === 0 ? 'S*' : 'S', network: networkOf(s.network, s.mask), mask: s.mask, prefix, iface, nextHop: s.nextHop, ad: s.ad, metric: 0 });
    }
    for (const p of this.routeProviders) routes.push(...p());
    if (!this.opts.ipRouting && this.defaultGateway && isValidIp(this.defaultGateway) && !routes.some((r) => r.prefix === 0)) {
      if (resolvable(this.defaultGateway)) routes.push({ code: 'S*', network: '0.0.0.0', mask: '0.0.0.0', prefix: 0, iface: null, nextHop: this.defaultGateway, ad: 1, metric: 0 });
    }
    // bir xil prefiks uchun eng kichik AD tanlanadi
    const best = new Map<string, Route>();
    const result: Route[] = [];
    for (const r of routes) {
      if (r.code === 'C' || r.code === 'L') {
        result.push(r);
        continue;
      }
      const k = `${r.network}/${r.prefix}`;
      const cur = best.get(k);
      if (!cur || r.ad < cur.ad || (r.ad === cur.ad && r.metric < cur.metric)) best.set(k, r);
    }
    for (const r of best.values()) {
      if (result.some((c) => c.code === 'C' && c.network === r.network && c.prefix === r.prefix)) continue;
      result.push(r);
    }
    result.sort((a, b) => ipToInt(a.network) - ipToInt(b.network) || a.prefix - b.prefix);
    this.routeCache = { version: v, routes: result };
    return result;
  }

  /** Eng uzun prefiks bo'yicha qidiruv; next-hop rekursiv hal qilinadi */
  lookup(dst: string, depth = 0): { route: Route; iface: L3Interface; nextHop: string } | null {
    if (depth > 4) return null;
    const d = ipToInt(dst);
    let best: Route | null = null;
    for (const r of this.routes()) {
      const m = ipToInt(r.mask);
      if (((d & m) >>> 0) !== ipToInt(r.network)) continue;
      if (!best || r.prefix > best.prefix || (r.prefix === best.prefix && r.ad < best.ad)) best = r;
    }
    if (!best) return null;
    if (best.iface && !best.nextHop) return { route: best, iface: best.iface, nextHop: dst };
    if (best.iface && best.nextHop) return { route: best, iface: best.iface, nextHop: best.nextHop };
    const sub = this.lookup(best.nextHop!, depth + 1);
    if (!sub) return null;
    return { route: best, iface: sub.iface, nextHop: sub.nextHop };
  }

  // ================================================================ qabul qilish

  /** L2 dan kelgan kadr (dst MAC tekshirilgan) */
  receiveFrame(iface: L3Interface, frame: EthernetFrame) {
    if (!iface.adminUp) return;
    const p = frame.payload;
    if (p.kind === 'arp') {
      this.handleArp(iface, p);
      return;
    }
    if (p.kind !== 'ipv4') return;
    if (frame.dst !== iface.mac && frame.dst !== BROADCAST_MAC && !frame.dst.startsWith('01:00:5e')) return;
    iface.counters.inPkts++;
    iface.counters.inBytes += ipPacketSize(p);
    this.handleIp(iface, p, frame);
  }

  private handleArp(iface: L3Interface, a: ArpPacket) {
    if (!iface.hasIp && !iface.dhcpState) return;
    const known = this.arp.get(a.senderIp);
    const forMe = iface.hasIp && a.targetIp === iface.ip;
    if (a.senderIp !== '0.0.0.0' && (forMe || (known && known.type === 'dynamic'))) {
      if (!(known && known.type === 'static')) this.learnArp(a.senderIp, a.senderMac, iface);
    }
    if (a.op === 'request' && forMe && a.senderIp !== a.targetIp) {
      const reply: ArpPacket = { kind: 'arp', op: 'reply', senderMac: iface.mac, senderIp: iface.ip!, targetMac: a.senderMac, targetIp: a.senderIp };
      iface.output({ id: nextFrameId(), src: iface.mac, dst: a.senderMac, etherType: 'ARP', payload: reply });
    } else if (a.op === 'request' && this.opts.ipRouting && iface.hasIp && a.targetIp !== iface.ip && this.proxyArp && inNetwork(a.senderIp, iface.network!, iface.mask!)) {
      // Proxy ARP (Cisco default): boshqa tarmoqqa marshrut bo'lsa, router o'z MAC i bilan javob beradi
      const r = this.lookup(a.targetIp);
      if (r && r.iface !== iface && !inNetwork(a.targetIp, iface.network!, iface.mask!)) {
        const reply: ArpPacket = { kind: 'arp', op: 'reply', senderMac: iface.mac, senderIp: a.targetIp, targetMac: a.senderMac, targetIp: a.senderIp };
        iface.output({ id: nextFrameId(), src: iface.mac, dst: a.senderMac, etherType: 'ARP', payload: reply });
      }
    }
    // duplicate IP aniqlash (gratuitous ARP)
    if (iface.hasIp && a.senderIp === iface.ip && a.senderMac !== iface.mac) {
      this.onDuplicateIp?.(iface, a.senderMac);
    }
  }

  proxyArp = true;
  onDuplicateIp?: (iface: L3Interface, mac: MAC) => void;

  learnArp(ip: string, mac: MAC, iface: L3Interface) {
    const now = this.now;
    const cur = this.arp.get(ip);
    this.arp.set(ip, { mac, iface, created: cur && cur.mac === mac ? cur.created : now, expires: now + this.opts.arpTimeoutMs, type: 'dynamic' });
    const pend = this.pending.get(ip);
    if (pend) {
      this.device.clearTimer(pend.timer);
      this.pending.delete(ip);
      for (const pkt of pend.queue) this.transmitTo(pend.iface, pkt, mac);
    }
  }

  private handleIp(iface: L3Interface, pkt: IPv4Packet, frame: EthernetFrame) {
    // Kiruvchi ACL
    if (iface.aclIn && !this.acls.permits(iface.aclIn, pkt)) {
      this.stats.aclDenied++;
      this.drop(pkt, `ACL ${iface.aclIn} (in) tomonidan rad etildi`);
      this.sendIcmpError(pkt, 'dest-unreachable', 13, iface);
      return;
    }
    // Tashqi (outside) NAT interfeysida teskari tarjima
    if (iface.natRole === 'outside') pkt = this.nat.untranslate(pkt);

    const local = this.isForMe(iface, pkt);
    if (local) {
      this.deliverLocal(iface, pkt);
      return;
    }
    if (!this.opts.ipRouting) return;
    if (pkt.dst === '255.255.255.255' || isMulticastIp(pkt.dst)) return;
    this.forward(iface, pkt);
  }

  private isForMe(iface: L3Interface, pkt: IPv4Packet): boolean {
    if (pkt.dst === '255.255.255.255') return true;
    if (isMulticastIp(pkt.dst)) return true;
    if (this.isLocalIp(pkt.dst)) return true;
    if (iface.hasIp && pkt.dst === broadcastOf(iface.ip!, iface.mask!)) return true;
    // DHCP javoblari: IP hali yo'q
    if (!iface.hasIp && pkt.protocol === 'UDP') return true;
    return false;
  }

  private deliverLocal(iface: L3Interface, pkt: IPv4Packet) {
    this.stats.delivered++;
    const pl = pkt.payload;
    switch (pl.kind) {
      case 'icmp':
        this.handleIcmp(iface, pkt, pl);
        break;
      case 'udp': {
        const h = this.udpHandlers.get(pl.dstPort);
        if (h) h(pkt, pl, iface);
        else if (pkt.dst !== '255.255.255.255' && !isMulticastIp(pkt.dst) && !(iface.hasIp && pkt.dst === broadcastOf(iface.ip!, iface.mask!)) && this.isLocalIp(pkt.dst))
          this.sendIcmpError(pkt, 'dest-unreachable', 3, iface);
        break;
      }
      case 'tcp':
        if (this.isLocalIp(pkt.dst)) this.tcp.receive(pkt, pl, iface);
        break;
      case 'ospf':
        this.protocolHandlers.OSPF?.(pkt, iface);
        break;
    }
  }

  private handleIcmp(iface: L3Interface, pkt: IPv4Packet, icmp: IcmpMessage) {
    if (icmp.type === 'echo-request') {
      if (pkt.dst === '255.255.255.255' || isMulticastIp(pkt.dst)) return;
      if (this.respondToPing === false) return;
      const src = this.isLocalIp(pkt.dst) ? pkt.dst : iface.ip!;
      this.sendIp({
        kind: 'ipv4',
        src,
        dst: pkt.src,
        ttl: this.opts.defaultTtl,
        protocol: 'ICMP',
        id: ipIdCounter++,
        dscp: 0,
        payload: { kind: 'icmp', type: 'echo-reply', code: 0, ident: icmp.ident, seq: icmp.seq, dataSize: icmp.dataSize },
      });
      return;
    }
    const ident = icmp.type === 'echo-reply' ? icmp.ident : icmp.original?.ident ?? icmp.original?.srcPort;
    if (ident !== undefined) {
      const l = this.icmpListeners.get(ident);
      if (l) l(pkt, icmp);
    }
    // TCP/UDP ga xato xabarini yetkazish
    if (icmp.type === 'dest-unreachable' && icmp.original?.protocol === 'TCP') this.tcp.onIcmpError(icmp);
  }

  /** Windows firewall kabi — ping javobini o'chirish mumkin */
  respondToPing = true;

  // ================================================================ yo'naltirish (forwarding)

  private forward(inIface: L3Interface, pkt: IPv4Packet) {
    if (pkt.ttl <= 1) {
      this.stats.ttlExpired++;
      this.drop(pkt, 'TTL tugadi');
      this.sendIcmpError(pkt, 'time-exceeded', 0, inIface);
      return;
    }
    const r = this.lookup(pkt.dst);
    if (!r) {
      this.stats.noRoute++;
      this.drop(pkt, `${pkt.dst} uchun marshrut yo'q`);
      this.sendIcmpError(pkt, 'dest-unreachable', 1, inIface);
      return;
    }
    let out: IPv4Packet = { ...pkt, ttl: pkt.ttl - 1 };
    if (inIface.natRole === 'inside' && r.iface.natRole === 'outside') {
      const t = this.nat.translate(out, r.iface);
      if (!t) {
        this.drop(pkt, 'NAT: tarjima qilinmadi (ACL mos kelmadi)');
      } else out = t;
    }
    if (r.iface.aclOut && !this.acls.permits(r.iface.aclOut, out)) {
      this.stats.aclDenied++;
      this.drop(pkt, `ACL ${r.iface.aclOut} (out) tomonidan rad etildi`);
      this.sendIcmpError(pkt, 'dest-unreachable', 13, inIface);
      return;
    }
    this.stats.forwarded++;
    this.resolveAndSend(r.iface, r.nextHop, out);
  }

  private drop(pkt: IPv4Packet, reason: string) {
    this.stats.dropped++;
    this.onDrop?.(pkt, reason);
  }

  sendIcmpError(orig: IPv4Packet, type: 'dest-unreachable' | 'time-exceeded', code: number, iface: L3Interface) {
    if (orig.payload.kind === 'icmp' && orig.payload.type !== 'echo-request' && orig.payload.type !== 'echo-reply') return;
    if (orig.dst === '255.255.255.255' || isMulticastIp(orig.dst) || orig.src === '0.0.0.0') return;
    const now = this.now;
    if (this.opts.icmpRateLimitMs && now - this.lastIcmpError < this.opts.icmpRateLimitMs) return;
    this.lastIcmpError = now;
    const src = iface.ip ?? this.interfaces.find((i) => i.hasIp && i.up)?.ip;
    if (!src) return;
    const pl = orig.payload;
    const original: IcmpMessage['original'] = { src: orig.src, dst: orig.dst, protocol: orig.protocol };
    if (pl.kind === 'icmp') {
      original.ident = pl.ident;
      original.seq = pl.seq;
    } else if (pl.kind === 'udp' || pl.kind === 'tcp') {
      original.srcPort = pl.srcPort;
      original.dstPort = pl.dstPort;
    }
    this.sendIp({
      kind: 'ipv4',
      src,
      dst: orig.src,
      ttl: this.opts.defaultTtl,
      protocol: 'ICMP',
      id: ipIdCounter++,
      dscp: 0,
      payload: { kind: 'icmp', type, code, ident: 0, seq: 0, dataSize: 0, original },
    });
  }

  // ================================================================ jo'natish

  newPacket(p: Omit<IPv4Packet, 'kind' | 'id' | 'ttl' | 'dscp'> & Partial<Pick<IPv4Packet, 'ttl' | 'dscp'>>): IPv4Packet {
    return { kind: 'ipv4', id: ipIdCounter++, ttl: p.ttl ?? this.opts.defaultTtl, dscp: p.dscp ?? 0, ...p } as IPv4Packet;
  }

  /** Qurilmaning o'zidan chiqadigan paket */
  sendIp(pkt: IPv4Packet, opts: { iface?: L3Interface; broadcastMac?: boolean } = {}): SendResult {
    // o'ziga
    if (this.isLocalIp(pkt.dst) && !opts.iface) {
      const iface = this.isLocalIp(pkt.dst)!;
      if (!pkt.src || pkt.src === '0.0.0.0') pkt = { ...pkt, src: pkt.dst };
      this.device.setTimer(0.01, () => this.deliverLocal(iface, pkt));
      return 'ok';
    }
    if (opts.iface) {
      const iface = opts.iface;
      if (!iface.up) return 'no-iface';
      if (pkt.dst === '255.255.255.255' || opts.broadcastMac || (iface.hasIp && pkt.dst === broadcastOf(iface.ip!, iface.mask!))) {
        this.transmitTo(iface, pkt, BROADCAST_MAC);
        return 'ok';
      }
      if (isMulticastIp(pkt.dst)) {
        const b = pkt.dst.split('.').map(Number);
        const mac = `01:00:5e:${(b[1] & 0x7f).toString(16).padStart(2, '0')}:${b[2].toString(16).padStart(2, '0')}:${b[3].toString(16).padStart(2, '0')}`;
        this.transmitTo(iface, pkt, mac);
        return 'ok';
      }
      const nh = iface.hasIp && inNetwork(pkt.dst, iface.network!, iface.mask!) ? pkt.dst : this.lookup(pkt.dst)?.nextHop ?? pkt.dst;
      return this.resolveAndSend(iface, nh, pkt);
    }
    if (pkt.dst === '255.255.255.255') {
      const iface = this.interfaces.find((i) => i.up);
      if (!iface) return 'no-iface';
      this.transmitTo(iface, pkt, BROADCAST_MAC);
      return 'ok';
    }
    const r = this.lookup(pkt.dst);
    if (!r) return 'no-route';
    if (!pkt.src || pkt.src === '0.0.0.0') pkt = { ...pkt, src: r.iface.ip ?? '0.0.0.0' };
    if (r.iface.natRole === 'outside' && this.opts.ipRouting) {
      // routerning o'zidan chiqadigan trafik NAT qilinmaydi (manba — outside IP)
    }
    if (r.iface.aclOut && this.aclOutForLocal && !this.acls.permits(r.iface.aclOut, pkt)) return 'acl-deny';
    return this.resolveAndSend(r.iface, r.nextHop, pkt);
  }

  aclOutForLocal = false;

  /** Keyingi sakrash (next-hop) MAC ini ARP orqali topib, jo'natish */
  resolveAndSend(iface: L3Interface, nextHop: string, pkt: IPv4Packet): SendResult {
    if (iface.hasIp && nextHop === broadcastOf(iface.ip!, iface.mask!)) {
      this.transmitTo(iface, pkt, BROADCAST_MAC);
      return 'ok';
    }
    const e = this.arp.get(nextHop);
    if (e && (e.expires > this.now || e.type === 'static')) {
      this.transmitTo(iface, pkt, e.mac);
      return 'ok';
    }
    if (e) this.arp.delete(nextHop);
    let pend = this.pending.get(nextHop);
    if (!pend) {
      pend = { iface, queue: [], tries: 0, timer: null };
      this.pending.set(nextHop, pend);
      this.sendArpRequest(nextHop, pend);
    }
    if (pend.queue.length < this.opts.arpQueue) pend.queue.push(pkt);
    else this.drop(pkt, `ARP hal qilinmagan (${nextHop}) — paket tashlandi`);
    return 'arp-pending';
  }

  private sendArpRequest(ip: string, pend: PendingArp) {
    const iface = pend.iface;
    if (!iface.up) {
      this.pending.delete(ip);
      return;
    }
    pend.tries++;
    const req: ArpPacket = { kind: 'arp', op: 'request', senderMac: iface.mac, senderIp: iface.ip ?? '0.0.0.0', targetMac: '00:00:00:00:00:00', targetIp: ip };
    iface.output({ id: nextFrameId(), src: iface.mac, dst: BROADCAST_MAC, etherType: 'ARP', payload: req });
    pend.timer = this.device.setTimer(1000, () => {
      if (this.pending.get(ip) !== pend) return;
      if (pend.tries >= 3) {
        this.pending.delete(ip);
        // Windows: "Destination host unreachable" — o'z IP sidan
        for (const pkt of pend.queue) this.arpFailed(iface, pkt);
        return;
      }
      this.sendArpRequest(ip, pend);
    });
  }

  private arpFailed(iface: L3Interface, pkt: IPv4Packet) {
    this.drop(pkt, 'ARP javobi kelmadi — qurilma topilmadi');
    if (pkt.payload.kind === 'icmp' && pkt.payload.type === 'echo-request' && this.ownsIp(pkt.src)) {
      const icmp: IcmpMessage = {
        kind: 'icmp',
        type: 'dest-unreachable',
        code: 1,
        ident: 0,
        seq: 0,
        dataSize: 0,
        original: { src: pkt.src, dst: pkt.dst, protocol: 'ICMP', ident: pkt.payload.ident, seq: pkt.payload.seq },
      };
      const l = this.icmpListeners.get(pkt.payload.ident);
      l?.({ kind: 'ipv4', src: iface.ip ?? pkt.src, dst: pkt.src, ttl: 128, protocol: 'ICMP', id: 0, dscp: 0, payload: icmp }, icmp);
    }
    if (pkt.payload.kind === 'tcp' && this.ownsIp(pkt.src)) {
      this.tcp.onArpFail(pkt);
    }
  }

  private transmitTo(iface: L3Interface, pkt: IPv4Packet, mac: MAC) {
    iface.counters.outPkts++;
    iface.counters.outBytes += ipPacketSize(pkt);
    const cos = pkt.dscp >= 46 ? 5 : pkt.dscp >= 24 ? 3 : 0;
    iface.output({ id: nextFrameId(), src: iface.mac, dst: mac, etherType: 'IPv4', payload: pkt, cos });
  }

  /** Gratuitous ARP — IP o'rnatilganda */
  gratuitousArp(iface: L3Interface) {
    if (!iface.hasIp || !iface.up) return;
    const req: ArpPacket = { kind: 'arp', op: 'request', senderMac: iface.mac, senderIp: iface.ip!, targetMac: '00:00:00:00:00:00', targetIp: iface.ip! };
    iface.output({ id: nextFrameId(), src: iface.mac, dst: BROADCAST_MAC, etherType: 'ARP', payload: req });
  }

  // ================================================================ UDP / ICMP API

  udpBind(port: number, h: UdpHandler) {
    this.udpHandlers.set(port, h);
  }

  udpUnbind(port: number) {
    this.udpHandlers.delete(port);
  }

  isUdpBound(port: number) {
    return this.udpHandlers.has(port);
  }

  sendUdp(
    dst: string,
    srcPort: number,
    dstPort: number,
    payload: UdpDatagram['payload'],
    opts: { src?: string; iface?: L3Interface; dscp?: number; ttl?: number } = {},
  ): SendResult {
    const pkt = this.newPacket({
      src: opts.src ?? opts.iface?.ip ?? '',
      dst,
      protocol: 'UDP',
      dscp: opts.dscp,
      ttl: opts.ttl,
      payload: { kind: 'udp', srcPort, dstPort, payload },
    });
    return this.sendIp(pkt, { iface: opts.iface });
  }

  sendTcpSegment(src: string, dst: string, seg: TcpSegment, dscp = 0): SendResult {
    return this.sendIp(this.newPacket({ src, dst, protocol: 'TCP', payload: seg, dscp }));
  }

  icmpListen(ident: number, l: IcmpListener) {
    this.icmpListeners.set(ident, l);
  }

  icmpUnlisten(ident: number) {
    this.icmpListeners.delete(ident);
  }

  sendEcho(dst: string, ident: number, seq: number, size: number, opts: { ttl?: number; src?: string } = {}): SendResult {
    return this.sendIp(
      this.newPacket({
        src: opts.src ?? '',
        dst,
        protocol: 'ICMP',
        ttl: opts.ttl,
        payload: { kind: 'icmp', type: 'echo-request', code: 0, ident, seq, dataSize: size },
      }),
    );
  }

  /** Manba IP ni tanlash (dst ga boradigan interfeys) */
  sourceFor(dst: string): string | null {
    const r = this.lookup(dst);
    return r?.iface.ip ?? null;
  }

  // ================================================================ vaqt bo'yicha tozalash

  tick() {
    const now = this.now;
    for (const [ip, e] of [...this.arp]) if (e.type === 'dynamic' && e.expires < now) this.arp.delete(ip);
    this.nat.expire(now);
    this.tcp.tick(now);
  }

  staticRouteText(): string[] {
    return this.staticRoutes.map((s) => `ip route ${s.network} ${s.mask}${s.ifaceName ? ' ' + s.ifaceName : ''}${s.nextHop ? ' ' + s.nextHop : ''}${s.ad !== 1 ? ' ' + s.ad : ''}`);
  }
}

export function newIpId() {
  return ipIdCounter++;
}

export { prefixToMask };
