// Server xizmatlari: HTTP/HTTPS (real yuklama modeli bilan), DNS, DHCP, Syslog.
// Yuklama modeli: har bir so'rov CPU yadrosini ma'lum vaqt band qiladi; yadrolar band bo'lsa — navbat;
// navbat to'lsa — 503; xotira tugasa — swap (sekinlashuv). Haqiqiy serverlardagi kabi latency o'sadi.
import type { Host } from './host';
import type { TcpConn } from '../protocols/tcp';
import type { HttpRequest, HttpResponse } from '../packets';

export interface WebPage {
  path: string;
  title: string;
  body: string;
  /** Javob o'lchami (bayt) — rasm/skriptlar bilan birga */
  size: number;
  /** Bitta so'rovga ketadigan CPU vaqti (ms, 3 GHz yadroda) — dinamik sahifa (PHP/DB) qimmatroq */
  cpuMs: number;
  /** Ma'lumotlar bazasi so'rovi (ms, disk I/O) */
  dbMs: number;
}

export interface ServerHardware {
  cpuCores: number;
  cpuGhz: number;
  ramMb: number;
  /** Tarmoq kartasi: Mbit/s (port tezligi bilan cheklanadi) */
  diskIops: number;
}

export interface LoadSample {
  t: number;
  cpu: number; // %
  ram: number; // %
  rps: number;
  latencyMs: number;
  errors: number;
  active: number;
  queue: number;
  netInMbps: number;
  netOutMbps: number;
}

interface Job {
  conn: TcpConn;
  req: HttpRequest;
  arrived: number;
  page: WebPage | null;
}

export class HttpService {
  host: Host;
  enabled = true;
  httpsEnabled = true;
  pages = new Map<string, WebPage>();
  maxQueue = 512;
  maxConnections = 2000;
  private queue: Job[] = [];
  private busyCores = 0;
  private busyMs = 0; // joriy soniyadagi band yadro vaqti
  private dbBusyUntil = 0;
  private winReq = 0;
  private winErr = 0;
  private winLat: number[] = [];
  history: LoadSample[] = [];
  totals = { requests: 0, ok: 0, errors: 0, bytesOut: 0 };
  current: LoadSample = { t: 0, cpu: 0, ram: 0, rps: 0, latencyMs: 0, errors: 0, active: 0, queue: 0, netInMbps: 0, netOutMbps: 0 };

  constructor(host: Host) {
    this.host = host;
    this.pages.set('/', {
      path: '/',
      title: 'NetAdmin School',
      body: '<h1>Salom! Bu NetAdmin School web serveri.</h1><p>Server ishlayapti. Tarmoq sozlamalari to\'g\'ri!</p>',
      size: 32_000,
      cpuMs: 4,
      dbMs: 0,
    });
    this.pages.set('/api/data', {
      path: '/api/data',
      title: 'API',
      body: '{"status":"ok","users":1532}',
      size: 2_000,
      cpuMs: 25,
      dbMs: 8,
    });
  }

  get hw() {
    return this.host.hardware;
  }

  install() {
    const stack = this.host.stack;
    const accept = (secure: boolean) => (c: TcpConn) => {
      if (!this.enabled || (secure && !this.httpsEnabled)) return null;
      if (stack.tcp.conns.size >= this.maxConnections) return null;
      return {
        onData: (conn: TcpConn, msg: any) => {
          if (msg.kind === 'http-req') this.onRequest(conn, msg, secure);
        },
      };
    };
    stack.tcp.listen(80, accept(false));
    stack.tcp.listen(443, accept(true));
  }

  uninstall() {
    this.host.stack.tcp.unlisten(80);
    this.host.stack.tcp.unlisten(443);
  }

  /** Xotira ishlatilishi (MB): OS + ulanishlar + navbat */
  ramUsedMb() {
    const conns = this.host.stack.tcp.conns.size;
    return 900 + conns * 2 + this.queue.length * 1.5 + this.busyCores * 40;
  }

  private onRequest(conn: TcpConn, req: HttpRequest, secure: boolean) {
    this.totals.requests++;
    this.winReq++;
    const now = this.host.now;
    const page = this.pages.get(req.path) ?? null;
    if (this.queue.length >= this.maxQueue) {
      // Server haddan tashqari yuklangan
      this.respond(conn, req, 503, 'Service Unavailable', 300, now, '<h1>503 Service Unavailable</h1><p>Server haddan tashqari band.</p>');
      return;
    }
    this.queue.push({ conn, req, arrived: now, page });
    this.pump(secure);
  }

  private pump(secure = false) {
    while (this.busyCores < this.hw.cpuCores && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.conn.state === 'CLOSED') continue;
      this.busyCores++;
      // CPU vaqti: chastotaga moslash + HTTPS (TLS) qo'shimcha xarajati + xotira yetishmasa swap
      const base = job.page?.cpuMs ?? 1;
      const ghz = 3 / this.hw.cpuGhz;
      const tls = secure || job.conn.localPort === 443 ? 1.5 : 0;
      const swap = this.ramUsedMb() > this.hw.ramMb ? 8 : 1;
      const cpu = (base + tls) * ghz * swap;
      // DB so'rovi disk bilan ketma-ket (IOPS cheklovi)
      let db = 0;
      if (job.page?.dbMs) {
        const now = this.host.now;
        const perIo = 1000 / this.hw.diskIops;
        const start = Math.max(now, this.dbBusyUntil);
        this.dbBusyUntil = start + perIo;
        db = this.dbBusyUntil - now + job.page.dbMs;
      }
      this.busyMs += cpu;
      this.host.setTimer(cpu + db, () => {
        this.busyCores--;
        const p = job.page;
        if (p) this.respond(job.conn, job.req, 200, 'OK', p.size, job.arrived, p.body, p.title);
        else this.respond(job.conn, job.req, 404, 'Not Found', 400, job.arrived, '<h1>404 Not Found</h1>');
        this.pump();
      });
    }
  }

  private respond(conn: TcpConn, req: HttpRequest, status: number, statusText: string, size: number, arrived: number, body: string, title?: string) {
    const now = this.host.now;
    const res: HttpResponse = { kind: 'http-res', status, statusText, size, body: title ? `<title>${title}</title>${body}` : body, reqId: req.reqId, serverMs: now - arrived };
    if (status >= 500) {
      this.winErr++;
      this.totals.errors++;
    } else this.totals.ok++;
    this.winLat.push(now - arrived);
    this.totals.bytesOut += size;
    conn.send(res);
  }

  /** Har soniyada statistikani yig'ish */
  sample() {
    const hw = this.hw;
    const port = this.host.ports.find((p) => p.operUp && p.media !== 'console');
    const now = this.host.now;
    const s: LoadSample = {
      t: now,
      cpu: Math.min(100, (this.busyMs / (hw.cpuCores * 1000)) * 100 + 1),
      ram: Math.min(100, (this.ramUsedMb() / hw.ramMb) * 100),
      rps: this.winReq,
      latencyMs: this.winLat.length ? this.winLat.reduce((a, b) => a + b, 0) / this.winLat.length : 0,
      errors: this.winErr,
      active: this.host.stack.tcp.conns.size,
      queue: this.queue.length,
      netInMbps: port ? port.rateIn / 1e6 : 0,
      netOutMbps: port ? port.rateOut / 1e6 : 0,
    };
    // band yadrolar keyingi soniyaga o'tib ketishi mumkin — CPU ni 100% dan oshirmaymiz
    this.busyMs = Math.max(0, this.busyMs - hw.cpuCores * 1000);
    if (this.busyMs > 0) this.busyMs = Math.min(this.busyMs, hw.cpuCores * 1000);
    this.winReq = 0;
    this.winErr = 0;
    this.winLat = [];
    this.current = s;
    this.history.push(s);
    if (this.history.length > 180) this.history.shift();
  }

  reset() {
    this.queue = [];
    this.busyCores = 0;
    this.busyMs = 0;
  }
}

export interface SyslogEntry {
  t: number;
  from: string;
  text: string;
}

export class SyslogService {
  host: Host;
  enabled = false;
  entries: SyslogEntry[] = [];

  constructor(host: Host) {
    this.host = host;
  }

  install() {
    this.host.stack.udpBind(514, (pkt, udp) => {
      if (!this.enabled || udp.payload.kind !== 'syslog') return;
      this.entries.push({ t: this.host.now, from: pkt.src, text: udp.payload.text });
      if (this.entries.length > 500) this.entries.shift();
    });
  }
}
