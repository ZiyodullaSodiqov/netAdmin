// OSPFv2 (bitta area uchun soddalashtirilgan): Hello (224.0.0.5), qo'shnilik, LSA tarqatish, SPF (Dijkstra).
import type { IpStack, Route } from '../ipstack';
import type { L3Interface } from '../l3';
import type { IPv4Packet, OspfLsa, OspfPacket } from '../packets';
import { inNetwork, ipToInt, maskToPrefix, networkOf, wildcardToMask } from '../util';
import type { Device } from '../device';

export interface OspfNetworkStmt {
  network: string;
  wildcard: string;
  area: number;
}

export interface OspfNeighbor {
  routerId: string;
  ip: string;
  iface: L3Interface;
  priority: number;
  state: 'INIT' | '2WAY' | 'FULL';
  deadAt: number;
  since: number;
}

export class OspfProcess {
  stack: IpStack;
  device: Device;
  processId: number;
  routerIdConfigured: string | null = null;
  networks: OspfNetworkStmt[] = [];
  passive = new Set<string>();
  passiveDefault = false;
  defaultOriginate = false;
  helloInterval = 10;
  deadInterval = 40;
  referenceBw = 100; // Mbit/s
  neighbors = new Map<string, OspfNeighbor>(); // key: iface|rid
  lsdb = new Map<string, OspfLsa>();
  private seq = 0x80000001;
  private stopHello: (() => void) | null = null;
  private spfRoutes: Route[] = [];
  spfRuns = 0;
  private provider: () => Route[];

  constructor(stack: IpStack, processId: number) {
    this.stack = stack;
    this.device = stack.device;
    this.processId = processId;
    this.provider = () => this.spfRoutes;
    stack.routeProviders.push(this.provider);
    stack.protocolHandlers.OSPF = (pkt, iface) => this.receive(pkt, iface);
  }

  destroy() {
    this.stopHello?.();
    this.stack.routeProviders = this.stack.routeProviders.filter((p) => p !== this.provider);
    delete this.stack.protocolHandlers.OSPF;
    this.stack.invalidate();
  }

  get routerId(): string {
    if (this.routerIdConfigured) return this.routerIdConfigured;
    const lo = this.stack.interfaces.filter((i) => i.kind === 'loopback' && i.hasIp).map((i) => i.ip!);
    const all = lo.length ? lo : this.stack.interfaces.filter((i) => i.hasIp && i.up).map((i) => i.ip!);
    if (!all.length) return '0.0.0.0';
    return all.sort((a, b) => ipToInt(b) - ipToInt(a))[0];
  }

  /** Interfeys OSPF ga kiritilganmi (network buyrug'i) */
  ifaceArea(i: L3Interface): number | null {
    if (!i.hasIp) return null;
    for (const n of this.networks) if (inNetwork(i.ip!, n.network, wildcardToMask(n.wildcard))) return n.area;
    return null;
  }

  isPassive(i: L3Interface) {
    return this.passive.has(i.name) !== this.passiveDefault || i.kind === 'loopback';
  }

  cost(i: L3Interface) {
    if (i.ospfCost) return i.ospfCost;
    if (i.kind === 'loopback') return 1;
    return Math.max(1, Math.floor((this.referenceBw * 1000) / i.bandwidthKbps));
  }

  start() {
    this.stopHello?.();
    this.stopHello = this.device.every(this.helloInterval * 1000, () => this.helloTick(), 200);
    this.originate();
  }

  reset() {
    this.stopHello?.();
    this.stopHello = null;
    this.neighbors.clear();
    this.lsdb.clear();
    this.spfRoutes = [];
  }

  private helloTick() {
    const now = this.device.now;
    let changed = false;
    for (const [k, n] of [...this.neighbors]) {
      if (n.deadAt < now || !n.iface.up) {
        this.neighbors.delete(k);
        this.device.syslog('OSPF', 5, 'ADJCHG', `Process ${this.processId}, Nbr ${n.routerId} on ${n.iface.name} from FULL to DOWN, Neighbor Down: Dead timer expired`);
        changed = true;
      }
    }
    for (const i of this.stack.interfaces) {
      if (!i.up || this.ifaceArea(i) === null || this.isPassive(i)) continue;
      this.sendHello(i);
    }
    if (changed) this.originate();
  }

  private sendHello(i: L3Interface) {
    const nbrs = [...this.neighbors.values()].filter((n) => n.iface === i).map((n) => n.routerId);
    const pkt: OspfPacket = {
      kind: 'ospf',
      type: 'hello',
      routerId: this.routerId,
      area: this.ifaceArea(i)!,
      helloInterval: this.helloInterval,
      deadInterval: this.deadInterval,
      neighbors: nbrs,
      mask: i.mask!,
      priority: i.ospfPriority,
    };
    this.stack.sendIp(this.stack.newPacket({ src: i.ip!, dst: '224.0.0.5', protocol: 'OSPF', ttl: 1, dscp: 48, payload: pkt }), { iface: i });
  }

  interfaceChange() {
    for (const [k, n] of [...this.neighbors]) if (!n.iface.up) this.neighbors.delete(k);
    this.device.setTimer(10, () => this.originate());
  }

  private receive(pkt: IPv4Packet, iface: L3Interface) {
    const o = pkt.payload as OspfPacket;
    const area = this.ifaceArea(iface);
    if (area === null || this.isPassive(iface)) return;
    if (o.routerId === this.routerId) return;
    if (o.type === 'hello') {
      // Parametrlar mos kelishi shart (haqiqiy OSPF kabi)
      if (o.area !== area || o.helloInterval !== this.helloInterval || o.deadInterval !== this.deadInterval) return;
      if (o.mask !== iface.mask) return;
      if (!iface.hasIp || !inNetwork(pkt.src, iface.network!, iface.mask!)) return;
      const k = `${iface.name}|${o.routerId}`;
      let n = this.neighbors.get(k);
      const now = this.device.now;
      if (!n) {
        n = { routerId: o.routerId, ip: pkt.src, iface, priority: o.priority, state: 'INIT', deadAt: now + this.deadInterval * 1000, since: now };
        this.neighbors.set(k, n);
        // darhol javob hello (tez qo'shnilik)
        this.sendHello(iface);
      }
      n.deadAt = now + this.deadInterval * 1000;
      n.ip = pkt.src;
      n.priority = o.priority;
      if (o.neighbors.includes(this.routerId) && n.state !== 'FULL') {
        n.state = 'FULL';
        n.since = now;
        this.device.syslog('OSPF', 5, 'ADJCHG', `Process ${this.processId}, Nbr ${n.routerId} on ${iface.name} from LOADING to FULL, Loading Done`);
        this.originate();
        // LSDB ni yangi qo'shniga yuborish (Database Exchange)
        for (const lsa of this.lsdb.values()) this.sendLsu(iface, lsa);
      } else if (!o.neighbors.includes(this.routerId) && n.state === 'INIT') {
        this.sendHello(iface);
      }
      return;
    }
    if (o.type === 'lsu' && o.lsa) {
      const cur = this.lsdb.get(o.lsa.routerId);
      if (o.lsa.routerId === this.routerId) return;
      if (!cur || o.lsa.seq > cur.seq) {
        this.lsdb.set(o.lsa.routerId, o.lsa);
        // boshqa qo'shnilarga tarqatish (flooding)
        for (const n of this.neighbors.values()) if (n.state === 'FULL' && n.iface !== iface) this.sendLsu(n.iface, o.lsa);
        this.scheduleSpf();
      }
    }
  }

  private sendLsu(i: L3Interface, lsa: OspfLsa) {
    if (!i.up || !i.hasIp) return;
    const pkt: OspfPacket = { kind: 'ospf', type: 'lsu', routerId: this.routerId, area: this.ifaceArea(i) ?? 0, helloInterval: this.helloInterval, deadInterval: this.deadInterval, neighbors: [], mask: i.mask!, priority: i.ospfPriority, lsa };
    this.stack.sendIp(this.stack.newPacket({ src: i.ip!, dst: '224.0.0.5', protocol: 'OSPF', ttl: 1, dscp: 48, payload: pkt }), { iface: i });
  }

  /** O'z router-LSA mizni yaratish va tarqatish */
  originate() {
    const rid = this.routerId;
    if (rid === '0.0.0.0') return;
    const links: OspfLsa['links'] = [];
    for (const i of this.stack.interfaces) {
      if (!i.up || this.ifaceArea(i) === null) continue;
      links.push({ network: i.network!, mask: i.kind === 'loopback' ? '255.255.255.255' : i.mask!, cost: this.cost(i) });
      for (const n of this.neighbors.values()) if (n.iface === i && n.state === 'FULL') links.push({ network: i.network!, mask: i.mask!, cost: this.cost(i), neighborId: n.routerId, neighborIp: n.ip });
    }
    if (this.defaultOriginate && this.stack.routes().some((r) => r.prefix === 0 && r.code !== 'O' && r.code !== 'O*E2')) links.push({ network: '0.0.0.0', mask: '0.0.0.0', cost: 1, neighborId: 'external' });
    const lsa: OspfLsa = { routerId: rid, seq: this.seq++, links };
    const prev = this.lsdb.get(rid);
    if (prev && JSON.stringify(prev.links) === JSON.stringify(links)) return;
    this.lsdb.set(rid, lsa);
    for (const n of this.neighbors.values()) if (n.state === 'FULL') this.sendLsu(n.iface, lsa);
    this.scheduleSpf();
  }

  private spfTimer: any = null;
  private scheduleSpf() {
    if (this.spfTimer) return;
    this.spfTimer = this.device.setTimer(50, () => {
      this.spfTimer = null;
      this.runSpf();
    });
  }

  /** Dijkstra — eng qisqa yo'llar daraxti */
  runSpf() {
    this.spfRuns++;
    const me = this.routerId;
    const dist = new Map<string, number>([[me, 0]]);
    const firstHop = new Map<string, { iface: L3Interface; ip: string } | null>([[me, null]]);
    const visited = new Set<string>();
    const lsaOf = (r: string) => this.lsdb.get(r);
    for (;;) {
      let u: string | null = null;
      let best = Infinity;
      for (const [r, d] of dist) if (!visited.has(r) && d < best) ((best = d), (u = r));
      if (u === null) break;
      visited.add(u);
      const lsa = lsaOf(u);
      if (!lsa) continue;
      for (const l of lsa.links) {
        if (!l.neighborId || l.neighborId === 'external') continue;
        // ikki tomonlama tekshiruv
        const back = lsaOf(l.neighborId);
        if (!back || !back.links.some((x) => x.neighborId === u)) continue;
        const nd = best + l.cost;
        if (nd < (dist.get(l.neighborId) ?? Infinity)) {
          dist.set(l.neighborId, nd);
          if (u === me) {
            const n = [...this.neighbors.values()].find((x) => x.routerId === l.neighborId && x.state === 'FULL' && x.ip === l.neighborIp);
            firstHop.set(l.neighborId, n ? { iface: n.iface, ip: n.ip } : null);
          } else firstHop.set(l.neighborId, firstHop.get(u) ?? null);
        }
      }
    }
    const connected = new Set(this.stack.interfaces.filter((i) => i.up && i.hasIp).map((i) => `${i.network}/${i.prefix}`));
    const routes = new Map<string, Route>();
    for (const [r, d] of dist) {
      if (r === me) continue;
      const fh = firstHop.get(r);
      if (!fh) continue;
      const lsa = lsaOf(r)!;
      for (const l of lsa.links) {
        const prefix = maskToPrefix(l.mask);
        const net = networkOf(l.network, l.mask);
        const key = `${net}/${prefix}`;
        if (connected.has(key)) continue;
        const external = l.neighborId === 'external';
        if (l.neighborId && !external) {
          // tranzit tarmoq ham stub sifatida qo'shiladi
        }
        const metric = d + (external ? 1 : l.cost);
        const cur = routes.get(key);
        if (!cur || metric < cur.metric) routes.set(key, { code: external ? 'O*E2' : 'O', network: net, mask: l.mask, prefix, iface: fh.iface, nextHop: fh.ip, ad: 110, metric: external ? 20 : metric });
      }
    }
    this.spfRoutes = [...routes.values()];
    this.stack.invalidate();
  }

  neighborTable(): string[] {
    const lines = ['', 'Neighbor ID     Pri   State           Dead Time   Address         Interface'];
    const now = this.device.now;
    for (const n of this.neighbors.values()) {
      const dead = Math.max(0, Math.round((n.deadAt - now) / 1000));
      const role = this.roleOf(n);
      const st = n.state === 'FULL' ? `FULL/${role}` : n.state === 'INIT' ? 'INIT/DROTHER' : '2WAY/DROTHER';
      lines.push(`${n.routerId.padEnd(16)}${String(n.priority).padStart(3)}   ${st.padEnd(16)}00:00:${String(dead).padStart(2, '0')}    ${n.ip.padEnd(16)}${n.iface.name}`);
    }
    return lines;
  }

  private roleOf(n: OspfNeighbor): string {
    // DR: segmentda eng yuqori priority, keyin eng katta Router ID
    const segment = [...this.neighbors.values()].filter((x) => x.iface === n.iface).map((x) => ({ rid: x.routerId, pri: x.priority }));
    segment.push({ rid: this.routerId, pri: n.iface.ospfPriority });
    const sorted = segment.filter((s) => s.pri > 0).sort((a, b) => b.pri - a.pri || ipToInt(b.rid) - ipToInt(a.rid));
    if (sorted[0]?.rid === n.routerId) return 'DR';
    if (sorted[1]?.rid === n.routerId) return 'BDR';
    return 'DROTHER';
  }

  databaseText(): string[] {
    const lines = [`            OSPF Router with ID (${this.routerId}) (Process ID ${this.processId})`, '', '                Router Link States (Area 0)', '', 'Link ID         ADV Router      Age         Seq#       Checksum Link count'];
    for (const l of this.lsdb.values()) lines.push(`${l.routerId.padEnd(16)}${l.routerId.padEnd(16)}${'10'.padEnd(12)}0x${l.seq.toString(16).padEnd(9)}0x00${(l.seq & 0xffff).toString(16).padStart(4, '0')}   ${l.links.length}`);
    return lines;
  }
}
