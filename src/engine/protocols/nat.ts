// NAT / PAT (ip nat inside source ... overload) — uy routerlari va ofis internet chiqishi.
import type { IpStack } from '../ipstack';
import type { L3Interface } from '../l3';
import type { IPv4Packet } from '../packets';
import { ipToInt, intToIp } from '../util';

export interface NatStatic {
  local: string;
  global: string;
  proto?: 'tcp' | 'udp';
  localPort?: number;
  globalPort?: number;
}

export interface NatDynamicRule {
  acl: string;
  pool?: string;
  iface?: string;
  overload: boolean;
}

export interface NatPool {
  name: string;
  start: string;
  end: string;
  mask: string;
}

export interface NatEntry {
  proto: 'icmp' | 'tcp' | 'udp' | 'ip';
  insideLocal: string;
  insideLocalPort: number;
  insideGlobal: string;
  insideGlobalPort: number;
  outside: string;
  outsidePort: number;
  expires: number;
  created: number;
  isStatic: boolean;
}

function l4(pkt: IPv4Packet): { proto: NatEntry['proto']; sport: number; dport: number } {
  const p = pkt.payload;
  if (p.kind === 'tcp') return { proto: 'tcp', sport: p.srcPort, dport: p.dstPort };
  if (p.kind === 'udp') return { proto: 'udp', sport: p.srcPort, dport: p.dstPort };
  if (p.kind === 'icmp') return { proto: 'icmp', sport: p.ident, dport: p.ident };
  return { proto: 'ip', sport: 0, dport: 0 };
}

function rewrite(pkt: IPv4Packet, opts: { src?: string; sport?: number; dst?: string; dport?: number }): IPv4Packet {
  const out: IPv4Packet = { ...pkt, src: opts.src ?? pkt.src, dst: opts.dst ?? pkt.dst };
  const p = pkt.payload;
  if (p.kind === 'tcp' || p.kind === 'udp') {
    out.payload = { ...p, srcPort: opts.sport ?? p.srcPort, dstPort: opts.dport ?? p.dstPort } as any;
  } else if (p.kind === 'icmp') {
    const id = opts.sport ?? opts.dport;
    if (id !== undefined) out.payload = { ...p, ident: id };
  }
  return out;
}

export class NatTable {
  stack: IpStack;
  statics: NatStatic[] = [];
  rules: NatDynamicRule[] = [];
  pools = new Map<string, NatPool>();
  entries: NatEntry[] = [];
  private nextPort = 1024;
  stats = { hits: 0, misses: 0 };

  constructor(stack: IpStack) {
    this.stack = stack;
  }

  get enabled() {
    return this.statics.length > 0 || this.rules.length > 0;
  }

  clearDynamic() {
    this.entries = this.entries.filter((e) => e.isStatic);
  }

  expire(now: number) {
    this.entries = this.entries.filter((e) => e.isStatic || e.expires > now);
  }

  private timeout(proto: NatEntry['proto']) {
    return proto === 'tcp' ? 86_400_000 : proto === 'udp' ? 300_000 : 60_000;
  }

  /** inside -> outside: manba manzilini tarjima qilish */
  translate(pkt: IPv4Packet, outIface: L3Interface): IPv4Packet | null {
    const now = this.stack.now;
    const { proto, sport, dport } = l4(pkt);
    // mavjud yozuv
    const e = this.entries.find((x) => x.insideLocal === pkt.src && (x.isStatic ? !x.insideLocalPort || x.insideLocalPort === sport : x.proto === proto && x.insideLocalPort === sport && (proto === 'icmp' || x.outside === pkt.dst)));
    if (e) {
      this.stats.hits++;
      if (!e.isStatic) e.expires = now + this.timeout(proto);
      return rewrite(pkt, { src: e.insideGlobal, sport: e.insideGlobalPort || undefined });
    }
    // statik NAT
    const st = this.statics.find((s) => s.local === pkt.src && (!s.proto || (s.proto === proto && s.localPort === sport)));
    if (st) {
      this.stats.hits++;
      return rewrite(pkt, { src: st.global, sport: st.globalPort });
    }
    // dinamik qoidalar
    for (const r of this.rules) {
      if (!this.stack.acls.matches(r.acl, pkt)) continue;
      let globalIp: string | null = null;
      if (r.iface) globalIp = this.stack.iface(r.iface)?.ip ?? outIface.ip;
      else if (r.pool) {
        const pool = this.pools.get(r.pool);
        if (!pool) continue;
        if (r.overload) globalIp = pool.start;
        else {
          for (let n = ipToInt(pool.start); n <= ipToInt(pool.end); n++) {
            const ip = intToIp(n);
            if (!this.entries.some((x) => x.insideGlobal === ip && x.insideLocal !== pkt.src)) {
              globalIp = ip;
              break;
            }
          }
        }
      }
      if (!globalIp) {
        this.stats.misses++;
        return null;
      }
      let gport = sport;
      if (r.overload) {
        // Agar port band bo'lsa — yangi port ajratiladi (PAT)
        const busy = (p: number) => this.entries.some((x) => x.insideGlobal === globalIp && x.insideGlobalPort === p && x.proto === proto);
        if (busy(gport) || gport === 0) {
          do {
            gport = this.nextPort++;
            if (this.nextPort > 65000) this.nextPort = 1024;
          } while (busy(gport));
        }
      }
      const ent: NatEntry = {
        proto,
        insideLocal: pkt.src,
        insideLocalPort: sport,
        insideGlobal: globalIp,
        insideGlobalPort: r.overload ? gport : sport,
        outside: pkt.dst,
        outsidePort: dport,
        created: now,
        expires: now + this.timeout(proto),
        isStatic: false,
      };
      this.entries.push(ent);
      this.stats.misses++;
      return rewrite(pkt, { src: globalIp, sport: r.overload ? gport : undefined });
    }
    return pkt; // NAT qoidasi mos kelmadi — o'zgarishsiz marshrutlanadi
  }

  /** outside -> inside: qabul qiluvchi manzilini qaytarish */
  untranslate(pkt: IPv4Packet): IPv4Packet {
    const { proto, dport } = l4(pkt);
    const p = pkt.payload;
    // ICMP xato xabarlari (traceroute) — ichidagi asl paket bo'yicha
    if (p.kind === 'icmp' && p.type !== 'echo-reply' && p.original) {
      const o = p.original;
      const port = o.ident ?? o.srcPort;
      const e = this.entries.find((x) => x.insideGlobal === o.src && (x.insideGlobalPort === port || x.isStatic));
      if (e) {
        return { ...pkt, dst: e.insideLocal, payload: { ...p, original: { ...o, src: e.insideLocal, ident: o.ident !== undefined ? e.insideLocalPort : undefined, srcPort: o.srcPort !== undefined ? e.insideLocalPort : undefined } } };
      }
    }
    const e = this.entries.find((x) => x.insideGlobal === pkt.dst && (x.isStatic || (x.proto === proto && x.insideGlobalPort === dport)));
    if (e) {
      if (!e.isStatic) e.expires = this.stack.now + this.timeout(proto);
      this.stats.hits++;
      return rewrite(pkt, { dst: e.insideLocal, dport: e.insideLocalPort || undefined });
    }
    const st = this.statics.find((s) => s.global === pkt.dst && (!s.proto || (s.proto === proto && s.globalPort === dport)));
    if (st) {
      this.stats.hits++;
      return rewrite(pkt, { dst: st.local, dport: st.localPort });
    }
    return pkt;
  }

  /** show ip nat translations */
  table(): string[] {
    const lines = ['Pro  Inside global         Inside local          Outside local         Outside global'];
    for (const s of this.statics) {
      const pr = s.proto ?? '---';
      const g = s.globalPort ? `${s.global}:${s.globalPort}` : s.global;
      const l = s.localPort ? `${s.local}:${s.localPort}` : s.local;
      lines.push(`${pr.padEnd(5)}${g.padEnd(22)}${l.padEnd(22)}${'---'.padEnd(22)}---`);
    }
    for (const e of this.entries) {
      const g = `${e.insideGlobal}:${e.insideGlobalPort}`;
      const l = `${e.insideLocal}:${e.insideLocalPort}`;
      const o = `${e.outside}:${e.outsidePort}`;
      lines.push(`${e.proto.padEnd(5)}${g.padEnd(22)}${l.padEnd(22)}${o.padEnd(22)}${o}`);
    }
    return lines;
  }
}
