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
 *
 * ⟳90° (nose-up) mode gets the same control laid out HORIZONTALLY along the
 * bottom of the canvas (owner's call, 2026-08-30). The slider tracks the axis
 * the rocket is NOT drawn along, so in a nose-up view it belongs across the
 * bottom rather than beside the airframe — and the control has to be present
 * at all, because from v0.084 a rolled view changes the whole drawing
 * convention and a wireframe with no visible slider is unexplained.
 */
export const ROLL_COL = 26;
/** Height (px) the horizontal bar takes off the ⟳90° drawing's length axis. */
export const ROLL_BAR = 30;

export function RollControl({ roll, onRoll, top = 0, orientation = 'vertical' }: {
  /** Radians. */
  roll: number;
  onRoll: (rad: number) => void;
  /** First free y (px) — the horizontal ruler's gutter, where there is one. */
  top?: number;
  /** 'horizontal' lays the control across the bottom, for the ⟳90° view. */
  orientation?: 'vertical' | 'horizontal';
}) {
  const deg = Math.round((roll * 180) / Math.PI);
  const horizontal = orientation === 'horizontal';
  return (
    <div className={`roll-control${horizontal ? ' roll-horizontal' : ''}`}
      style={horizontal ? { height: ROLL_BAR } : { top, width: ROLL_COL }}>
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
