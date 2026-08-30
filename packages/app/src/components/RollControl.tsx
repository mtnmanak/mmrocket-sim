/**
 * The 2D views' roll slider — the desktop's rotation control, in the
 * desktop's place: a vertical slider down the far left of the drawing
 * (`RocketPanel` adds `rotationControl` before the figure holder, 24.12).
 *
 * It rolls the VIEW, not the design: nothing it does is saved with the
 * rocket, and zero means "the clock angles the design actually stores".
 * The desktop's range is 0…2π; this one is centred on zero so the design's
 * own angles sit at the middle of the travel, and the readout doubles as the
 * reset button.
 */
export const ROLL_COL = 26;

export function RollControl({ roll, onRoll, top = 0 }: {
  /** Radians. */
  roll: number;
  onRoll: (rad: number) => void;
  /** First free y (px) — the horizontal ruler's gutter, where there is one. */
  top?: number;
}) {
  const deg = Math.round((roll * 180) / Math.PI);
  return (
    <div className="roll-control" style={{ top, width: ROLL_COL }}>
      <input type="range" className="roll-slider"
        min={-180} max={180} step={1} value={deg}
        aria-label="Roll the view about the rocket's long axis"
        aria-valuetext={`${deg} degrees`}
        onChange={(e) => onRoll((Number(e.target.value) * Math.PI) / 180)}
        onDoubleClick={() => onRoll(0)} />
      <button className="roll-reset" type="button"
        title="Roll the view about the rocket's long axis — click to return to the design's own angles"
        onClick={() => onRoll(0)}>{deg}°</button>
    </div>
  );
}
