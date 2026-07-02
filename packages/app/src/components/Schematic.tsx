import type { RocketSpec, StaticInfo } from '@online-openrocket/engine';

/**
 * 2D side-view schematic (SVG) with CP/CG markers using standard rocketry
 * symbols: CG = circle with alternating quadrants, CP = red dot-circle.
 * All engine values are SI meters; this view scales to fit.
 */
export function Schematic({ spec, info }: { spec: RocketSpec; info: StaticInfo | null }) {
  const noseLen = spec.noseCone.length;
  const bodyLen = spec.bodyTube.length;
  const radius = spec.bodyTube.outerRadius;
  const finRoot = spec.fins.rootChord;
  const finTip = spec.fins.tipChord;
  const finSweep = spec.fins.sweep;
  const finHeight = spec.fins.height;
  const totalLen = noseLen + bodyLen;

  // Fit into a 640x200 viewBox with padding; x scale = y scale.
  const pad = 24;
  const w = 640;
  const h = 200;
  const scale = Math.min((w - 2 * pad) / totalLen, (h - 2 * pad) / (2 * (radius + finHeight)));
  const cx = (x: number) => pad + x * scale;
  const cy = h / 2;

  const r = radius * scale;
  const noseW = noseLen * scale;
  const bodyW = bodyLen * scale;

  // Ogive-ish nose profile via quadratic curves.
  const nosePath = `M ${cx(0)} ${cy}
    Q ${cx(0) + noseW * 0.15} ${cy - r * 0.9} ${cx(0) + noseW} ${cy - r}
    L ${cx(0) + noseW} ${cy + r}
    Q ${cx(0) + noseW * 0.15} ${cy + r * 0.9} ${cx(0)} ${cy} Z`;

  // Fin polygon (root at aft end of body tube).
  const finRootStartX = cx(totalLen - finRoot);
  const finPts = (dir: 1 | -1) =>
    [
      [finRootStartX, cy + dir * r],
      [finRootStartX + finSweep * scale, cy + dir * (r + finHeight * scale)],
      [finRootStartX + (finSweep + finTip) * scale, cy + dir * (r + finHeight * scale)],
      [cx(totalLen), cy + dir * r],
    ]
      .map((p) => p.join(','))
      .join(' ');

  const cgX = info ? cx(info.cg) : null;
  const cpX = info ? cx(info.cp) : null;
  const markerR = 9;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img" aria-label="Rocket side view with center of gravity and center of pressure markers">
      {/* fins behind body */}
      <polygon points={finPts(1)} fill="#b9b7b0" stroke="#7a786f" strokeWidth="1" />
      <polygon points={finPts(-1)} fill="#b9b7b0" stroke="#7a786f" strokeWidth="1" />
      {/* body */}
      <rect x={cx(noseLen)} y={cy - r} width={bodyW} height={2 * r}
          fill="#e7e5e0" stroke="#7a786f" strokeWidth="1" />
      {/* nose */}
      <path d={nosePath} fill="#d5d2cb" stroke="#7a786f" strokeWidth="1" />

      {info && cgX !== null && (
        <g>
          {/* CG: circle with alternating quadrants (mass symbol) */}
          <circle cx={cgX} cy={cy} r={markerR} fill="#fff" stroke="#0b0b0b" strokeWidth="1.5" />
          <path d={`M ${cgX} ${cy} L ${cgX + markerR} ${cy} A ${markerR} ${markerR} 0 0 1 ${cgX} ${cy + markerR} Z`} fill="#0b0b0b" />
          <path d={`M ${cgX} ${cy} L ${cgX - markerR} ${cy} A ${markerR} ${markerR} 0 0 1 ${cgX} ${cy - markerR} Z`} fill="#0b0b0b" />
          <text x={cgX} y={cy - markerR - 6} textAnchor="middle" fontSize="11" fill="#0b0b0b">CG</text>
        </g>
      )}
      {info && cpX !== null && (
        <g>
          {/* CP: red ringed dot */}
          <circle cx={cpX} cy={cy} r={markerR} fill="none" stroke="#e34948" strokeWidth="2" />
          <circle cx={cpX} cy={cy} r={3.5} fill="#e34948" />
          <text x={cpX} y={cy + markerR + 15} textAnchor="middle" fontSize="11" fill="#e34948">CP</text>
        </g>
      )}
    </svg>
  );
}
