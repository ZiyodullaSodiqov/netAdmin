// TCP: 3-bosqichli qo'l siqish (SYN, SYN-ACK, ACK), segmentatsiya (MSS 1460), ACK, qayta yuborish, FIN/RST.
import type { IpStack } from '../ipstack';
import type { L3Interface } from '../l3';
import type { AppMessage, IcmpMessage, IPv4Packet, TcpSegment } from '../packets';

export const MSS = 1460;

export type TcpCloseReason = 'fin' | 'rst' | 'timeout' | 'refused' | 'unreachable' | 'local';

export interface TcpCallbacks {
  onOpen?: (c: TcpConn) => void;
  onData?: (c: TcpConn, msg: AppMessage) => void;
  onClose?: (c: TcpConn, reason: TcpCloseReason) => void;
}

export type TcpState = 'SYN_SENT' | 'SYN_RCVD' | 'ESTABLISHED' | 'FIN_WAIT' | 'CLOSED';

interface Outstanding {
  startSeq: number;
  endSeq: number;
  msg: AppMessage;
  tries: number;
  timer: ReturnType<IpStack['device']['setTimer']> | null;
}

let isnCounter = 1000;

export class TcpConn {
  stack: IpStack;
  localIp: string;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  state: TcpState;
  seq: number;
  ack = 0;
  cb: TcpCallbacks;
  dscp = 0;
  openedAt: number;
  lastActivity: number;
  /** Kutilayotgan ACK lar */
  private outstanding: Outstanding[] = [];
  private rx: { start: number; got: number } | null = null;
  private synTimer: ReturnType<IpStack['device']['setTimer']> | null = null;
  private synTries = 0;
  rttMs = 0;
  bytesSent = 0;
  bytesRecv = 0;
  /** Foydalanuvchi ma'lumotlari (ilova) */
  app: any = null;

  constructor(stack: IpStack, localIp: string, localPort: number, remoteIp: string, remotePort: number, state: TcpState, cb: TcpCallbacks) {
    this.stack = stack;
    this.localIp = localIp;
    this.localPort = localPort;
    this.remoteIp = remoteIp;
    this.remotePort = remotePort;
    this.state = state;
    this.cb = cb;
    this.seq = isnCounter += 64013;
    this.seq %= 4_000_000_000;
    this.openedAt = stack.now;
    this.lastActivity = stack.now;
  }

  get key() {
    return connKey(this.localIp, this.localPort, this.remoteIp, this.remotePort);
  }

  private seg(flags: TcpSegment['flags'], extra: Partial<TcpSegment> = {}): TcpSegment {
    return { kind: 'tcp', srcPort: this.localPort, dstPort: this.remotePort, seq: this.seq, ack: this.ack, flags, window: 65535, dataSize: 0, ...extra };
  }

  sendRaw(s: TcpSegment) {
    this.lastActivity = this.stack.now;
    this.stack.sendTcpSegment(this.localIp, this.remoteIp, s, this.dscp);
  }

  // ------------------------------------------------ mijoz tomoni
  startConnect() {
    this.synTries++;
    const s = this.seg({ syn: true });
    this.sendRaw(s);
    const rto = 1000 * 2 ** (this.synTries - 1);
    this.synTimer = this.stack.device.setTimer(rto, () => {
      if (this.state !== 'SYN_SENT') return;
      if (this.synTries >= 4) {
        this.terminate('timeout');
        return;
      }
      this.startConnect();
    });
  }

  // ------------------------------------------------ ma'lumot yuborish
  send(msg: AppMessage) {
    if (this.state !== 'ESTABLISHED') return false;
    const size = Math.max(0, msg.size);
    const startSeq = this.seq;
    this.seq += size;
    const o: Outstanding = { startSeq, endSeq: startSeq + size, msg, tries: 0, timer: null };
    this.outstanding.push(o);
    this.transmit(o);
    return true;
  }

  private transmit(o: Outstanding) {
    o.tries++;
    const size = o.endSeq - o.startSeq;
    const n = Math.max(1, Math.ceil(size / MSS));
    for (let i = 0; i < n; i++) {
      const len = i === n - 1 ? size - MSS * (n - 1) : MSS;
      const last = i === n - 1;
      this.sendRaw(this.seg(last ? { ack: true, psh: true } : { ack: true }, { seq: o.startSeq + i * MSS, dataSize: len, data: last ? o.msg : undefined, segIndex: i, segCount: n }));
    }
    this.bytesSent += size;
    const rto = Math.min(8000, 1000 * 2 ** (o.tries - 1) + (this.rttMs || 0) * 2);
    o.timer = this.stack.device.setTimer(rto, () => {
      if (!this.outstanding.includes(o) || this.state === 'CLOSED') return;
      if (o.tries >= 5) {
        this.terminate('timeout');
        return;
      }
      this.transmit(o);
    });
  }

  close() {
    if (this.state === 'CLOSED') return;
    if (this.state === 'ESTABLISHED' || this.state === 'SYN_RCVD') {
      this.state = 'FIN_WAIT';
      this.sendRaw(this.seg({ fin: true, ack: true }));
      this.seq++;
      // javob bo'lmasa baribir yopiladi
      this.stack.device.setTimer(3000, () => this.terminate('local', false));
    } else this.terminate('local', false);
  }

  abort() {
    if (this.state !== 'CLOSED') this.sendRaw(this.seg({ rst: true, ack: true }));
    this.terminate('local', false);
  }

  terminate(reason: TcpCloseReason, notify = true) {
    if (this.state === 'CLOSED') return;
    this.state = 'CLOSED';
    this.stack.device.clearTimer(this.synTimer);
    for (const o of this.outstanding) this.stack.device.clearTimer(o.timer);
    this.outstanding = [];
    this.stack.tcp.remove(this);
    if (notify || reason !== 'local') this.cb.onClose?.(this, reason);
  }

  // ------------------------------------------------ qabul qilish
  handle(s: TcpSegment) {
    this.lastActivity = this.stack.now;
    if (s.flags.rst) {
      this.terminate(this.state === 'SYN_SENT' ? 'refused' : 'rst');
      return;
    }
    switch (this.state) {
      case 'SYN_SENT':
        if (s.flags.syn && s.flags.ack) {
          this.stack.device.clearTimer(this.synTimer);
          this.rttMs = this.stack.now - this.openedAt;
          this.seq++;
          this.ack = s.seq + 1;
          this.state = 'ESTABLISHED';
          this.sendRaw(this.seg({ ack: true }));
          this.cb.onOpen?.(this);
        }
        return;
      case 'SYN_RCVD':
        if (s.flags.syn && !s.flags.ack) {
          // SYN qayta keldi — SYN-ACK ni qayta yuboramiz
          this.seq--;
          this.sendRaw(this.seg({ syn: true, ack: true }));
          this.seq++;
          return;
        }
        if (s.flags.ack) {
          this.state = 'ESTABLISHED';
          this.cb.onOpen?.(this);
        }
        if (s.dataSize === 0 && !s.flags.fin) return;
        break;
      case 'FIN_WAIT':
        if (s.flags.fin) {
          this.ack = s.seq + 1;
          this.sendRaw(this.seg({ ack: true }));
          this.terminate('local', false);
          return;
        }
        break;
      case 'CLOSED':
        return;
    }
    if (s.flags.ack) this.processAck(s.ack);
    if (s.dataSize > 0) this.processData(s);
    if (s.flags.fin && this.state === 'ESTABLISHED') {
      this.ack = s.seq + s.dataSize + 1;
      this.sendRaw(this.seg({ fin: true, ack: true }));
      this.seq++;
      this.terminate('fin');
    }
  }

  private processAck(ack: number) {
    const done = this.outstanding.filter((o) => o.endSeq <= ack);
    if (!done.length) return;
    for (const o of done) this.stack.device.clearTimer(o.timer);
    this.outstanding = this.outstanding.filter((o) => o.endSeq > ack);
  }

  private processData(s: TcpSegment) {
    const idx = s.segIndex ?? 0;
    const count = s.segCount ?? 1;
    const start = s.seq - idx * MSS;
    if (start < this.ack) {
      // takroriy (qayta yuborilgan) — faqat ACK
      if (idx === count - 1) this.sendRaw(this.seg({ ack: true }));
      return;
    }
    if (start > this.ack) return; // oldingi xabar hali kelmagan
    if (!this.rx || this.rx.start !== start) this.rx = { start, got: 0 };
    this.rx.got++;
    if (idx === count - 1) {
      const complete = this.rx.got === count;
      this.rx = null;
      if (!complete) return; // qaysidir segment yo'qolgan — qayta yuborishni kutamiz
      const total = (count - 1) * MSS + s.dataSize;
      this.ack = start + total;
      this.bytesRecv += total;
      this.sendRaw(this.seg({ ack: true }));
      if (s.data) this.cb.onData?.(this, s.data);
    }
  }
}

export function connKey(lip: string, lport: number, rip: string, rport: number) {
  return `${lip}:${lport}>${rip}:${rport}`;
}

export class TcpStack {
  stack: IpStack;
  conns = new Map<string, TcpConn>();
  private listeners = new Map<number, (c: TcpConn) => TcpCallbacks | null>();
  private nextPort = 49152 + Math.floor(Math.random() * 1000);
  /** Bir vaqtdagi maksimal ulanishlar (server resursi) */
  maxConnections = 10000;
  stats = { accepted: 0, refused: 0, resets: 0 };

  constructor(stack: IpStack) {
    this.stack = stack;
  }

  listen(port: number, accept: (c: TcpConn) => TcpCallbacks | null) {
    this.listeners.set(port, accept);
  }

  unlisten(port: number) {
    this.listeners.delete(port);
  }

  isListening(port: number) {
    return this.listeners.has(port);
  }

  allocPort() {
    for (let i = 0; i < 16384; i++) {
      const p = this.nextPort++;
      if (this.nextPort > 65535) this.nextPort = 49152;
      if (![...this.conns.values()].some((c) => c.localPort === p)) return p;
    }
    return 49152;
  }

  connect(dstIp: string, dstPort: number, cb: TcpCallbacks, opts: { srcIp?: string; dscp?: number } = {}): TcpConn | null {
    const src = opts.srcIp ?? this.stack.sourceFor(dstIp) ?? (this.stack.isLocalIp(dstIp) ? dstIp : null);
    if (!src) return null;
    const c = new TcpConn(this.stack, src, this.allocPort(), dstIp, dstPort, 'SYN_SENT', cb);
    c.dscp = opts.dscp ?? 0;
    this.conns.set(c.key, c);
    c.startConnect();
    return c;
  }

  remove(c: TcpConn) {
    if (this.conns.get(c.key) === c) this.conns.delete(c.key);
  }

  receive(pkt: IPv4Packet, s: TcpSegment, _iface: L3Interface) {
    const key = connKey(pkt.dst, s.dstPort, pkt.src, s.srcPort);
    const c = this.conns.get(key);
    if (c) {
      c.handle(s);
      return;
    }
    if (s.flags.syn && !s.flags.ack) {
      const accept = this.listeners.get(s.dstPort);
      if (!accept || this.conns.size >= this.maxConnections) {
        this.stats.refused++;
        this.sendRst(pkt, s);
        return;
      }
      const nc = new TcpConn(this.stack, pkt.dst, s.dstPort, pkt.src, s.srcPort, 'SYN_RCVD', {});
      const cb = accept(nc);
      if (!cb) {
        this.stats.refused++;
        this.sendRst(pkt, s);
        return;
      }
      nc.cb = cb;
      nc.ack = s.seq + 1;
      this.conns.set(nc.key, nc);
      this.stats.accepted++;
      nc.sendRaw({ kind: 'tcp', srcPort: s.dstPort, dstPort: s.srcPort, seq: nc.seq, ack: nc.ack, flags: { syn: true, ack: true }, window: 65535, dataSize: 0 });
      nc.seq++;
      return;
    }
    if (!s.flags.rst) this.sendRst(pkt, s);
  }

  private sendRst(pkt: IPv4Packet, s: TcpSegment) {
    this.stats.resets++;
    this.stack.sendTcpSegment(pkt.dst, pkt.src, {
      kind: 'tcp',
      srcPort: s.dstPort,
      dstPort: s.srcPort,
      seq: s.flags.ack ? s.ack : 0,
      ack: s.seq + (s.flags.syn ? 1 : s.dataSize),
      flags: { rst: true, ack: true },
      window: 0,
      dataSize: 0,
    });
  }

  onIcmpError(icmp: IcmpMessage) {
    const o = icmp.original;
    if (!o || o.srcPort === undefined || o.dstPort === undefined) return;
    const c = this.conns.get(connKey(o.src, o.srcPort, o.dst, o.dstPort));
    if (c && c.state === 'SYN_SENT') c.terminate('unreachable');
  }

  onArpFail(pkt: IPv4Packet) {
    const s = pkt.payload as TcpSegment;
    const c = this.conns.get(connKey(pkt.src, s.srcPort, pkt.dst, s.dstPort));
    if (c && c.state === 'SYN_SENT') c.terminate('unreachable');
  }

  tick(now: number) {
    for (const c of [...this.conns.values()]) {
      if (now - c.lastActivity > 300_000) c.terminate('timeout');
    }
  }

  reset() {
    for (const c of [...this.conns.values()]) c.terminate('local', false);
    this.conns.clear();
  }
}
