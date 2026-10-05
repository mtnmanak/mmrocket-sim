import { useEffect, useId, useRef, useState } from 'react';
import { savedConfigLabel, type SavedConfig } from '../model/design.js';
import { MAX_CONFIG_NAME_LENGTH, MAX_ORK_CONFIGURATIONS } from '../services/configSnapshot.js';
import type { RocketTree } from '@online-openrocket/engine';
import { usePrefs } from '../prefs/PrefsContext.js';
import { recoverySummary } from './recoveryContext.js';

/**
 * Imported and app-created configurations as one-click motor sets.
 * The panel is the last, full-width row of the
 * Motors & Launch grid, below the Motors and Launch panels — it used to sit
 * above them, where a file with several configurations pushed the two panels
 * a flyer actually works in below the fold.
 *
 * Whatever the user applies stays loaded until they change or unload it —
 * manual motor edits keep the active mark (the working set is that
 * configuration's current truth, and saving writes it back). Renders nothing
 * only when there are neither configurations nor loaded motors.
 */
export function ConfigPanel({ configs, activeConfigId, hasMotors, tree, onApply, onClear,
  onCreate, onRename, onDelete, onEmpty }: {
  configs: SavedConfig[];
  tree?: RocketTree;
  activeConfigId: string | null;
  /** Whether the working set holds any motor — decides the "None" row's active mark. */
  hasMotors: boolean;
  onApply: (cfg: SavedConfig) => void;
  onClear: () => void;
  onCreate: () => string | null;
  onRename: (id: string, name: string) => void;
  onDelete: (config: SavedConfig) => void;
  /** Focus a stable target outside the panel before its last empty row disappears. */
  onEmpty: () => void;
}) {
  const { prefs } = usePrefs();
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [previousConfigs, setPreviousConfigs] = useState(configs);
  const renameButtons = useRef(new Map<string, HTMLButtonElement>());
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
  const applyButtons = useRef(new Map<string, HTMLButtonElement>());
  const createButton = useRef<HTMLButtonElement>(null);
  if (configs !== previousConfigs) {
    setPreviousConfigs(configs);
    // Reopening a file can reuse IDs. Pending actions belong to the old objects.
    // A just-created editor has no previous object yet and must stay open.
    const replaced = (id: string) => {
      const before = previousConfigs.find(c => c.id === id);
      const current = configs.find(c => c.id === id);
      return !current || (before !== undefined && before !== current);
    };
    if (editing && replaced(editing)) setEditing(null);
    if (deleting && replaced(deleting)) setDeleting(null);
  }
  if (configs.length === 0 && !hasMotors) return null;
  const createDisabled = !hasMotors || configs.length >= MAX_ORK_CONFIGURATIONS;
  // The divider is a STYLESHEET rule (.config-list > .config-row + .config-row),
  // not an inline style: as an inline border it outranked every author rule,
  // so the "no rule above the first row" suppression could not win against it.
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
      {configs.length > 0 && <div className="config-list" role="group" aria-label="Flight configurations" tabIndex={0}>
        {configs.map((c, index) => {
          const labels = Object.values(c.motors).map((m) => m.label);
          const isActive = c.id === activeConfigId;
          const label = `${savedConfigLabel(c)} — configuration ${index + 1}`;
          const recovery = configs.length > 1 ? recoverySummary(c, prefs.units.distance, tree, isActive) : '';
          return (
            <div key={c.id} className="config-row"
              aria-current={isActive ? 'true' : undefined}>
              <button className="file-btn" style={btnStyle} onClick={() => onApply(c)}
                ref={(el) => { if (el) applyButtons.current.set(c.id, el); else applyButtons.current.delete(c.id); }}
                aria-label={`Apply ${savedConfigLabel(c)}${recovery ? ` — configuration ${index + 1}; Recovery: ${recovery}` : ''}`}
                title={isActive
                  ? 'Reload this configuration — your motor and recovery edits and weighed pad mass are kept'
                  : "Load this configuration's motors, ignition and recovery settings"}>
                Apply
              </button>
              <span className="config-details">
                {editing === c.id ? <ConfigNameEditor config={c} label={label} onCommit={(name) => onRename(c.id, name)}
                  onClose={(restoreFocus) => {
                    setEditing(null); if (restoreFocus) renameButtons.current.get(c.id)?.focus();
                  }} />
                  : <span className="config-name" style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{savedConfigLabel(c)}</span>}
                {c.isDefault && (
                  <span className="config-default motor-db-meta" style={{ marginLeft: 6 }}>
                    file default
                  </span>
                )}
                <span className="config-motors comp-stats" style={{ display: 'block', margin: 0 }}>
                  {labels.length > 0 ? labels.join(', ') : 'no motors'}
                </span>
                {recovery && <span className="comp-stats" style={{ display: 'block', margin: 0 }}>Recovery: {recovery}</span>}
              </span>
              {isActive && (
                <span className="config-active-tag"
                  title="This configuration is loaded — your motor and recovery edits update it when you save">
                  ▶ active
                </span>
              )}
              <button className="file-btn" aria-label={`Rename ${label}`}
                title={`Rename ${savedConfigLabel(c)}`} ref={(el) => {
                  if (el) renameButtons.current.set(c.id, el); else renameButtons.current.delete(c.id);
                }} onClick={() => { setDeleting(null); setEditing(c.id); }}>✎</button>
              <button className="file-btn" aria-label={`Delete ${label}`}
                title={`Delete ${savedConfigLabel(c)}`} ref={(el) => {
                  if (el) deleteButtons.current.set(c.id, el); else deleteButtons.current.delete(c.id);
                }} onClick={() => { setEditing(null); setDeleting(c.id); }}>🗑</button>
              {deleting === c.id && <ConfigDeleteConfirmation label={label}
                onCancel={() => { setDeleting(null); deleteButtons.current.get(c.id)?.focus(); }}
                onDelete={() => {
                  setDeleting(null); onDelete(c);
                  const next = configs[index + 1] ?? configs[index - 1];
                  if (next) applyButtons.current.get(next.id)?.focus();
                  else if (hasMotors) createButton.current?.focus();
                  else onEmpty();
                }} />}
            </div>
          );
        })}
        <div className="config-row config-row-none"
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
      </div>}
      <button className="file-btn" ref={createButton} disabled={createDisabled}
        title={!hasMotors ? 'Load a motor before creating a configuration.'
          : configs.length >= MAX_ORK_CONFIGURATIONS ? `The ${MAX_ORK_CONFIGURATIONS}-configuration limit has been reached.`
            : 'Keep the loaded motors and flight settings as a new configuration; the previous configuration keeps its stored settings.'}
        onClick={() => {
          const id = onCreate();
          if (id) { setDeleting(null); setEditing(id); }
        }}>+ New configuration from loaded motors</button>
      {configs.length === 0 && <p className="comp-stats">Keep this motor set and its flight settings for later.</p>}
    </div>
  );
}

function ConfigNameEditor({ config, label, onCommit, onClose }: {
  config: SavedConfig; label: string; onCommit: (name: string) => void; onClose: (restoreFocus: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const finish = (commit: boolean, restoreFocus: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const value = input.current?.value ?? '';
    if (commit && value !== (config.name ?? '')
      && (value.trim().slice(0, MAX_CONFIG_NAME_LENGTH) || null) !== config.name) onCommit(value);
    onClose(restoreFocus);
  };
  return <input ref={input} defaultValue={config.name ?? ''} maxLength={MAX_CONFIG_NAME_LENGTH}
    style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }}
    aria-label={`Rename ${label}`} title={`Up to ${MAX_CONFIG_NAME_LENGTH} characters; leave blank to label by motor set.`}
    onBlur={() => finish(true, false)} onKeyDown={(e) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); finish(e.key === 'Enter', true);
      }
    }} />;
}

function ConfigDeleteConfirmation({ label, onCancel, onDelete }: {
  label: string; onCancel: () => void; onDelete: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  useEffect(() => { cancel.current?.focus(); }, []);
  return <div role="group" aria-label={`Delete ${label}?`} aria-describedby={descriptionId} tabIndex={-1}
    style={{ flexBasis: '100%' }} onKeyDown={(e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
    }}>
    <p id={descriptionId}>Delete this configuration? Its motors stay loaded if it is the one you are flying.</p>
    <button className="file-btn file-btn-danger" aria-label={`Confirm delete ${label}`} onClick={onDelete}>Delete</button>{' '}
    <button className="file-btn" aria-label={`Cancel deleting ${label}`} ref={cancel} onClick={onCancel}>Cancel</button>
  </div>;
}
