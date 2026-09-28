// IOS uslubidagi buyruqlar tahlilchisi: qisqartmalar (sh ip int br), "?" yordam, Tab to'ldirish, xato belgisi (^).
import { expandIfName } from '../port';
import { isValidIp, isValidMask, parseMac, parseVlanList } from '../util';

export type ParamKind = 'ip' | 'mask' | 'wild' | 'num' | 'word' | 'line' | 'iface' | 'vlanlist' | 'mac' | 'hex';

export interface KwToken {
  t: 'kw';
  words: string[]; // muqobil so'zlar
  key?: string;
  optional?: boolean;
}

export interface ParamToken {
  t: 'param';
  kind: ParamKind;
  key: string;
  min?: number;
  max?: number;
  optional?: boolean;
}

export type Token = KwToken | ParamToken;

export interface CmdDef<C> {
  modes: string[];
  pattern: string;
  tokens: Token[];
  /** "no" shakli ham qabul qilinadimi */
  no: 'allow' | 'only' | 'never';
  run: (ctx: C, a: Args) => unknown;
  priv?: number;
  hidden?: boolean;
}

export interface Args {
  no: boolean;
  /** Kalit bo'yicha qiymatlar (param yoki muqobil kalit so'z) */
  [key: string]: any;
}

/**
 * Pattern sintaksisi:
 *   "ip address <ip:ip> <mask:mask>"
 *   "switchport mode {mode:access|trunk}"
 *   "spanning-tree vlan <vlan:vlanlist> priority <pri:num:0-61440>"
 *   "description <text:line>"
 *   "[secondary]"  — ixtiyoriy kalit so'z (oxirida)
 */
export function parsePattern(p: string): Token[] {
  const out: Token[] = [];
  for (const raw of p.trim().split(/\s+/)) {
    let s = raw;
    let optional = false;
    if (s.startsWith('[') && s.endsWith(']')) {
      optional = true;
      s = s.slice(1, -1);
    }
    if (s.startsWith('<') && s.endsWith('>')) {
      const [key, kind, range] = s.slice(1, -1).split(':');
      const tok: ParamToken = { t: 'param', key, kind: (kind ?? 'word') as ParamKind, optional };
      if (range) {
        const [a, b] = range.split('-').map(Number);
        tok.min = a;
        tok.max = b;
      }
      out.push(tok);
    } else if (s.startsWith('{') && s.endsWith('}')) {
      const [key, alts] = s.slice(1, -1).split(':');
      out.push({ t: 'kw', key, words: alts.split('|'), optional });
    } else {
      out.push({ t: 'kw', words: s.split('|'), key: optional ? s : undefined, optional });
    }
  }
  return out;
}

export const PARAM_HELP: Record<ParamKind, string> = {
  ip: 'A.B.C.D',
  mask: 'A.B.C.D',
  wild: 'A.B.C.D',
  num: '<0-4294967295>',
  word: 'WORD',
  line: 'LINE',
  iface: 'Interface',
  vlanlist: 'WORD',
  mac: 'H.H.H',
  hex: 'Hex',
};

/** Parametr qiymatini tekshirish. Qaytaradi: iste'mol qilingan tokenlar soni (0 — mos emas) va qiymat */
function matchParam(tok: ParamToken, words: string[], i: number): { n: number; value?: any } {
  const w = words[i];
  if (w === undefined) return { n: 0 };
  switch (tok.kind) {
    case 'ip':
    case 'wild':
      return isValidIp(w) ? { n: 1, value: w } : { n: 0 };
    case 'mask':
      return isValidIp(w) && isValidMask(w) ? { n: 1, value: w } : isValidIp(w) ? { n: 1, value: w } : { n: 0 };
    case 'num': {
      if (!/^\d+$/.test(w)) return { n: 0 };
      const v = Number(w);
      if (tok.min !== undefined && v < tok.min) return { n: 0 };
      if (tok.max !== undefined && v > tok.max) return { n: 0 };
      return { n: 1, value: v };
    }
    case 'hex':
      return /^(0x)?[0-9a-f]+$/i.test(w) ? { n: 1, value: w } : { n: 0 };
    case 'word':
      return { n: 1, value: w };
    case 'line':
      return { n: words.length - i, value: words.slice(i).join(' ') };
    case 'vlanlist':
      return parseVlanList(w) ? { n: 1, value: w } : { n: 0 };
    case 'mac':
      return parseMac(w) ? { n: 1, value: parseMac(w) } : { n: 0 };
    case 'iface': {
      const one = expandIfName(w);
      if (one && /\d/.test(w)) return { n: 1, value: one };
      const next = words[i + 1];
      if (next !== undefined && /^[a-z-]+$/i.test(w) && /^\d/.test(next)) {
        const two = expandIfName(w + next);
        if (two) return { n: 2, value: two };
      }
      return { n: 0 };
    }
  }
}

export interface MatchResult<C> {
  cmd: CmdDef<C>;
  args: Args;
  /** Har bir kiritilgan so'z nimaga mos kelgani (kalit so'z yoki "param") */
  path: string[];
  complete: boolean;
  /** Mos kelmagan so'z pozitsiyasi */
  failAt: number;
  /** Nechta so'z iste'mol qilindi */
  consumed: number;
  /** Keyingi kutilayotgan token indeksi */
  nextTok: number;
}

function matchCmd<C>(cmd: CmdDef<C>, words: string[], no: boolean): MatchResult<C> {
  const args: Args = { no };
  const path: string[] = [];
  let i = 0;
  let k = 0;
  while (k < cmd.tokens.length && i < words.length) {
    const tok = cmd.tokens[k];
    const w = words[i].toLowerCase();
    if (tok.t === 'kw') {
      const exact = tok.words.find((x) => x === w);
      const pref = tok.words.filter((x) => x.startsWith(w));
      const hit = exact ?? (pref.length === 1 ? pref[0] : null);
      if (!hit) {
        if (tok.optional) {
          k++;
          continue;
        }
        return { cmd, args, path, complete: false, failAt: i, consumed: i, nextTok: k };
      }
      if (tok.key) args[tok.key] = hit;
      path.push(hit);
      i++;
      k++;
    } else {
      const m = matchParam(tok, words, i);
      if (!m.n) {
        if (tok.optional) {
          k++;
          continue;
        }
        return { cmd, args, path, complete: false, failAt: i, consumed: i, nextTok: k };
      }
      args[tok.key] = m.value;
      for (let j = 0; j < m.n; j++) path.push('<' + tok.key + '>');
      i += m.n;
      k++;
    }
  }
  if (i < words.length) return { cmd, args, path, complete: false, failAt: i, consumed: i, nextTok: k };
  // qolgan tokenlar ixtiyoriymi
  let rest = k;
  while (rest < cmd.tokens.length && cmd.tokens[rest].optional) rest++;
  return { cmd, args, path, complete: rest >= cmd.tokens.length, failAt: -1, consumed: i, nextTok: k };
}

export type ParseOutcome<C> =
  | { ok: true; cmd: CmdDef<C>; args: Args }
  | { ok: false; error: 'invalid'; pos: number }
  | { ok: false; error: 'incomplete' }
  | { ok: false; error: 'ambiguous'; word: string }
  | { ok: false; error: 'unknown' };

export function tokenize(line: string): string[] {
  // Qo'shtirnoq ichidagi bo'shliqlarni saqlash
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2]);
  return out;
}

export class CommandSet<C> {
  cmds: CmdDef<C>[] = [];

  add(modes: string | string[], pattern: string, run: CmdDef<C>['run'], opts: { no?: 'allow' | 'only' | 'never'; priv?: number; hidden?: boolean } = {}) {
    this.cmds.push({ modes: Array.isArray(modes) ? modes : [modes], pattern, tokens: parsePattern(pattern), no: opts.no ?? 'never', run, priv: opts.priv, hidden: opts.hidden });
  }

  forMode(mode: string) {
    return this.cmds.filter((c) => c.modes.includes(mode));
  }

  parse(mode: string, words: string[]): ParseOutcome<C> {
    let no = false;
    if (words[0]?.toLowerCase() === 'no' && words.length > 1) {
      no = true;
      words = words.slice(1);
    }
    const cands = this.forMode(mode).filter((c) => (no ? c.no !== 'never' : c.no !== 'only'));
    const results = cands.map((c) => matchCmd(c, words, no));
    let full = results.filter((r) => r.failAt === -1);
    if (!full.length) {
      const maxFail = Math.max(...results.map((r) => r.failAt), 0);
      if (maxFail === 0 && !results.some((r) => r.failAt > 0)) return { ok: false, error: words.length === 1 ? 'unknown' : 'invalid', pos: 0 } as any;
      return { ok: false, error: 'invalid', pos: maxFail + (no ? 1 : 0) };
    }
    // Noaniqlikni hal qilish: har pozitsiyada aniq mos so'z ustun
    for (let pos = 0; pos < words.length && full.length > 1; pos++) {
      const w = words[pos].toLowerCase();
      const opts = new Set(full.map((r) => r.path[pos]));
      if (opts.size <= 1) continue;
      const exact = full.filter((r) => r.path[pos] === w);
      if (exact.length) {
        full = exact;
        continue;
      }
      const kw = full.filter((r) => !r.path[pos]?.startsWith('<'));
      const kws = new Set(kw.map((r) => r.path[pos]));
      if (kws.size > 1) return { ok: false, error: 'ambiguous', word: words.slice(0, pos + 1).join(' ') };
      // kalit so'z parametrdan ustun
      if (kw.length) full = kw;
    }
    const complete = full.filter((r) => r.complete);
    if (!complete.length) return { ok: false, error: 'incomplete' };
    return { ok: true, cmd: complete[0].cmd, args: complete[0].args };
  }

  /** "?" yordam: keyingi mumkin bo'lgan so'zlar */
  help(mode: string, line: string, kwHelp: (w: string) => string): string[] {
    const endsWithSpace = /\s$/.test(line) || line === '';
    let words = tokenize(line);
    let no = false;
    if (words[0]?.toLowerCase() === 'no' && (words.length > 1 || endsWithSpace)) {
      no = true;
      words = words.slice(1);
    }
    const partial = endsWithSpace ? '' : words.pop() ?? '';
    const cands = this.forMode(mode).filter((c) => !c.hidden && (no ? c.no !== 'never' : c.no !== 'only'));
    const items = new Map<string, string>();
    let cr = false;
    for (const c of cands) {
      const r = matchCmd(c, words, no);
      if (r.failAt !== -1) continue;
      if (r.complete && partial === '') cr = true;
      // keyingi tokenlar (ixtiyoriylarni ham ko'rsatish)
      for (let k = r.nextTok; k < c.tokens.length; k++) {
        const tok = c.tokens[k];
        if (tok.t === 'kw') {
          for (const w of tok.words) if (w.startsWith(partial.toLowerCase())) items.set(w, kwHelp(w));
        } else if (partial === '') {
          const label = tok.kind === 'num' && tok.min !== undefined ? `<${tok.min}-${tok.max}>` : PARAM_HELP[tok.kind];
          items.set(label, paramHelp(tok));
        }
        if (!tok.optional) break;
      }
    }
    const out: string[] = [];
    const sorted = [...items.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const w = Math.max(12, ...sorted.map(([k]) => k.length + 2));
    for (const [k, h] of sorted) out.push(`  ${k.padEnd(w)}${h}`);
    if (cr) out.push('  <cr>');
    return out;
  }

  /** Tab: oxirgi so'zni to'ldirish */
  complete(mode: string, line: string): string | null {
    if (/\s$/.test(line)) return null;
    const words = tokenize(line);
    let no = false;
    let prefixWords = words.slice(0, -1);
    if (prefixWords[0]?.toLowerCase() === 'no') {
      no = true;
      prefixWords = prefixWords.slice(1);
    }
    const partial = (words[words.length - 1] ?? '').toLowerCase();
    const opts = new Set<string>();
    for (const c of this.forMode(mode)) {
      if (no ? c.no === 'never' : c.no === 'only') continue;
      const r = matchCmd(c, prefixWords, no);
      if (r.failAt !== -1) continue;
      for (let k = r.nextTok; k < c.tokens.length; k++) {
        const tok = c.tokens[k];
        if (tok.t === 'kw') for (const w of tok.words) if (w.startsWith(partial)) opts.add(w);
        if (!tok.optional) break;
      }
    }
    if (opts.size !== 1) return null;
    const w = [...opts][0];
    const head = line.slice(0, line.length - (words[words.length - 1] ?? '').length);
    return head + w + ' ';
  }
}

function paramHelp(t: ParamToken): string {
  switch (t.kind) {
    case 'ip':
      return 'IP address';
    case 'mask':
      return 'IP subnet mask';
    case 'wild':
      return 'Wildcard bits';
    case 'num':
      return t.key;
    case 'line':
      return 'Text';
    case 'iface':
      return 'Interface name (masalan: g0/1, fa0/1)';
    case 'vlanlist':
      return 'VLAN IDs (masalan: 10,20-30)';
    case 'mac':
      return 'MAC address';
    default:
      return t.key;
  }
}
