import { savedConfigLabel, type SavedConfig } from '../App.js';

/**
 * Flight-configuration presets (Stage B): the imported file's configurations
 * as one-click motor sets. The panel is the last, full-width row of the
 * Motors & Launch grid, below the Motors and Launch panels — it used to sit
 * above them, where a file with several configurations pushed the two panels
 * a flyer actually works in below the fold.
 *
 * Whatever the user applies stays loaded until they change or unload it —
 * manual motor edits keep the active mark (the working set is that
 * configuration's current truth, and saving writes it back). Renders nothing
 * when the design carries no configurations.
 */
export function ConfigPanel({ configs, activeConfigId, hasMotors, onApply, onClear }: {
  configs: SavedConfig[];
  activeConfigId: string | null;
  /** Whether the working set holds any motor — decides the "None" row's active mark. */
  hasMotors: boolean;
  onApply: (cfg: SavedConfig) => void;
  onClear: () => void;
}) {
  if (configs.length === 0) return null;
  // The divider is a STYLESHEET rule (.config-list > .config-row + .config-row),
  // not an inline style: as an inline border it outranked every author rule,
  // so the "no rule above the first row" suppression could not win against it.
  const rowStyle = {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 0',
  } as const;
  // Apply leads the row (the owner, 2026-08-26): the buttons line up in a
  // column the eye and the pointer reach first, instead of hiding at the far
  // right past a variable-length motor list. Reordered in the JSX, never with
  // CSS `order` or `row-reverse` — tab order follows DOM order, and splitting
  // the two is the classic keyboard trap.
  //
  // It costs the screen-reader cue that used to come free from reading the
  // configuration's name immediately before its button, so every button now
  // carries an aria-label naming what it applies. Without that, a button list
  // reads "Apply" five times.
  const btnStyle = { flex: '0 0 auto' } as const;
  const noneActive = activeConfigId === null && !hasMotors;
  return (
    <div className="panel config-panel">
      <h2>Flight configurations</h2>
      {/* The heading stays put and the list scrolls inside itself — a 10-
          configuration file must not turn the last row of the tab into a
          wall. tabIndex makes the scroll region reachable by keyboard alone
          (one extra tab stop, deliberately accepted). */}
      <div className="config-list" role="group" aria-label="Flight configurations" tabIndex={0}>
        {configs.map((c) => {
          const labels = Object.values(c.motors).map((m) => m.label);
          const isActive = c.id === activeConfigId;
          return (
            <div key={c.id} className="config-row" style={rowStyle}
              aria-current={isActive ? 'true' : undefined}>
              <button className="file-btn" style={btnStyle} onClick={() => onApply(c)}
                aria-label={`Apply ${savedConfigLabel(c)}`}
                title={isActive
                  ? "Reload this configuration's saved motors (undoes manual motor edits)"
                  : "Load this configuration's motors and ignition settings"}>
                Apply
              </button>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="config-name" style={{ fontWeight: 600 }}>{savedConfigLabel(c)}</span>
                {c.isDefault && (
                  <span className="config-default motor-db-meta" style={{ marginLeft: 6 }}>
                    file default
                  </span>
                )}
                <span className="config-motors comp-stats" style={{ display: 'block', margin: 0 }}>
                  {labels.length > 0 ? labels.join(', ') : 'no motors'}
                </span>
              </span>
              {isActive && (
                <span className="config-active-tag"
                  title="This configuration is loaded — your motor edits update it when you save">
                  ▶ active
                </span>
              )}
            </div>
          );
        })}
        <div className="config-row config-row-none" style={rowStyle}
          aria-current={noneActive ? 'true' : undefined}>
          <button className="file-btn" style={btnStyle} onClick={onClear}
            aria-label="Apply None — unload every motor"
            title="Unload every motor — view and weigh the rocket clean">
            Apply
          </button>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="config-name" style={{ fontWeight: 600 }}>None</span>
            <span className="config-motors comp-stats" style={{ display: 'block', margin: 0 }}>
              no motors loaded
            </span>
          </span>
          {noneActive && <span className="config-active-tag">▶ active</span>}
        </div>
      </div>
    </div>
  );
}
