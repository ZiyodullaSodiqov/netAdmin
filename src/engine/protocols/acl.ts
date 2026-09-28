// Access Control List (standart 1-99, kengaytirilgan 100-199, nomli ACL lar).
import type { IPv4Packet } from '../packets';
import { inNetwork, isValidIp, wildcardToMask } from '../util';

export type AclAddr = { any: true } | { host: string } | { net: string; wildcard: string };
export type PortOp = { op: 'eq' | 'neq' | 'gt' | 'lt'; port: number } | { op: 'range'; from: number; to: number };

export interface AclEntry {
  seq: number;
  action: 'permit' | 'deny';
  proto: 'ip' | 'icmp' | 'tcp' | 'udp';
  src: AclAddr;
  srcPort?: PortOp;
  dst?: AclAddr;
  dstPort?: PortOp;
  icmpType?: string;
  established?: boolean;
  log?: boolean;
  remark?: string;
  matches: number;
}

export interface Acl {
  name: string;
  type: 'standard' | 'extended';
  entries: AclEntry[];
}

export const PORT_NAMES: Record<string, number> = {
  www: 80,
  http: 80,
  https: 443,
  telnet: 23,
  ssh: 22,
  ftp: 21,
  'ftp-data': 20,
  smtp: 25,
  domain: 53,
  pop3: 110,
  bootps: 67,
  bootpc: 68,
  tftp: 69,
  snmp: 161,
  syslog: 514,
  ntp: 123,
  isakmp: 500,
};

const PORT_REVERSE: Record<number, string> = { 80: 'www', 23: 'telnet', 21: 'ftp', 25: 'smtp', 53: 'domain', 110: 'pop3', 67: 'bootps', 68: 'bootpc', 69: 'tftp', 161: 'snmp', 514: 'syslog', 123: 'ntp', 20: 'ftp-data' };

function addrMatch(a: AclAddr, ip: string): boolean {
  if ('any' in a) return true;
  if ('host' in a) return a.host === ip;
  return inNetwork(ip, a.net, wildcardToMask(a.wildcard));
}

function portMatch(p: PortOp | undefined, port: number | undefined): boolean {
  if (!p) return true;
  if (port === undefined) return false;
  switch (p.op) {
    case 'eq':
      return port === p.port;
    case 'neq':
      return port !== p.port;
    case 'gt':
      return port > p.port;
    case 'lt':
      return port < p.port;
    case 'range':
      return port >= p.from && port <= p.to;
  }
}

export function entryMatches(e: AclEntry, pkt: IPv4Packet): boolean {
  if (e.remark) return false;
  if (!addrMatch(e.src, pkt.src)) return false;
  if (!e.dst) return true; // standart ACL
  if (!addrMatch(e.dst, pkt.dst)) return false;
  const pl = pkt.payload;
  switch (e.proto) {
    case 'ip':
      return true;
    case 'icmp':
      if (pl.kind !== 'icmp') return false;
      if (e.icmpType) {
        const map: Record<string, string> = { echo: 'echo-request', 'echo-reply': 'echo-reply', unreachable: 'dest-unreachable', 'time-exceeded': 'time-exceeded' };
        return map[e.icmpType] === pl.type;
      }
      return true;
    case 'tcp':
      if (pl.kind !== 'tcp') return false;
      if (e.established && !(pl.flags.ack || pl.flags.rst)) return false;
      return portMatch(e.srcPort, pl.srcPort) && portMatch(e.dstPort, pl.dstPort);
    case 'udp':
      if (pl.kind !== 'udp') return false;
      return portMatch(e.srcPort, pl.srcPort) && portMatch(e.dstPort, pl.dstPort);
  }
}

export class AclTable {
  acls = new Map<string, Acl>();

  get(name: string) {
    return this.acls.get(name);
  }

  ensure(name: string, type: 'standard' | 'extended'): Acl {
    let a = this.acls.get(name);
    if (!a) {
      a = { name, type, entries: [] };
      this.acls.set(name, a);
    }
    return a;
  }

  add(name: string, type: 'standard' | 'extended', e: Omit<AclEntry, 'seq' | 'matches'> & { seq?: number }) {
    const a = this.ensure(name, type);
    const seq = e.seq ?? (a.entries.length ? a.entries[a.entries.length - 1].seq + 10 : 10);
    a.entries.push({ ...e, seq, matches: 0 });
    a.entries.sort((x, y) => x.seq - y.seq);
  }

  /** Mavjud bo'lmagan ACL — hammasiga ruxsat (IOS xulqi). Oxirida yashirin "deny any". */
  permits(name: string, pkt: IPv4Packet): boolean {
    const a = this.acls.get(name);
    if (!a || !a.entries.length) return true;
    for (const e of a.entries) {
      if (entryMatches(e, pkt)) {
        e.matches++;
        return e.action === 'permit';
      }
    }
    return false;
  }

  /** NAT uchun: ACL mos keladimi (faqat manba bo'yicha) */
  matches(name: string, pkt: IPv4Packet): boolean {
    const a = this.acls.get(name);
    if (!a) return false;
    for (const e of a.entries) {
      if (entryMatches(e, pkt)) return e.action === 'permit';
    }
    return false;
  }
}

export function isStandardAclNumber(n: string) {
  const v = Number(n);
  return (v >= 1 && v <= 99) || (v >= 1300 && v <= 1999);
}

export function isExtendedAclNumber(n: string) {
  const v = Number(n);
  return (v >= 100 && v <= 199) || (v >= 2000 && v <= 2699);
}

/** CLI tokenlaridan ACL yozuvini tahlil qilish. Xato bo'lsa matn qaytaradi. */
export function parseAclEntry(tokens: string[], type: 'standard' | 'extended'): Omit<AclEntry, 'seq' | 'matches'> | string {
  let i = 0;
  const t = () => tokens[i]?.toLowerCase();
  if (t() === 'remark') return { action: 'permit', proto: 'ip', src: { any: true }, remark: tokens.slice(1).join(' ') };
  const action = t();
  if (action !== 'permit' && action !== 'deny') return '% Invalid input detected';
  i++;
  const parseAddr = (): AclAddr | string => {
    const w = t();
    if (!w) return '% Incomplete command.';
    if (w === 'any') {
      i++;
      return { any: true };
    }
    if (w === 'host') {
      i++;
      const ip = tokens[i++];
      if (!isValidIp(ip)) return '% Invalid input detected';
      return { host: ip };
    }
    if (isValidIp(w)) {
      i++;
      const wc = tokens[i];
      if (wc && isValidIp(wc)) {
        i++;
        if (wc === '0.0.0.0') return { host: w };
        return { net: w, wildcard: wc };
      }
      return { host: w };
    }
    return '% Invalid input detected';
  };
  const parsePort = (): PortOp | undefined | string => {
    const w = t();
    if (!w || !['eq', 'neq', 'gt', 'lt', 'range'].includes(w)) return undefined;
    i++;
    const num = (s: string | undefined) => (s === undefined ? NaN : PORT_NAMES[s.toLowerCase()] ?? Number(s));
    if (w === 'range') {
      const a = num(tokens[i++]);
      const b = num(tokens[i++]);
      if (isNaN(a) || isNaN(b)) return '% Invalid port';
      return { op: 'range', from: a, to: b };
    }
    const p = num(tokens[i++]);
    if (isNaN(p)) return '% Invalid port';
    return { op: w as 'eq', port: p };
  };
  if (type === 'standard') {
    const src = parseAddr();
    if (typeof src === 'string') return src;
    const log = t() === 'log';
    return { action, proto: 'ip', src, log };
  }
  const proto = t();
  if (!proto || !['ip', 'icmp', 'tcp', 'udp'].includes(proto)) return '% Invalid protocol';
  i++;
  const src = parseAddr();
  if (typeof src === 'string') return src;
  let srcPort: PortOp | undefined;
  if (proto === 'tcp' || proto === 'udp') {
    const p = parsePort();
    if (typeof p === 'string') return p;
    srcPort = p;
  }
  const dst = parseAddr();
  if (typeof dst === 'string') return dst;
  let dstPort: PortOp | undefined;
  let icmpType: string | undefined;
  let established = false;
  if (proto === 'tcp' || proto === 'udp') {
    const p = parsePort();
    if (typeof p === 'string') return p;
    dstPort = p;
  }
  while (i < tokens.length) {
    const w = t()!;
    if (w === 'established' && proto === 'tcp') established = true;
    else if (proto === 'icmp' && ['echo', 'echo-reply', 'unreachable', 'time-exceeded'].includes(w)) icmpType = w;
    else if (w !== 'log') return `% Invalid input detected at '${tokens[i]}'`;
    i++;
  }
  return { action, proto: proto as AclEntry['proto'], src, srcPort, dst, dstPort, icmpType, established };
}

function addrText(a: AclAddr) {
  if ('any' in a) return 'any';
  if ('host' in a) return `host ${a.host}`;
  return `${a.net} ${a.wildcard}`;
}

function portText(p?: PortOp) {
  if (!p) return '';
  if (p.op === 'range') return ` range ${p.from} ${p.to}`;
  return ` ${p.op} ${PORT_REVERSE[p.port] ?? p.port}`;
}

export function aclEntryText(e: AclEntry): string {
  if (e.remark) return `remark ${e.remark}`;
  if (!e.dst) return `${e.action} ${addrText(e.src)}${e.log ? ' log' : ''}`;
  return `${e.action} ${e.proto} ${addrText(e.src)}${portText(e.srcPort)} ${addrText(e.dst)}${portText(e.dstPort)}${e.icmpType ? ' ' + e.icmpType : ''}${e.established ? ' established' : ''}`;
}
