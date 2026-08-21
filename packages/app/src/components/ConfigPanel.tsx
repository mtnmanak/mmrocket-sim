import type { SavedConfig } from '../App.js';

/**
 * Flight-configuration presets (Stage B): the imported file's configurations
 * as one-click motor sets, listed above the Motors panel on Motors & Launch.
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
  const rowStyle = {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 0', borderTop: '1px solid var(--border, #333)',
  } as const;
  const noneActive = activeConfigId === null && !hasMotors;
  return (
    <div className="panel config-panel">
      <h2>Flight configurations</h2>
      {configs.map((c) => {
        const labels = Object.values(c.motors).map((m) => m.label);
        const isActive = c.id === activeConfigId;
        return (
          <div key={c.id} className="config-row" style={rowStyle}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="config-name" style={{ fontWeight: 600 }}>{c.name ?? c.id}</span>
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
            <button className="file-btn" onClick={() => onApply(c)}
              title={isActive
                ? "Reload this configuration's saved motors (undoes manual motor edits)"
                : "Load this configuration's motors and ignition settings"}>
              Apply
            </button>
          </div>
        );
      })}
      <div className="config-row config-row-none" style={rowStyle}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="config-name" style={{ fontWeight: 600 }}>None</span>
          <span className="config-motors comp-stats" style={{ display: 'block', margin: 0 }}>
            no motors loaded
          </span>
        </span>
        {noneActive && <span className="config-active-tag">▶ active</span>}
        <button className="file-btn" onClick={onClear}
          title="Unload every motor — view and weigh the rocket clean">
          Apply
        </button>
      </div>
    </div>
  );
}
