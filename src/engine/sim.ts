// Diskret voqealarga asoslangan simulyator (discrete-event scheduler).
// Vaqt birligi — millisekund (simulyatsiya vaqti).

export interface SimEvent {
  time: number;
  seq: number;
  fn: () => void;
  cancelled: boolean;
  /** Simulyatsiya rejimida ko'rsatish uchun belgi (masalan: 'frame') */
  tag?: string;
}

export class Simulator {
  now = 0;
  private heap: SimEvent[] = [];
  private seq = 0;
  processed = 0;

  schedule(delayMs: number, fn: () => void, tag?: string): SimEvent {
    return this.at(this.now + Math.max(0, delayMs), fn, tag);
  }

  at(time: number, fn: () => void, tag?: string): SimEvent {
    const ev: SimEvent = { time: Math.max(time, this.now), seq: this.seq++, fn, cancelled: false, tag };
    this.push(ev);
    return ev;
  }

  cancel(ev: SimEvent | null | undefined) {
    if (ev) ev.cancelled = true;
  }

  get pending() {
    return this.heap.length;
  }

  peekTime(): number | null {
    while (this.heap.length && this.heap[0].cancelled) this.pop();
    return this.heap.length ? this.heap[0].time : null;
  }

  /** Keyingi (bekor qilinmagan) voqeani bajaradi */
  step(): SimEvent | null {
    while (this.heap.length) {
      const ev = this.pop()!;
      if (ev.cancelled) continue;
      this.now = ev.time;
      this.processed++;
      ev.fn();
      return ev;
    }
    return null;
  }

  /** `t` vaqtgacha bo'lgan barcha voqealarni bajaradi */
  runUntil(t: number, maxEvents = 2_000_000): number {
    let n = 0;
    while (n < maxEvents) {
      const nt = this.peekTime();
      if (nt === null || nt > t) break;
      this.step();
      n++;
    }
    if (n < maxEvents) this.now = Math.max(this.now, t);
    return n;
  }

  runFor(ms: number, maxEvents?: number) {
    return this.runUntil(this.now + ms, maxEvents);
  }

  clear() {
    this.heap = [];
  }

  private less(a: SimEvent, b: SimEvent) {
    return a.time < b.time || (a.time === b.time && a.seq < b.seq);
  }

  private push(ev: SimEvent) {
    const h = this.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(h[i], h[p])) {
        [h[i], h[p]] = [h[p], h[i]];
        i = p;
      } else break;
    }
  }

  private pop(): SimEvent | undefined {
    const h = this.heap;
    if (!h.length) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l], h[m])) m = l;
        if (r < h.length && this.less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }
}
