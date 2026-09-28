// Kompyuter ilovalari: web-brauzer (HTTP klient) va yuklama generatori (ko'p foydalanuvchi simulyatsiyasi).
import type { Host } from './host';
import type { HttpResponse } from '../packets';

let reqCounter = 1;

export interface FetchResult {
  ok: boolean;
  status?: number;
  statusText?: string;
  body?: string;
  size?: number;
  error?: string;
  ms: number;
  ip?: string;
  timings?: { dns: number; connect: number; wait: number; total: number };
}

export function parseUrl(url: string): { secure: boolean; host: string; port: number; path: string } {
  let u = url.trim();
  let secure = false;
  if (u.startsWith('https://')) {
    secure = true;
    u = u.slice(8);
  } else if (u.startsWith('http://')) u = u.slice(7);
  const slash = u.indexOf('/');
  const hostPort = slash >= 0 ? u.slice(0, slash) : u;
  const path = slash >= 0 ? u.slice(slash) : '/';
  const [host, p] = hostPort.split(':');
  return { secure, host, port: p ? Number(p) : secure ? 443 : 80, path: path || '/' };
}

/** HTTP so'rov (DNS -> TCP ulanish -> GET -> javob) */
export function httpFetch(host: Host, url: string, cb: (r: FetchResult) => void, opts: { timeoutMs?: number } = {}) {
  const t0 = host.now;
  const u = parseUrl(url);
  const timeout = opts.timeoutMs ?? 10_000;
  let done = false;
  let conn: ReturnType<Host['stack']['tcp']['connect']> = null;
  const finish = (r: Omit<FetchResult, 'ms'>) => {
    if (done) return;
    done = true;
    host.clearTimer(timer);
    conn?.close();
    cb({ ...r, ms: host.now - t0 });
  };
  const timer = host.setTimer(timeout, () => finish({ ok: false, error: 'Request Timeout' }));
  host.resolver.resolve(u.host, (ip, err) => {
    if (!ip) return finish({ ok: false, error: err === 'no-route' ? 'Host Name Unresolved (DNS serverga yo\'l yo\'q)' : 'Host Name Unresolved' });
    const tDns = host.now;
    let tConn = 0;
    const reqId = reqCounter++;
    conn = host.stack.tcp.connect(ip, u.port, {
      onOpen: (c) => {
        tConn = host.now;
        c.send({ kind: 'http-req', method: 'GET', host: u.host, path: u.path, size: 350 + u.path.length, reqId });
      },
      onData: (_c, msg) => {
        if (msg.kind !== 'http-res' || msg.reqId !== reqId) return;
        const m = msg as HttpResponse;
        const now = host.now;
        finish({ ok: m.status < 400, status: m.status, statusText: m.statusText, body: m.body, size: m.size, ip, timings: { dns: tDns - t0, connect: tConn - tDns, wait: now - tConn, total: now - t0 } });
      },
      onClose: (_c, reason) => {
        if (reason === 'refused') finish({ ok: false, error: 'Server Reset Connection (port yopiq)', ip });
        else if (reason === 'timeout' || reason === 'unreachable') finish({ ok: false, error: 'Request Timeout', ip });
        else if (reason === 'rst') finish({ ok: false, error: 'Server Reset Connection', ip });
      },
    });
    if (!conn) finish({ ok: false, error: 'Tarmoqqa ulanish yo\'q (default gateway sozlanmagan?)' });
  });
}

export interface LoadStats {
  sent: number;
  ok: number;
  errors: number;
  timeouts: number;
  status5xx: number;
  latencies: number[];
  bytes: number;
  startedAt: number;
  history: { t: number; rps: number; ok: number; err: number; avgMs: number }[];
}

/** Yuklama generatori: N so'rov/soniya, bir vaqtdagi ulanishlar chegarasi bilan (wrk / JMeter kabi) */
export class LoadGenerator {
  host: Host;
  url: string;
  rps: number;
  maxInFlight: number;
  durationSec: number;
  running = false;
  inFlight = 0;
  stats: LoadStats = this.emptyStats();
  private stop_: (() => void) | null = null;
  private win = { sent: 0, ok: 0, err: 0, lat: [] as number[] };

  constructor(host: Host, url: string, rps = 50, maxInFlight = 200, durationSec = 60) {
    this.host = host;
    this.url = url;
    this.rps = rps;
    this.maxInFlight = maxInFlight;
    this.durationSec = durationSec;
  }

  private emptyStats(): LoadStats {
    return { sent: 0, ok: 0, errors: 0, timeouts: 0, status5xx: 0, latencies: [], bytes: 0, startedAt: 0, history: [] };
  }

  start() {
    this.stop();
    this.stats = this.emptyStats();
    this.stats.startedAt = this.host.now;
    this.running = true;
    const interval = Math.max(1, 1000 / this.rps);
    let acc = 0;
    this.stop_ = this.host.every(10, () => {
      if (!this.running) return;
      if (this.durationSec > 0 && this.host.now - this.stats.startedAt > this.durationSec * 1000) {
        this.stop();
        return;
      }
      acc += 10;
      while (acc >= interval) {
        acc -= interval;
        this.fire();
      }
    });
  }

  private fire() {
    if (this.inFlight >= this.maxInFlight) {
      this.stats.errors++;
      this.win.err++;
      return;
    }
    this.inFlight++;
    this.stats.sent++;
    this.win.sent++;
    httpFetch(
      this.host,
      this.url,
      (r) => {
        this.inFlight--;
        if (r.ok) {
          this.stats.ok++;
          this.win.ok++;
          this.stats.bytes += r.size ?? 0;
          this.stats.latencies.push(r.ms);
          if (this.stats.latencies.length > 5000) this.stats.latencies.splice(0, 1000);
          this.win.lat.push(r.ms);
        } else {
          this.stats.errors++;
          this.win.err++;
          if (r.error === 'Request Timeout') this.stats.timeouts++;
          if ((r.status ?? 0) >= 500) this.stats.status5xx++;
        }
      },
      { timeoutMs: 8000 },
    );
  }

  tick() {
    if (!this.running && !this.win.sent && !this.win.ok) return;
    const avg = this.win.lat.length ? this.win.lat.reduce((a, b) => a + b, 0) / this.win.lat.length : 0;
    this.stats.history.push({ t: this.host.now, rps: this.win.sent, ok: this.win.ok, err: this.win.err, avgMs: avg });
    if (this.stats.history.length > 180) this.stats.history.shift();
    this.win = { sent: 0, ok: 0, err: 0, lat: [] };
  }

  stop() {
    this.running = false;
    this.stop_?.();
    this.stop_ = null;
  }

  percentile(p: number) {
    const a = [...this.stats.latencies].sort((x, y) => x - y);
    if (!a.length) return 0;
    return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
  }
}
