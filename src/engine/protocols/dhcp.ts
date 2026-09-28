// DHCP: server (pullar, istisno manzillar, lease), klient (DORA, yangilash, APIPA) va relay (ip helper-address).
import type { IpStack } from '../ipstack';
import type { L3Interface } from '../l3';
import type { DhcpMessage, DhcpOptions, IPv4Packet, UdpDatagram } from '../packets';
import { MAC, broadcastOf, intToIp, inNetwork, ipToInt, isValidIp, networkOf } from '../util';

export interface DhcpPool {
  name: string;
  network: string;
  mask: string;
  /** PC-server GUI uslubi: boshlang'ich IP va maksimal foydalanuvchilar soni */
  startIp?: string;
  maxUsers?: number;
  defaultRouter?: string;
  dns: string[];
  domain?: string;
  leaseSec: number;
  option150?: string;
}

export interface DhcpBinding {
  ip: string;
  mac: MAC;
  pool: string;
  expires: number;
  state: 'offered' | 'bound';
  hostname?: string;
}

export class DhcpServer {
  stack: IpStack;
  enabled = true;
  pools: DhcpPool[] = [];
  excluded: { from: string; to: string }[] = [];
  bindings = new Map<MAC, DhcpBinding>();
  stats = { discovers: 0, offers: 0, requests: 0, acks: 0, naks: 0, releases: 0 };
  conflicts: string[] = [];

  constructor(stack: IpStack) {
    this.stack = stack;
  }

  private isExcluded(ip: string) {
    const n = ipToInt(ip);
    return this.excluded.some((e) => n >= ipToInt(e.from) && n <= ipToInt(e.to));
  }

  private poolFor(giaddr: string, iface: L3Interface | null): DhcpPool | undefined {
    const ref = giaddr !== '0.0.0.0' ? giaddr : iface?.ip;
    if (!ref) return undefined;
    return this.pools.find((p) => isValidIp(p.network) && inNetwork(ref, p.network, p.mask));
  }

  private inUse(ip: string, mac: MAC) {
    for (const b of this.bindings.values()) if (b.ip === ip && b.mac !== mac && b.expires > this.stack.now) return true;
    if (this.stack.ownsIp(ip)) return true;
    return false;
  }

  private allocate(pool: DhcpPool, mac: MAC, requested?: string): string | null {
    const prev = this.bindings.get(mac);
    if (prev && prev.pool === pool.name && inNetwork(prev.ip, pool.network, pool.mask)) return prev.ip;
    const net = ipToInt(networkOf(pool.network, pool.mask));
    const bc = ipToInt(broadcastOf(pool.network, pool.mask));
    const ok = (n: number) => {
      const ip = intToIp(n);
      return n > net && n < bc && !this.isExcluded(ip) && !this.inUse(ip, mac) && ip !== pool.defaultRouter && !pool.dns.includes(ip);
    };
    if (requested && isValidIp(requested) && inNetwork(requested, pool.network, pool.mask) && ok(ipToInt(requested))) {
      if (!pool.startIp || (ipToInt(requested) >= ipToInt(pool.startIp) && ipToInt(requested) < ipToInt(pool.startIp) + (pool.maxUsers ?? 1e9))) return requested;
    }
    const start = pool.startIp ? ipToInt(pool.startIp) : net + 1;
    const end = pool.startIp && pool.maxUsers ? Math.min(bc - 1, start + pool.maxUsers - 1) : bc - 1;
    for (let n = start; n <= end; n++) if (ok(n)) return intToIp(n);
    return null;
  }

  private options(pool: DhcpPool, serverId: string): DhcpOptions {
    return {
      mask: pool.mask,
      router: pool.defaultRouter,
      dns: pool.dns,
      domain: pool.domain,
      lease: pool.leaseSec,
      serverId,
      tftp: pool.option150,
    };
  }

  handle(pkt: IPv4Packet, msg: DhcpMessage, iface: L3Interface | null) {
    if (!this.enabled) return;
    const pool = this.poolFor(msg.giaddr, iface);
    const serverId = msg.giaddr !== '0.0.0.0' ? this.stack.sourceFor(msg.giaddr) ?? iface?.ip ?? '0.0.0.0' : iface?.ip ?? '0.0.0.0';
    const reply = (op: DhcpMessage['op'], yiaddr: string, opts: DhcpOptions) => {
      const m: DhcpMessage = { kind: 'dhcp', op, xid: msg.xid, chaddr: msg.chaddr, ciaddr: msg.ciaddr, yiaddr, siaddr: serverId, giaddr: msg.giaddr, broadcast: true, options: opts };
      if (msg.giaddr !== '0.0.0.0') {
        this.stack.sendUdp(msg.giaddr, 67, 67, m, { src: serverId });
      } else if (msg.ciaddr !== '0.0.0.0') {
        this.stack.sendUdp(msg.ciaddr, 67, 68, m, { src: serverId });
      } else if (iface) {
        this.stack.sendUdp('255.255.255.255', 67, 68, m, { src: serverId, iface });
      }
    };
    switch (msg.op) {
      case 'DISCOVER': {
        this.stats.discovers++;
        if (!pool) return;
        const ip = this.allocate(pool, msg.chaddr, msg.options.requestedIp);
        if (!ip) return;
        this.bindings.set(msg.chaddr, { ip, mac: msg.chaddr, pool: pool.name, expires: this.stack.now + 60_000, state: 'offered', hostname: msg.options.hostname });
        this.stats.offers++;
        reply('OFFER', ip, this.options(pool, serverId));
        break;
      }
      case 'REQUEST': {
        this.stats.requests++;
        if (msg.options.serverId && msg.options.serverId !== serverId && !this.stack.ownsIp(msg.options.serverId)) {
          // mijoz boshqa serverni tanladi
          const b = this.bindings.get(msg.chaddr);
          if (b && b.state === 'offered') this.bindings.delete(msg.chaddr);
          return;
        }
        const want = msg.options.requestedIp ?? msg.ciaddr;
        const b = this.bindings.get(msg.chaddr);
        if (!pool) return;
        if (b && b.ip === want && inNetwork(want, pool.network, pool.mask)) {
          b.state = 'bound';
          b.expires = this.stack.now + pool.leaseSec * 1000;
          b.hostname = msg.options.hostname ?? b.hostname;
          this.stats.acks++;
          reply('ACK', b.ip, this.options(pool, serverId));
        } else {
          const ip = want && inNetwork(want, pool.network, pool.mask) ? this.allocate(pool, msg.chaddr, want) : null;
          if (ip && ip === want) {
            this.bindings.set(msg.chaddr, { ip, mac: msg.chaddr, pool: pool.name, expires: this.stack.now + pool.leaseSec * 1000, state: 'bound' });
            this.stats.acks++;
            reply('ACK', ip, this.options(pool, serverId));
          } else {
            this.stats.naks++;
            reply('NAK', '0.0.0.0', { serverId });
          }
        }
        break;
      }
      case 'RELEASE': {
        this.stats.releases++;
        const b = this.bindings.get(msg.chaddr);
        if (b && b.ip === msg.ciaddr) this.bindings.delete(msg.chaddr);
        break;
      }
      case 'DECLINE': {
        const b = this.bindings.get(msg.chaddr);
        if (b) {
          this.conflicts.push(b.ip);
          this.excluded.push({ from: b.ip, to: b.ip });
          this.bindings.delete(msg.chaddr);
        }
        break;
      }
    }
  }

  expire() {
    const now = this.stack.now;
    for (const [mac, b] of [...this.bindings]) if (b.expires < now) this.bindings.delete(mac);
  }
}

/**
 * UDP 67 ishlovchisi: DHCP relay (ip helper-address) + lokal server.
 * Routerlarda doim o'rnatiladi, serverlarda — DHCP xizmati yoqilganda.
 */
export function installDhcpPort67(stack: IpStack, getServer: () => DhcpServer | null) {
  stack.udpBind(67, (pkt: IPv4Packet, udp: UdpDatagram, iface: L3Interface | null) => {
    const msg = udp.payload;
    if (msg.kind !== 'dhcp') return;
    const isReply = msg.op === 'OFFER' || msg.op === 'ACK' || msg.op === 'NAK';
    if (isReply) {
      // Relay agent: serverdan kelgan javobni mijozga uzatish
      const out = stack.interfaces.find((i) => i.ip === msg.giaddr && i.up);
      if (out) stack.sendUdp('255.255.255.255', 67, 68, msg, { src: out.ip!, iface: out });
      return;
    }
    if (iface && iface.helpers.length && pkt.dst === '255.255.255.255') {
      const relayed: DhcpMessage = { ...msg, giaddr: msg.giaddr === '0.0.0.0' ? iface.ip ?? '0.0.0.0' : msg.giaddr };
      for (const h of iface.helpers) stack.sendUdp(h, 67, 67, relayed, { src: iface.ip ?? undefined });
      return;
    }
    getServer()?.handle(pkt, msg, iface);
  });
}

// ====================================================================== klient

export interface DhcpClientHooks {
  hostname: () => string;
  /** Windows: APIPA (169.254.x.x), Cisco IOS: yo'q */
  apipa: boolean;
  onBound?: (iface: L3Interface) => void;
  onFail?: (iface: L3Interface) => void;
  onLog?: (text: string) => void;
}

export class DhcpClient {
  stack: IpStack;
  iface: L3Interface;
  hooks: DhcpClientHooks;
  private timer: ReturnType<IpStack['device']['setTimer']> | null = null;
  private renewTimer: ReturnType<IpStack['device']['setTimer']> | null = null;
  private waiters: ((ok: boolean) => void)[] = [];

  constructor(stack: IpStack, iface: L3Interface, hooks: DhcpClientHooks) {
    this.stack = stack;
    this.iface = iface;
    this.hooks = hooks;
  }

  get dev() {
    return this.stack.device;
  }

  /** DORA jarayonini boshlash */
  start(onDone?: (ok: boolean) => void) {
    if (onDone) this.waiters.push(onDone);
    this.dev.clearTimer(this.timer);
    this.dev.clearTimer(this.renewTimer);
    const prevIp = this.iface.dhcpState?.state === 'BOUND' ? this.iface.ip : undefined;
    this.iface.dhcpState = { state: 'SELECTING', xid: Math.floor(Math.random() * 0xffffffff), retries: 0 };
    if (!prevIp) {
      this.iface.ip = null;
      this.iface.mask = null;
    }
    this.stack.invalidate();
    this.sendDiscover();
  }

  stop() {
    this.dev.clearTimer(this.timer);
    this.dev.clearTimer(this.renewTimer);
    this.iface.dhcpState = null;
  }

  private finish(ok: boolean) {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f(ok);
  }

  private sendDiscover() {
    const st = this.iface.dhcpState;
    if (!st || !this.iface.dhcp) return;
    if (!this.iface.up) {
      this.timer = this.dev.setTimer(2000, () => this.sendDiscover());
      return;
    }
    st.state = 'SELECTING';
    st.retries++;
    const m: DhcpMessage = {
      kind: 'dhcp',
      op: 'DISCOVER',
      xid: st.xid,
      chaddr: this.iface.mac,
      ciaddr: '0.0.0.0',
      yiaddr: '0.0.0.0',
      siaddr: '0.0.0.0',
      giaddr: '0.0.0.0',
      broadcast: true,
      options: { hostname: this.hooks.hostname() },
    };
    this.stack.sendUdp('255.255.255.255', 68, 67, m, { src: '0.0.0.0', iface: this.iface });
    // Windows: 4, 8, 16, 16 soniya oralig'ida qayta urinish, ~60 s dan keyin APIPA
    const delay = Math.min(16000, 4000 * 2 ** (st.retries - 1));
    this.timer = this.dev.setTimer(delay, () => {
      const s = this.iface.dhcpState;
      if (!s || s.state === 'BOUND') return;
      if (s.retries >= 5 && s.state !== 'APIPA') {
        s.lastError = 'DHCP server javob bermadi';
        this.hooks.onLog?.('DHCP request failed.');
        if (this.hooks.apipa) {
          // APIPA: 169.254.x.y/16
          const m = this.iface.mac.split(':');
          this.iface.ip = `169.254.${parseInt(m[4], 16)}.${Math.max(1, parseInt(m[5], 16))}`;
          this.iface.mask = '255.255.0.0';
          s.state = 'APIPA';
          s.gateway = undefined;
          this.stack.invalidate();
        }
        this.hooks.onFail?.(this.iface);
        this.finish(false);
        // fonda qayta urinish
        this.timer = this.dev.setTimer(60000, () => {
          if (this.iface.dhcp && this.iface.dhcpState) {
            this.iface.dhcpState.retries = 0;
            this.sendDiscover();
          }
        });
        return;
      }
      this.sendDiscover();
    });
  }

  handle(msg: DhcpMessage) {
    const st = this.iface.dhcpState;
    if (!st || msg.xid !== st.xid || msg.chaddr !== this.iface.mac) return;
    if (msg.op === 'OFFER' && (st.state === 'SELECTING' || st.state === 'APIPA')) {
      st.state = 'REQUESTING';
      st.offered = msg.yiaddr;
      st.server = msg.options.serverId ?? msg.siaddr;
      this.dev.clearTimer(this.timer);
      const req: DhcpMessage = {
        kind: 'dhcp',
        op: 'REQUEST',
        xid: st.xid,
        chaddr: this.iface.mac,
        ciaddr: '0.0.0.0',
        yiaddr: '0.0.0.0',
        siaddr: '0.0.0.0',
        giaddr: '0.0.0.0',
        broadcast: true,
        options: { requestedIp: msg.yiaddr, serverId: st.server, hostname: this.hooks.hostname() },
      };
      this.stack.sendUdp('255.255.255.255', 68, 67, req, { src: '0.0.0.0', iface: this.iface });
      this.timer = this.dev.setTimer(4000, () => {
        if (this.iface.dhcpState?.state === 'REQUESTING') this.sendDiscover();
      });
    } else if (msg.op === 'ACK' && (st.state === 'REQUESTING' || st.state === 'RENEWING')) {
      this.dev.clearTimer(this.timer);
      const changed = this.iface.ip !== msg.yiaddr;
      this.iface.ip = msg.yiaddr;
      this.iface.mask = msg.options.mask ?? '255.255.255.0';
      st.state = 'BOUND';
      st.gateway = msg.options.router;
      st.dns = msg.options.dns;
      st.domain = msg.options.domain;
      st.tftp = msg.options.tftp;
      st.server = msg.options.serverId ?? st.server;
      const lease = (msg.options.lease ?? 86400) * 1000;
      st.leaseEnd = this.dev.now + lease;
      st.retries = 0;
      this.stack.invalidate();
      if (changed) this.stack.gratuitousArp(this.iface);
      this.hooks.onBound?.(this.iface);
      this.finish(true);
      this.renewTimer = this.dev.setTimer(lease / 2, () => this.renew());
    } else if (msg.op === 'NAK') {
      this.dev.clearTimer(this.timer);
      this.iface.ip = null;
      this.iface.mask = null;
      this.stack.invalidate();
      st.retries = 0;
      st.xid = Math.floor(Math.random() * 0xffffffff);
      this.timer = this.dev.setTimer(500, () => this.sendDiscover());
    }
  }

  /** T1: lease yarmida unicast REQUEST */
  renew() {
    const st = this.iface.dhcpState;
    if (!st || st.state !== 'BOUND' || !this.iface.ip) return;
    st.state = 'RENEWING';
    const req: DhcpMessage = {
      kind: 'dhcp',
      op: 'REQUEST',
      xid: st.xid,
      chaddr: this.iface.mac,
      ciaddr: this.iface.ip,
      yiaddr: '0.0.0.0',
      siaddr: '0.0.0.0',
      giaddr: '0.0.0.0',
      broadcast: false,
      options: { hostname: this.hooks.hostname() },
    };
    if (st.server && isValidIp(st.server)) this.stack.sendUdp(st.server, 68, 67, req, { src: this.iface.ip });
    else this.stack.sendUdp('255.255.255.255', 68, 67, req, { src: this.iface.ip, iface: this.iface });
    this.timer = this.dev.setTimer(10000, () => {
      if (this.iface.dhcpState?.state === 'RENEWING') this.start();
    });
  }

  release() {
    const st = this.iface.dhcpState;
    if (st && st.state === 'BOUND' && this.iface.ip && st.server) {
      const m: DhcpMessage = {
        kind: 'dhcp',
        op: 'RELEASE',
        xid: st.xid,
        chaddr: this.iface.mac,
        ciaddr: this.iface.ip,
        yiaddr: '0.0.0.0',
        siaddr: '0.0.0.0',
        giaddr: '0.0.0.0',
        broadcast: false,
        options: { serverId: st.server },
      };
      this.stack.sendUdp(st.server, 68, 67, m, { src: this.iface.ip });
    }
    this.dev.clearTimer(this.timer);
    this.dev.clearTimer(this.renewTimer);
    this.iface.ip = null;
    this.iface.mask = null;
    this.iface.dhcpState = { state: 'INIT', xid: 0, retries: 0 };
    this.stack.invalidate();
  }
}

/** Bir nechta interfeys uchun umumiy UDP 68 ishlovchisi */
export function installDhcpPort68(stack: IpStack, clients: () => DhcpClient[]) {
  stack.udpBind(68, (_pkt, udp) => {
    const msg = udp.payload;
    if (msg.kind !== 'dhcp') return;
    for (const c of clients()) if (c.iface.mac === msg.chaddr) c.handle(msg);
  });
}
