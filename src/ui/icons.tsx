// Qurilma ikonkalari (SVG), markazi (0,0), o'lchami ~48px.
import type { JSX } from 'react';
import type { DeviceKind } from '../engine/device';

export function DeviceIcon({ kind, size = 48, off = false }: { kind: DeviceKind; size?: number; off?: boolean }) {
  const s = size / 48;
  const dim = off ? 0.45 : 1;
  return (
    <g transform={`scale(${s})`} opacity={dim}>
      {ICONS[kind] ?? ICONS.pc}
    </g>
  );
}

const arrow = (x: number, y: number, rot: number, color = '#fff') => (
  <path d="M-5,-2 L3,-2 L3,-5 L8,0 L3,5 L3,2 L-5,2 Z" fill={color} transform={`translate(${x},${y}) rotate(${rot})`} />
);

const ICONS: Record<string, JSX.Element> = {
  router: (
    <g>
      <ellipse cx={0} cy={6} rx={22} ry={9} fill="#1e3a8a" />
      <rect x={-22} y={-6} width={44} height={12} fill="#2563eb" />
      <ellipse cx={0} cy={-6} rx={22} ry={9} fill="#3b82f6" stroke="#1d4ed8" />
      {arrow(-9, -8, 200)}
      {arrow(9, -4, 20)}
      {arrow(-4, -12, 290)}
      {arrow(4, 0, 110)}
    </g>
  ),
  switch: (
    <g>
      <path d="M-24,-4 L-16,-12 L24,-12 L16,-4 Z" fill="#38bdf8" />
      <rect x={-24} y={-4} width={40} height={14} fill="#0284c7" />
      <path d="M16,-4 L24,-12 L24,2 L16,10 Z" fill="#075985" />
      {arrow(-12, -8, 0)}
      {arrow(6, -8, 180)}
      <g transform="translate(-20,0)">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <rect key={i} x={i * 4.4} y={2} width={3} height={3} fill="#bae6fd" />
        ))}
      </g>
    </g>
  ),
  l3switch: (
    <g>
      <path d="M-24,-4 L-16,-12 L24,-12 L16,-4 Z" fill="#818cf8" />
      <rect x={-24} y={-4} width={40} height={14} fill="#4f46e5" />
      <path d="M16,-4 L24,-12 L24,2 L16,10 Z" fill="#312e81" />
      {arrow(-12, -8, 0)}
      {arrow(6, -8, 180)}
      <text x={-4} y={8} fontSize={9} fill="#fff" fontWeight={700} textAnchor="middle">
        L3
      </text>
    </g>
  ),
  pc: (
    <g>
      <rect x={-18} y={-18} width={30} height={22} rx={2} fill="#334155" />
      <rect x={-15} y={-15} width={24} height={16} fill="#38bdf8" />
      <rect x={-6} y={4} width={6} height={5} fill="#475569" />
      <rect x={-12} y={9} width={18} height={3} rx={1} fill="#475569" />
      <rect x={14} y={-16} width={9} height={28} rx={1} fill="#1e293b" />
      <circle cx={18.5} cy={-11} r={1.5} fill="#22c55e" />
    </g>
  ),
  laptop: (
    <g>
      <path d="M-16,-16 L16,-16 L16,6 L-16,6 Z" fill="#334155" />
      <rect x={-13} y={-13} width={26} height={16} fill="#7dd3fc" />
      <path d="M-22,6 L22,6 L25,12 L-25,12 Z" fill="#64748b" />
    </g>
  ),
  server: (
    <g>
      <rect x={-14} y={-22} width={28} height={44} rx={2} fill="#1f2937" />
      {[0, 1, 2, 3].map((i) => (
        <g key={i} transform={`translate(0,${-18 + i * 10})`}>
          <rect x={-11} y={0} width={22} height={7} rx={1} fill="#374151" />
          <circle cx={7} cy={3.5} r={1.4} fill={i === 0 ? '#22c55e' : '#60a5fa'} />
          <rect x={-8} y={2.5} width={10} height={2} fill="#6b7280" />
        </g>
      ))}
    </g>
  ),
  ipphone: (
    <g>
      <path d="M-20,-10 L14,-14 L18,12 L-16,14 Z" fill="#1f2937" />
      <rect x={-6} y={-10} width={18} height={10} fill="#a7f3d0" transform="rotate(-6)" />
      <path d="M-22,-12 C-26,-4 -26,6 -20,12 L-15,11 C-19,5 -19,-3 -16,-9 Z" fill="#111827" />
      {[0, 1, 2].map((r) => [0, 1, 2].map((c) => <rect key={`${r}${c}`} x={-2 + c * 5} y={3 + r * 3.5} width={3.5} height={2.5} fill="#9ca3af" transform="rotate(-6)" />))}
    </g>
  ),
  accesspoint: (
    <g>
      <ellipse cx={0} cy={6} rx={20} ry={6} fill="#e5e7eb" stroke="#9ca3af" />
      <path d="M-20,6 L-20,1 A20,6 0 0 1 20,1 L20,6" fill="#f3f4f6" stroke="#9ca3af" />
      <circle cx={0} cy={2} r={2} fill="#22c55e" />
      <path d="M-10,-6 A12,12 0 0 1 10,-6" stroke="#0ea5e9" strokeWidth={2.5} fill="none" />
      <path d="M-15,-11 A19,19 0 0 1 15,-11" stroke="#0ea5e9" strokeWidth={2.5} fill="none" />
      <path d="M-5,-2 A6,6 0 0 1 5,-2" stroke="#0ea5e9" strokeWidth={2.5} fill="none" />
    </g>
  ),
  homerouter: (
    <g>
      <rect x={-20} y={-2} width={40} height={12} rx={3} fill="#111827" />
      <rect x={-17} y={10} width={4} height={3} fill="#374151" />
      <rect x={13} y={10} width={4} height={3} fill="#374151" />
      <line x1={-14} y1={-2} x2={-18} y2={-20} stroke="#111827" strokeWidth={3} strokeLinecap="round" />
      <line x1={0} y1={-2} x2={0} y2={-22} stroke="#111827" strokeWidth={3} strokeLinecap="round" />
      <line x1={14} y1={-2} x2={18} y2={-20} stroke="#111827" strokeWidth={3} strokeLinecap="round" />
      {[0, 1, 2, 3, 4].map((i) => (
        <circle key={i} cx={-12 + i * 6} cy={4} r={1.3} fill={i === 0 ? '#3b82f6' : '#22c55e'} />
      ))}
    </g>
  ),
  smartphone: (
    <g>
      <rect x={-9} y={-18} width={18} height={34} rx={3} fill="#111827" />
      <rect x={-7} y={-14} width={14} height={25} fill="#a5b4fc" />
      <circle cx={0} cy={13.5} r={1.4} fill="#6b7280" />
    </g>
  ),
  printer: (
    <g>
      <rect x={-12} y={-18} width={24} height={10} fill="#f8fafc" stroke="#94a3b8" />
      <rect x={-20} y={-8} width={40} height={16} rx={2} fill="#475569" />
      <rect x={-12} y={4} width={24} height={12} fill="#f8fafc" stroke="#94a3b8" />
      <circle cx={14} cy={-3} r={1.5} fill="#22c55e" />
    </g>
  ),
  hub: <rect x={-20} y={-6} width={40} height={12} fill="#78716c" />,
};

export function kindColor(kind: DeviceKind) {
  switch (kind) {
    case 'router':
      return '#3b82f6';
    case 'switch':
      return '#0ea5e9';
    case 'l3switch':
      return '#6366f1';
    case 'accesspoint':
    case 'homerouter':
      return '#14b8a6';
    case 'ipphone':
      return '#ec4899';
    case 'server':
      return '#f59e0b';
    default:
      return '#64748b';
  }
}
