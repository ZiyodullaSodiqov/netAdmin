// Cisco parol shifrlash turlari (type 7 — qaytariladigan, type 5 — xesh).

/** Cisco "type 7" parol shifrlash (zaif — faqat ko'rsatish uchun) */
export function type7(s: string): string {
  const key = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';
  let out = '08';
  for (let i = 0; i < s.length; i++) out += (s.charCodeAt(i) ^ key.charCodeAt((i + 8) % key.length)).toString(16).toUpperCase().padStart(2, '0');
  return out;
}

export function decode7(enc: string): string {
  const key = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';
  const seed = parseInt(enc.slice(0, 2), 10);
  let out = '';
  for (let i = 2; i + 1 < enc.length; i += 2) {
    const b = parseInt(enc.slice(i, i + 2), 16);
    out += String.fromCharCode(b ^ key.charCodeAt((seed + (i - 2) / 2) % key.length));
  }
  return out;
}

/** "type 5" (MD5) ga o'xshash xesh (namoyish uchun) */
export function type5(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  const chars = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let out = '$1$mERr$';
  let x = h;
  for (let i = 0; i < 22; i++) {
    out += chars[x % 64];
    x = ((x * 1103515245 + 12345) >>> 0) ^ s.charCodeAt(i % Math.max(1, s.length));
  }
  return out;
}

