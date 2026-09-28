// Qurilma modellari — haqiqiy uskunalarga mos portlar to'plami.
import type { PortSpec } from '../port';

export interface RouterModel {
  id: string;
  name: string;
  description: string;
  ports: PortSpec[];
  cme: boolean;
  platform: string;
  image: string;
  ramMb: number;
  flashMb: number;
}

const gi = (name: string, auto = true): PortSpec => ({ name, media: 'copper', speeds: [10, 100, 1000], mdi: 'MDI', autoMdix: auto });
const fa = (name: string, auto = true, mdi: 'MDI' | 'MDIX' = 'MDI'): PortSpec => ({ name, media: 'copper', speeds: [10, 100], mdi, autoMdix: auto });
const sfp = (name: string): PortSpec => ({ name, media: 'fiber', speeds: [1000], mdi: 'MDI', autoMdix: false });
const con = (name = 'Console'): PortSpec => ({ name, media: 'console', speeds: [0], mdi: 'MDI', autoMdix: false, label: 'Console' });

export const ROUTER_MODELS: Record<string, RouterModel> = {
  '2911': {
    id: '2911',
    name: 'ISR 2911',
    description: "Integrated Services Router: 3×Gigabit Ethernet (RJ45), CallManager Express (IP telefoniya) qo'llab-quvvatlanadi",
    ports: [gi('GigabitEthernet0/0'), gi('GigabitEthernet0/1'), gi('GigabitEthernet0/2'), con()],
    cme: true,
    platform: 'CISCO2911/K9',
    image: 'c2900-universalk9-mz.SPA.155-3.M4a.bin',
    ramMb: 512,
    flashMb: 256,
  },
  '4331': {
    id: '4331',
    name: 'ISR 4331',
    description: '2×Gigabit Ethernet (RJ45) + 1×SFP optik port, filial va bosh ofis uchun',
    ports: [gi('GigabitEthernet0/0/0'), gi('GigabitEthernet0/0/1'), sfp('GigabitEthernet0/0/2'), con()],
    cme: true,
    platform: 'ISR4331/K9',
    image: 'isr4300-universalk9.16.09.04.SPA.bin',
    ramMb: 4096,
    flashMb: 8192,
  },
  '1841': {
    id: '1841',
    name: 'Router 1841 (eski)',
    description: "2×FastEthernet, Auto-MDIX yo'q — kompyuterga faqat kross kabel bilan ulanadi",
    ports: [fa('FastEthernet0/0', false), fa('FastEthernet0/1', false), con()],
    cme: false,
    platform: 'CISCO1841',
    image: 'c1841-advipservicesk9-mz.124-15.T1.bin',
    ramMb: 128,
    flashMb: 64,
  },
};

export interface SwitchModel {
  id: string;
  name: string;
  description: string;
  ports: PortSpec[];
  layer3: boolean;
  poeBudgetW: number;
  platform: string;
  image: string;
}

function range(prefix: string, from: number, to: number, mk: (n: string) => PortSpec) {
  const out: PortSpec[] = [];
  for (let i = from; i <= to; i++) out.push(mk(`${prefix}${i}`));
  return out;
}

const swFa = (poe: number) => (name: string): PortSpec => ({ name, media: 'copper', speeds: [10, 100], mdi: 'MDIX', autoMdix: true, poeMaxW: poe || undefined });
const swGi = (poe: number) => (name: string): PortSpec => ({ name, media: 'copper', speeds: [10, 100, 1000], mdi: 'MDIX', autoMdix: true, poeMaxW: poe || undefined });
const swSfp = (name: string): PortSpec => ({ name, media: 'fiber', speeds: [1000], mdi: 'MDIX', autoMdix: false });

export const SWITCH_MODELS: Record<string, SwitchModel> = {
  '2960-24TT': {
    id: '2960-24TT',
    name: 'Catalyst 2960-24TT',
    description: "L2 kirish (access) kommutatori: 24×FastEthernet + 2×Gigabit uplink, PoE yo'q",
    ports: [...range('FastEthernet0/', 1, 24, swFa(0)), ...range('GigabitEthernet0/', 1, 2, swGi(0)), con()],
    layer3: false,
    poeBudgetW: 0,
    platform: 'WS-C2960-24TT-L',
    image: 'c2960-lanbasek9-mz.150-2.SE4.bin',
  },
  '2960-24PS': {
    id: '2960-24PS',
    name: 'Catalyst 2960-24PS (PoE)',
    description: "24×FastEthernet PoE (IP telefon, Wi-Fi AP uchun, 370 Vt) + 2×Gigabit uplink",
    ports: [...range('FastEthernet0/', 1, 24, swFa(15.4)), ...range('GigabitEthernet0/', 1, 2, swGi(0)), con()],
    layer3: false,
    poeBudgetW: 370,
    platform: 'WS-C2960-24PS-L',
    image: 'c2960-lanbasek9-mz.150-2.SE4.bin',
  },
  '3560-24PS': {
    id: '3560-24PS',
    name: 'Catalyst 3560-24PS (L3, PoE)',
    description: 'Multilayer (L3) kommutator: VLAN lar orasida marshrutlash (SVI), 24×FastEthernet PoE + 2×SFP optik',
    ports: [...range('FastEthernet0/', 1, 24, swFa(15.4)), ...range('GigabitEthernet0/', 1, 2, swSfp), con()],
    layer3: true,
    poeBudgetW: 370,
    platform: 'WS-C3560-24PS-S',
    image: 'c3560-ipservicesk9-mz.150-2.SE4.bin',
  },
  '3650-24PS': {
    id: '3650-24PS',
    name: 'Catalyst 3650-24PS (L3, PoE+)',
    description: "Yadro/taqsimlash kommutatori: 24×Gigabit PoE+ (30 Vt) + 4×SFP optik uplink",
    ports: [...range('GigabitEthernet1/0/', 1, 24, swGi(30)), ...range('GigabitEthernet1/1/', 1, 4, swSfp), con()],
    layer3: true,
    poeBudgetW: 640,
    platform: 'WS-C3650-24PS',
    image: 'cat3k_caa-universalk9.16.03.07.SPA.bin',
  },
};

export { gi, fa, sfp, con };
