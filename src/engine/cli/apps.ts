// Ping / traceroute — IOS va kompyuter terminallari uchun umumiy.
import type { IpStack } from '../ipstack';
import type { Device } from '../device';

export type PingResult =
  | { kind: 'reply'; from: string; rtt: number; ttl: number; bytes: number }
  | { kind: 'timeout' }
  | { kind: 'unreachable'; from: string; code: number }
  | { kind: 'ttl-exceeded'; from: string }
  | { kind: 'no-route' }
  | { kind: 'error'; text: string };

let identCounter = 0x1000;

export function newIdent() {
  identCounter = (identCounter + 1) & 0xffff;
  if (identCounter < 0x1000) identCounter = 0x1000;
  return identCounter;
}

/** Bitta ICMP echo so'rovi */
export function pingOnce(
  dev: Device,
  stack: IpStack,
  dst: string,
  opts: { ident: number; seq: number; size: number; timeoutMs: number; ttl?: number; src?: string },
  cb: (r: PingResult) => void,
) {
  const t0 = dev.now;
  let done = false;
  const finish = (r: PingResult) => {
    if (done) return;
    done = true;
    dev.clearTimer(timer);
    stack.icmpUnlisten(opts.ident);
    cb(r);
  };
  stack.icmpListen(opts.ident, (pkt, icmp) => {
    if (icmp.type === 'echo-reply' && icmp.seq === opts.seq) finish({ kind: 'reply', from: pkt.src, rtt: dev.now - t0, ttl: pkt.ttl, bytes: icmp.dataSize });
    else if (icmp.type === 'dest-unreachable' && icmp.original?.seq === opts.seq) finish({ kind: 'unreachable', from: pkt.src, code: icmp.code });
    else if (icmp.type === 'time-exceeded' && icmp.original?.seq === opts.seq) finish({ kind: 'ttl-exceeded', from: pkt.src });
  });
  const timer = dev.setTimer(opts.timeoutMs, () => finish({ kind: 'timeout' }));
  const r = stack.sendEcho(dst, opts.ident, opts.seq, opts.size, { ttl: opts.ttl, src: opts.src });
  if (r === 'no-route' || r === 'no-iface') {
    // Marshrut yo'q — javob kutilmaydi
    dev.setTimer(opts.timeoutMs > 1000 ? 5 : 1, () => finish({ kind: 'no-route' }));
  }
}

export interface TraceHop {
  ttl: number;
  probes: ({ from: string; rtt: number } | null)[];
  reached: boolean;
}

/** Traceroute: ICMP (Windows tracert) yoki UDP (Cisco/Linux) */
export function traceroute(
  dev: Device,
  stack: IpStack,
  dst: string,
  opts: { mode: 'icmp' | 'udp'; maxHops: number; probes: number; timeoutMs: number },
  onHop: (h: TraceHop) => void,
  onDone: (reached: boolean) => void,
): () => void {
  let cancelled = false;
  const ident = newIdent();
  let ttl = 1;
  let port = 33434;
  const srcPort = 40000 + (ident % 20000);
  const runHop = () => {
    if (cancelled) return;
    const hop: TraceHop = { ttl, probes: [], reached: false };
    let probe = 0;
    const next = () => {
      if (cancelled) return;
      if (probe >= opts.probes) {
        onHop(hop);
        if (hop.reached || ttl >= opts.maxHops) return onDone(hop.reached);
        ttl++;
        runHop();
        return;
      }
      probe++;
      const t0 = dev.now;
      let done = false;
      const seq = ttl * 10 + probe;
      const finish = (r: { from: string; rtt: number } | null, reached = false) => {
        if (done) return;
        done = true;
        dev.clearTimer(timer);
        stack.icmpUnlisten(opts.mode === 'icmp' ? ident : srcPort);
        hop.probes.push(r);
        if (reached) hop.reached = true;
        next();
      };
      const key = opts.mode === 'icmp' ? ident : srcPort;
      stack.icmpListen(key, (pkt, icmp) => {
        if (icmp.type === 'time-exceeded') finish({ from: pkt.src, rtt: dev.now - t0 });
        else if (icmp.type === 'echo-reply' && icmp.seq === seq) finish({ from: pkt.src, rtt: dev.now - t0 }, true);
        else if (icmp.type === 'dest-unreachable') finish({ from: pkt.src, rtt: dev.now - t0 }, icmp.code === 3 || pkt.src === dst);
      });
      const timer = dev.setTimer(opts.timeoutMs, () => finish(null));
      if (opts.mode === 'icmp') stack.sendEcho(dst, ident, seq, 32, { ttl });
      else stack.sendUdp(dst, srcPort, port++, { kind: 'raw', size: 12, label: 'traceroute' }, { ttl });
    };
    next();
  };
  runHop();
  return () => {
    cancelled = true;
  };
}
