// Umumiy yordamchi funksiyalar: MAC va IPv4 manzillar bilan ishlash.

export type MAC = string; // "aa:bb:cc:dd:ee:ff" (kichik harflarda)

export const BROADCAST_MAC: MAC = 'ff:ff:ff:ff:ff:ff';
/** Cisco CDP / PVST+ / DTP multicast manzili */
export const CISCO_MCAST_MAC: MAC = '01:00:0c:cc:cc:cc';
/** IEEE 802.1D STP BPDU multicast manzili */
export const STP_MCAST_MAC: MAC = '01:80:c2:00:00:00';
export const PVST_MCAST_MAC: MAC = '01:00:0c:cc:cc:cd';

let macCounter = 0x100;

/** Ishlab chiqaruvchi OUI (birinchi 3 bayt) asosida yangi MAC yaratadi */
export function generateMac(oui = '00:e0:f7'): MAC {
  macCounter++;
  const n = macCounter;
  const b = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map((x) => x.toString(16).padStart(2, '0'));
  return `${oui}:${b.join(':')}`;
}

export function resetMacCounter(v = 0x100) {
  macCounter = v;
}

export function bumpMacCounter(mac: MAC) {
  const parts = mac.split(':');
  const n = parseInt(parts[3] + parts[4] + parts[5], 16);
  if (n > macCounter) macCounter = n;
}

export function isMulticastMac(mac: MAC): boolean {
  return (parseInt(mac.slice(0, 2), 16) & 1) === 1;
}

/** aa:bb:cc:dd:ee:ff -> aabb.ccdd.eeff (Cisco formati) */
export function macCisco(mac: MAC): string {
  const h = mac.replace(/:/g, '');
  return `${h.slice(0, 4)}.${h.slice(4, 8)}.${h.slice(8, 12)}`;
}

/** aa:bb:cc:dd:ee:ff -> AA-BB-CC-DD-EE-FF (Windows formati) */
export function macWindows(mac: MAC): string {
  return mac.toUpperCase().replace(/:/g, '-');
}

/** Har qanday formatdagi MAC ni normallashtiradi */
export function parseMac(s: string): MAC | null {
  const h = s.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (h.length !== 12) return null;
  return h.match(/.{2}/g)!.join(':');
}

export function compareMac(a: MAC, b: MAC): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------- IPv4

export function isValidIp(s: string | undefined | null): boolean {
  if (!s) return false;
  const p = s.split('.');
  if (p.length !== 4) return false;
  return p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255);
}

export function ipToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

export function intToIp(n: number): string {
  n = n >>> 0;
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

export function prefixToMask(prefix: number): string {
  if (prefix <= 0) return '0.0.0.0';
  return intToIp((0xffffffff << (32 - prefix)) >>> 0);
}

export function maskToPrefix(mask: string): number {
  let n = ipToInt(mask);
  let c = 0;
  while (n & 0x80000000) {
    c++;
    n = (n << 1) >>> 0;
  }
  return c;
}

export function isValidMask(mask: string): boolean {
  if (!isValidIp(mask)) return false;
  const n = ipToInt(mask);
  const inv = ~n >>> 0;
  return ((inv + 1) & inv) === 0;
}

/** Wildcard (0.0.0.255) -> mask (255.255.255.0) */
export function wildcardToMask(w: string): string {
  return intToIp(~ipToInt(w) >>> 0);
}

export function networkOf(ip: string, mask: string): string {
  return intToIp((ipToInt(ip) & ipToInt(mask)) >>> 0);
}

export function broadcastOf(ip: string, mask: string): string {
  return intToIp(((ipToInt(ip) & ipToInt(mask)) | (~ipToInt(mask) >>> 0)) >>> 0);
}

export function sameSubnet(a: string, b: string, mask: string): boolean {
  const m = ipToInt(mask);
  return ((ipToInt(a) & m) >>> 0) === ((ipToInt(b) & m) >>> 0);
}

export function inNetwork(ip: string, network: string, mask: string): boolean {
  return sameSubnet(ip, network, mask);
}

export function isBroadcastIp(ip: string): boolean {
  return ip === '255.255.255.255';
}

export function isMulticastIp(ip: string): boolean {
  const f = Number(ip.split('.')[0]);
  return f >= 224 && f <= 239;
}

/** Klassli tarmoq maskasi (A/B/C) — Windows IP kiritishda avtomatik taklif qiladi */
export function classfulMask(ip: string): string {
  const f = Number(ip.split('.')[0]);
  if (f < 128) return '255.0.0.0';
  if (f < 192) return '255.255.0.0';
  return '255.255.255.0';
}

/** "10.0.0.0/24" yoki "10.0.0.0 255.255.255.0" */
export function parseCidr(s: string): { ip: string; mask: string } | null {
  const m = s.trim().match(/^(\d+\.\d+\.\d+\.\d+)\s*\/\s*(\d+)$/);
  if (m && isValidIp(m[1]) && Number(m[2]) <= 32) return { ip: m[1], mask: prefixToMask(Number(m[2])) };
  const p = s.trim().split(/\s+/);
  if (p.length === 2 && isValidIp(p[0]) && isValidMask(p[1])) return { ip: p[0], mask: p[1] };
  return null;
}

// ---------------------------------------------------------------- VLAN ro'yxatlari

/** "1,10-20,30" -> Set */
export function parseVlanList(s: string): Set<number> | null {
  const out = new Set<number>();
  for (const part of s.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 4094 || a > b) return null;
    for (let i = a; i <= b; i++) out.add(i);
  }
  return out;
}

/** Set -> "1,10-20,30" */
export function formatVlanList(set: Iterable<number>): string {
  const arr = [...set].sort((a, b) => a - b);
  if (!arr.length) return 'none';
  const parts: string[] = [];
  let start = arr[0];
  let prev = arr[0];
  for (let i = 1; i <= arr.length; i++) {
    const v = arr[i];
    if (v === prev + 1) {
      prev = v;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = v;
    prev = v;
  }
  return parts.join(',');
}

// ---------------------------------------------------------------- boshqalar

export function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

export function padRight(s: string, n: number) {
  s = String(s);
  return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length);
}

export function padLeft(s: string, n: number) {
  s = String(s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

/** Deterministik tasodifiy sonlar generatori (mulberry32) */
export function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const w = Math.floor(s / 604800);
  const d = Math.floor((s % 604800) / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (w) parts.push(`${w} week${w > 1 ? 's' : ''}`);
  if (d) parts.push(`${d} day${d > 1 ? 's' : ''}`);
  if (h) parts.push(`${h} hour${h > 1 ? 's' : ''}`);
  parts.push(`${m} minute${m !== 1 ? 's' : ''}`);
  return parts.join(', ');
}

export function formatHms(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((x) => String(x).padStart(2, '0')).join(':');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatBps(bps: number): string {
  if (bps < 1000) return `${bps.toFixed(0)} bit/s`;
  if (bps < 1e6) return `${(bps / 1e3).toFixed(1)} Kbit/s`;
  if (bps < 1e9) return `${(bps / 1e6).toFixed(1)} Mbit/s`;
  return `${(bps / 1e9).toFixed(2)} Gbit/s`;
}
