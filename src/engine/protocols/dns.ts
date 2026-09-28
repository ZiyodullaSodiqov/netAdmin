// DNS: server (A/CNAME yozuvlar) va resolver (kesh, qayta urinish).
import type { IpStack } from '../ipstack';
import type { DnsMessage } from '../packets';
import { isValidIp } from '../util';

export interface DnsRecord {
  name: string;
  type: 'A' | 'CNAME';
  value: string;
  ttl: number;
}

export class DnsServer {
  stack: IpStack;
  enabled = false;
  records: DnsRecord[] = [];
  queries = 0;

  constructor(stack: IpStack) {
    this.stack = stack;
  }

  install() {
    this.stack.udpBind(53, (pkt, udp) => {
      const m = udp.payload;
      if (m.kind !== 'dns' || m.qr !== 'query' || !this.enabled) return;
      this.queries++;
      const answers: DnsMessage['answers'] = [];
      let name = m.name.toLowerCase().replace(/\.$/, '');
      for (let depth = 0; depth < 5; depth++) {
        const r = this.records.find((x) => x.name.toLowerCase() === name);
        if (!r) break;
        answers.push({ name: r.name, type: r.type, value: r.value, ttl: r.ttl });
        if (r.type === 'A') break;
        name = r.value.toLowerCase();
      }
      const res: DnsMessage = {
        kind: 'dns',
        qr: 'response',
        txid: m.txid,
        name: m.name,
        qtype: m.qtype,
        answers,
        rcode: answers.some((a) => a.type === 'A') ? 'NOERROR' : 'NXDOMAIN',
      };
      this.stack.sendUdp(pkt.src, 53, udp.srcPort, res, { src: pkt.dst });
    });
  }

  uninstall() {
    this.stack.udpUnbind(53);
  }
}

let txidCounter = 1;

export class DnsResolver {
  stack: IpStack;
  cache = new Map<string, { ip: string; expires: number }>();
  /** Statik yozuvlar (Cisco: ip host, Windows: hosts fayli) */
  hosts = new Map<string, string>();
  private pending = new Map<number, { cb: (ip: string | null, err?: string) => void; timer: any; port: number }>();

  constructor(stack: IpStack) {
    this.stack = stack;
  }

  resolve(name: string, cb: (ip: string | null, err?: string, server?: string) => void, servers?: string[]) {
    if (isValidIp(name)) return cb(name);
    const key = name.toLowerCase();
    const h = this.hosts.get(key);
    if (h) return cb(h);
    const c = this.cache.get(key);
    if (c && c.expires > this.stack.now) return cb(c.ip);
    const list = (servers ?? this.stack.dnsServers).filter(isValidIp);
    if (!list.length) return cb(null, 'DNS server sozlanmagan');
    this.query(key, list, 0, cb);
  }

  private query(name: string, servers: string[], idx: number, cb: (ip: string | null, err?: string, server?: string) => void) {
    if (idx >= servers.length * 2) return cb(null, 'timeout');
    const server = servers[idx % servers.length];
    const txid = txidCounter++;
    const port = 50000 + (txid % 10000);
    const dev = this.stack.device;
    const timer = dev.setTimer(2000, () => {
      this.pending.delete(txid);
      this.stack.udpUnbind(port);
      this.query(name, servers, idx + 1, cb);
    });
    this.pending.set(txid, { cb, timer, port });
    this.stack.udpBind(port, (_pkt, udp) => {
      const m = udp.payload;
      if (m.kind !== 'dns' || m.txid !== txid) return;
      const p = this.pending.get(txid);
      if (!p) return;
      dev.clearTimer(p.timer);
      this.pending.delete(txid);
      this.stack.udpUnbind(port);
      const a = m.answers.find((x) => x.type === 'A');
      if (a) {
        this.cache.set(name, { ip: a.value, expires: this.stack.now + a.ttl * 1000 });
        cb(a.value, undefined, server);
      } else cb(null, m.rcode, server);
    });
    const r = this.stack.sendUdp(server, port, 53, { kind: 'dns', qr: 'query', txid, name, qtype: 'A', answers: [], rcode: 'NOERROR' });
    if (r === 'no-route') {
      dev.clearTimer(timer);
      this.pending.delete(txid);
      this.stack.udpUnbind(port);
      cb(null, 'no-route');
    }
  }

  flush() {
    this.cache.clear();
  }
}
