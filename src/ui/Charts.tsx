// Oddiy SVG grafiklar (yuklama monitoringi uchun).

export interface Series {
  label: string;
  color: string;
  values: number[];
}

export function LineChart({ series, max, height = 110, unit = '', width = 420, title }: { series: Series[]; max?: number; height?: number; unit?: string; width?: number; title?: string }) {
  const n = Math.max(2, ...series.map((s) => s.values.length));
  const m = max ?? Math.max(1, ...series.flatMap((s) => s.values)) * 1.15;
  const pad = { l: 38, r: 8, t: 16, b: 16 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const x = (i: number, len: number) => pad.l + (w * (i + (n - len))) / (n - 1);
  const y = (v: number) => pad.t + h - (Math.min(v, m) / m) * h;
  const ticks = [0, m / 2, m];
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="chart" role="img" aria-label={title}>
      {title && (
        <text x={pad.l} y={11} className="chart-title">
          {title}
        </text>
      )}
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="chart-grid" />
          <text x={pad.l - 4} y={y(t) + 3} className="chart-axis" textAnchor="end">
            {t >= 100 ? Math.round(t) : t.toFixed(t < 10 ? 1 : 0)}
            {unit}
          </text>
        </g>
      ))}
      {series.map((s) => {
        if (s.values.length < 2) return null;
        const pts = s.values.map((v, i) => `${x(i, s.values.length)},${y(v)}`).join(' ');
        return <polyline key={s.label} points={pts} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />;
      })}
      <g transform={`translate(${width - pad.r},11)`}>
        {series.map((s, i) => (
          <text key={s.label} x={0} y={0} dx={-i * 0} dy={0} textAnchor="end" className="chart-legend" fill={s.color} transform={`translate(${-i * 90},0)`}>
            ● {s.label}: {s.values.length ? s.values[s.values.length - 1].toFixed(s.values[s.values.length - 1] < 10 ? 1 : 0) : '-'}
            {unit}
          </text>
        ))}
      </g>
    </svg>
  );
}

export function Meter({ value, label, color }: { value: number; label: string; color: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="meter">
      <div className="meter-label">
        <span>{label}</span>
        <b>{v.toFixed(0)}%</b>
      </div>
      <div className="meter-bar">
        <div style={{ width: `${v}%`, background: v > 90 ? '#ef4444' : v > 70 ? '#f59e0b' : color }} />
      </div>
    </div>
  );
}
