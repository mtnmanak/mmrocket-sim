import { useEffect, useId, useRef, useState } from 'react';
import { savedConfigLabel, type SavedConfig, type FlightTree, type FlightOverrides, type MountMotor } from '../model/design.js';
import { MAX_CONFIG_NAME_LENGTH, MAX_ORK_CONFIGURATIONS } from '../services/configSnapshot.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { activeFlightOverrides } from '../services/flightState.js';
import { describeFlightOverrides } from '../services/flightOverrideSummary.js';
import type { OrkMotorRef } from '../services/orkFile.js';

const NO_OVERRIDES: FlightOverrides = {};

/** The active flight owns the controls below this bar. Native select is deliberate. */
export function ConfigPanel({ configs, activeConfigId, hasMotors, tree, motors, unmatchedRefs, detachedOverrides = NO_OVERRIDES,
  onApply, onClear, onCreate, onDuplicate, onRename, onDelete, onResetOverrides }: {
  configs: SavedConfig[];
  tree?: FlightTree;
  motors?: Record<string, MountMotor>;
  unmatchedRefs?: Record<string, OrkMotorRef>;
  detachedOverrides?: FlightOverrides;
  activeConfigId: string | null;
  hasMotors: boolean;
  onApply: (cfg: SavedConfig) => void;
  onClear: () => void;
  onCreate: () => string | null;
  onDuplicate?: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (config: SavedConfig) => void;
  onResetOverrides?: () => void;
  onEmpty?: () => void;
}) {
  const { prefs } = usePrefs();
  const summaryId = useId();
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [previousConfigs, setPreviousConfigs] = useState(configs);
  const [previousOwner, setPreviousOwner] = useState(activeConfigId);
  const [previousDetached, setPreviousDetached] = useState(detachedOverrides);
  const chooser = useRef<HTMLSelectElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const resetButton = useRef<HTMLButtonElement>(null);
  if (configs !== previousConfigs) {
    setPreviousConfigs(configs);
    // Reopening a file can reuse IDs. Pending actions belong to the old objects.
    const replaced = (id: string) => {
      const before = previousConfigs.find(c => c.id === id);
      const current = configs.find(c => c.id === id);
      return !current || (before !== undefined && before !== current);
    };
    if (editing && replaced(editing)) setEditing(null);
    if (deleting && replaced(deleting)) setDeleting(null);
    if (resetting && activeConfigId && replaced(activeConfigId)) setResetting(false);
  }
  if (activeConfigId !== previousOwner || detachedOverrides !== previousDetached) {
    setPreviousOwner(activeConfigId);
    setPreviousDetached(detachedOverrides);
    if (resetting) setResetting(false);
  }
  const active = configs.find(c => c.id === activeConfigId);
  const overrides = activeFlightOverrides(configs, activeConfigId, detachedOverrides);
  const hasOverrides = Object.values(overrides).some(map => Object.keys(map ?? {}).length > 0);
  const working = !active && (hasMotors || Object.keys(unmatchedRefs ?? {}).length > 0 || hasOverrides);
  const summary = tree ? describeFlightOverrides(tree, overrides, motors ?? active?.motors ?? {},
    active ? savedConfigLabel(active) : null, prefs.units.distance) : null;
  const labelOf = (c: SavedConfig) => `${savedConfigLabel(c)} — configuration ${configs.indexOf(c) + 1}`;
  const editingConfig = configs.find(c => c.id === editing);
  const deletingConfig = configs.find(c => c.id === deleting);
  const atLimit = configs.length >= MAX_ORK_CONFIGURATIONS;
  return <section className="panel config-panel" aria-label="Flight configuration">
    <div className="config-bar" aria-current={active ? 'true' : undefined}>
      <label className="config-chooser">Flight configuration
        <select ref={chooser} aria-label="Flight configuration" value={active?.id ?? (working ? '__working__' : '')}
          aria-describedby={summaryId} onChange={e => {
            setEditing(null); setDeleting(null); setResetting(false);
            if (!e.target.value) onClear();
            else { const c = configs.find(row => row.id === e.target.value); if (c) onApply(c); }
          }}>
          {configs.map(c => <option key={c.id} value={c.id}>{savedConfigLabel(c)}{c.isDefault ? ' — file default' : ''}</option>)}
          {working && <option value="__working__" disabled>Working settings (not saved)</option>}
          <option value="">None (no motors)</option>
        </select>
      </label>
      <button className="file-btn" disabled={!hasMotors || atLimit}
        title={!hasMotors ? 'Load a motor before creating a configuration.' : atLimit
          ? `The ${MAX_ORK_CONFIGURATIONS}-configuration limit has been reached.`
          : 'Keep the loaded motors and flight settings as a new configuration; the previous configuration keeps its stored settings.'}
        onClick={() => { const id = onCreate(); if (id) { setDeleting(null); setEditing(id); } }}>
        + New from loaded motors
      </button>
      <button className="file-btn" disabled={!active || atLimit} onClick={onDuplicate}
        title={atLimit ? `The ${MAX_ORK_CONFIGURATIONS}-configuration limit has been reached.` : 'Copy the active configuration and its settings'}>Duplicate</button>
      <button className="file-btn" ref={renameButton} disabled={!active}
        aria-label={active ? `Rename ${labelOf(active)}` : 'Rename configuration'}
        onClick={() => { setDeleting(null); setEditing(active!.id); }}>Rename</button>
      <button className="file-btn" ref={deleteButton} disabled={!active}
        aria-label={active ? `Delete ${labelOf(active)}` : 'Delete configuration'}
        onClick={() => { setEditing(null); setDeleting(active!.id); }}>Delete</button>
      {editingConfig && <ConfigNameEditor key={editingConfig.id} config={editingConfig} label={labelOf(editingConfig)}
        onCommit={name => onRename(editingConfig.id, name)} onClose={restore => {
          setEditing(null); if (restore) (renameButton.current?.disabled ? chooser.current : renameButton.current)?.focus();
        }} />}
      {deletingConfig && <ConfigDeleteConfirmation label={labelOf(deletingConfig)}
        onCancel={() => { setDeleting(null); deleteButton.current?.focus(); }}
        onDelete={() => { setDeleting(null); onDelete(deletingConfig); chooser.current?.focus(); }} />}
    </div>
    {configs.length === 0 && <p className="comp-stats">No saved configurations — the loaded motors fly as a working set</p>}
    <p id={summaryId} className="comp-stats">{summary?.shortText ?? (active || working
      ? "Uses every part's own setting." : "No configuration: the parts' own settings, with no motors")}</p>
    {hasOverrides && <button ref={resetButton} className="file-btn" onClick={() => setResetting(true)}>
      Reset every override in this configuration
    </button>}
    {resetting && <ConfigResetConfirmation onCancel={() => { setResetting(false); resetButton.current?.focus(); }}
      onReset={() => { setResetting(false); onResetOverrides?.(); chooser.current?.focus(); }} />}
  </section>;
}

function ConfigResetConfirmation({ onCancel, onReset }: { onCancel: () => void; onReset: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  useEffect(() => { cancel.current?.focus(); }, []);
  return <div role="group" aria-label="Reset every override?" aria-describedby={descriptionId} onKeyDown={e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
  }}>
    <p id={descriptionId}>Reset recovery, stage separation and ignition to the parts' own settings in this configuration?</p>
    <button className="file-btn file-btn-danger" onClick={onReset}>Confirm reset every override</button>{' '}
    <button className="file-btn" ref={cancel} onClick={onCancel}>Cancel</button>
  </div>;
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
