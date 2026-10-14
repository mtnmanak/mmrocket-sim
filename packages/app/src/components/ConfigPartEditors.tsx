import { useId, useMemo, useRef, useState } from 'react';
import type { ComponentNode } from '@online-openrocket/engine';
import type { DeploymentTuple, FlightOverrides, FlightTree, SeparationTuple } from '../model/design.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { siToUi, uiToSi } from '../prefs/units.js';
import { deploymentTuple } from '../services/foreignConfigLayers.js';
import { describeFlownDeployment, describeFlownSeparation, overrideFliesDifferently } from '../services/flightOverrideSummary.js';
import { Note } from './Note.js';
import { overrideFor } from '../services/flightState.js';
import { separationTuple, type ComponentFlightTuple } from '../services/flightOverrideText.js';
import { hasParallelStage, stages } from '../tree/treeModel.js';
import { DEPLOY_EVENTS, SEPARATION_EVENTS } from '../tree/schema.js';
import { flownDeployEvent } from '../tree/deployEvent.js';
import { configurationParts } from './ConfigOverview.js';
import { NumField } from './NumField.js';

/** Which layer a configuration-tab editor writes (CFG-SPEC A2/A3). */
export type FlightEditScope = 'own' | 'override';
export type PartFamily = 'recovery' | 'separation';

/** Desktop OR's wording for the own-setting scope; shared by the part rows and the motor cards. */
export const OWN_SCOPE_TEXT = "Change the part's own setting — every configuration that uses it";

/** The override scope's wording, or null when no configuration or working set owns overrides. */
export function overrideScopeText(configLabel: string | null, detached: boolean): string | null {
  return configLabel !== null ? `Override for “${configLabel}” only` : detached ? 'Override in the working settings only' : null;
}

/** The scope an editor opens in: the override only when the active owner already overrides it. */
export function defaultFlightScope(scopeAvailable: boolean, overridden: boolean): FlightEditScope {
  return scopeAvailable && overridden ? 'override' : 'own';
}

/** A labelled pair of radios; only rendered while an override owner exists. */
export function FlightScopeChoice({ scope, overrideLabel, onChange, legend = 'Apply changes to' }: {
  scope: FlightEditScope; overrideLabel: string; onChange: (scope: FlightEditScope) => void; legend?: string;
}) {
  const name = useId();
  return <fieldset className="flight-scope">
    <legend>{legend}</legend>
    <label><input type="radio" name={name} checked={scope === 'own'} onChange={() => onChange('own')} />{' '}{OWN_SCOPE_TEXT}</label>
    <label><input type="radio" name={name} checked={scope === 'override'} onChange={() => onChange('override')} />{' '}{overrideLabel}</label>
  </fieldset>;
}

interface EditorHandlers {
  /** `patch` names only the field that changed; `tuple` is the whole edited tuple. */
  onEdit: (node: ComponentNode, scope: FlightEditScope, tuple: ComponentFlightTuple,
    patch: Partial<ComponentFlightTuple>, numeric: boolean) => void;
  onEditStart: () => void;
  onEditEnd: (node: ComponentNode, scope: FlightEditScope, tuple: ComponentFlightTuple) => void;
  onEditCancel: () => void;
  onReset: (node: ComponentNode) => void;
  onEverywhere: (node: ComponentNode) => void;
}

/** Stage names for "(in <stage>)": every part's nearest enclosing stage or strap-on set. */
function enclosingStages(tree: FlightTree): Map<string, string> {
  const names = new Map<string, string>();
  const visit = (nodes: ComponentNode[], stage: string | null) => {
    for (const node of nodes) {
      const own = node.type === 'stage' || node.type === 'parallelstage' ? node.name || (node.type === 'stage' ? 'Stage' : 'Strap-on') : stage;
      if (node.id && stage !== null) names.set(node.id, stage);
      visit(node.children ?? [], own);
    }
  };
  visit(tree.components, null);
  return names;
}

/**
 * CFG-SPEC A2: one row per recovery device and per stage whose separation flies
 * (never the top axial stage), each with its own setting, what the active owner
 * flies, and an inline scoped editor. Rows keep the `cfg-part-<id>` destinations.
 */
export function ConfigPartEditors({ tree, overrides, ownerKey, configLabel, detached, onResetAll, ...handlers }: EditorHandlers & {
  tree: FlightTree; overrides: FlightOverrides;
  /** Changes whenever the owner of the overrides changes, so open editors and scope choices reset. */
  ownerKey: string;
  configLabel: string | null; detached: boolean;
  onResetAll: (family: PartFamily, ids: string[]) => void;
}) {
  const parts = useMemo(() => configurationParts(tree), [tree]);
  const stageNames = useMemo(() => enclosingStages(tree), [tree]);
  const multiStage = stages(tree).length > 1 || hasParallelStage(tree);
  const overrideLabel = overrideScopeText(configLabel, detached);
  const headings = useRef(new Map<PartFamily, HTMLHeadingElement>());
  const where = configLabel !== null ? 'in this configuration' : 'in the working settings';
  return <>{(['recovery', 'separation'] as const).map(family => {
    const rows = parts.filter(p => p.family === family).map(p => p.node);
    if (rows.length === 0) return null;
    const map: Readonly<Record<string, DeploymentTuple | SeparationTuple>> | undefined =
      family === 'recovery' ? overrides.deployments : overrides.separations;
    const overridden = rows.filter(node => overrideFor(map, node.id!));
    const title = family === 'recovery' ? 'Recovery' : 'Stages';
    return <section key={family} className="config-part-section" aria-label={title}>
      {/* Focusable by script only: a section reset removes its own button, and
          keyboard focus lands here rather than on the page (review of CFG-2). */}
      <h3 tabIndex={-1} ref={el => { if (el) headings.current.set(family, el); else headings.current.delete(family); }}>{title}</h3>
      {rows.map(node => <PartRow key={`${node.id!}:${ownerKey}`} node={node} family={family}
        stageName={multiStage && family === 'recovery' ? stageNames.get(node.id!) ?? null : null}
        override={overrideFor(map, node.id!)} configLabel={configLabel} overrideLabel={overrideLabel} {...handlers} />)}
      {overrideLabel !== null && overridden.length > 0 && <button type="button" className="file-btn"
        onClick={() => {
          onResetAll(family, overridden.map(node => node.id!));
          headings.current.get(family)?.focus();
        }}>
        {`Reset all ${family === 'recovery' ? 'recovery' : 'stage'} overrides ${where}`}
      </button>}
    </section>;
  })}</>;
}

function PartRow({ node, family, stageName, override, configLabel, overrideLabel,
  onEdit, onEditStart, onEditEnd, onEditCancel, onReset, onEverywhere }: EditorHandlers & {
  node: ComponentNode; family: PartFamily; stageName: string | null;
  override: DeploymentTuple | SeparationTuple | undefined;
  configLabel: string | null; overrideLabel: string | null;
}) {
  const { prefs } = usePrefs();
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const [chosen, setScope] = useState<FlightEditScope>(() => defaultFlightScope(overrideLabel !== null, !!override));
  // Without an override owner there is nothing but the own setting to edit.
  const scope: FlightEditScope = overrideLabel === null ? 'own' : chosen;
  const unit = prefs.units.altitude;
  const recovery = family === 'recovery';
  const own: ComponentFlightTuple = recovery ? deploymentTuple(node) : separationTuple(node);
  const describe = (t: ComponentFlightTuple) => 'deployEvent' in t ? describeFlownDeployment(t, unit) : describeFlownSeparation(t, unit);
  const name = node.name || (recovery ? node.type : 'Stage');
  const shown: ComponentFlightTuple = scope === 'override' && override ? override : own;
  const values = 'deployEvent' in shown
    ? { event: shown.deployEvent, altitude: shown.deployAltitude, delay: shown.deployDelay }
    : { event: shown.separationEvent, altitude: shown.separationAltitude, delay: shown.separationDelay };
  const options = recovery ? DEPLOY_EVENTS : SEPARATION_EVENTS;
  // The event the kernel flies (RECOV-CASE): a hand-edited "Altitude" names no
  // option as written, and the menu would show something it does not fly.
  const eventShown = recovery ? flownDeployEvent(values.event) : values.event;
  const keys = recovery
    ? { event: 'deployEvent', altitude: 'deployAltitude', delay: 'deployDelay' } as const
    : { event: 'separationEvent', altitude: 'separationAltitude', delay: 'separationDelay' } as const;
  const edit = (field: 'event' | 'altitude' | 'delay', value: string | number, numeric = false) => {
    const patch = { [keys[field]]: value } as Partial<ComponentFlightTuple>;
    onEdit(node, scope, { ...shown, ...patch } as ComponentFlightTuple, patch, numeric);
  };
  // "This configuration" only names one that exists (review of CFG-2).
  const owner = configLabel !== null ? 'This configuration' : 'The working settings';
  const ownerIn = configLabel !== null ? 'in this configuration' : 'in the working settings';
  const differs = !!override && overrideFliesDifferently(own, override);
  const verb = recovery ? 'deploy' : 'separation';
  return <div id={`cfg-part-${node.id!}`} tabIndex={-1} className="config-part-row" role="group" aria-labelledby={`${uid}-name`}>
    <strong id={`${uid}-name`}>{name}{stageName && ` (in ${stageName})`}</strong>
    {/* D7 I10: say beside each setting whether it is the one that flies. An
        override that flies differently is Caution; one that flies the same as
        the own setting is explained quietly (the retired banner's rule). */}
    <p className="comp-stats">Own setting: {describe(own)}{differs && ` — not flown ${ownerIn}`}</p>
    {override
      ? <Note as="p" tier={differs ? 'caution' : 'information'} className="comp-stats">
        {owner}: <strong>overridden</strong> — {describe(override)}{!differs && ' (flies the same as the own setting)'}
      </Note>
      : <p className="comp-stats">{owner}: uses own setting</p>}
    <div className="config-part-actions">
      <button ref={editButton} type="button" className="file-btn" aria-expanded={editing} aria-controls={`${uid}-editor`}
        aria-describedby={`${uid}-name`}
        onClick={() => {
          if (!editing) setScope(defaultFlightScope(overrideLabel !== null, !!override));
          setEditing(!editing);
        }}>Edit…</button>
      {override && <button type="button" className="file-btn" aria-describedby={`${uid}-name`}
        onClick={() => {
          onReset(node);
          // The Reset button goes with the override; keyboard focus stays in the row.
          editButton.current?.focus();
        }}>Reset to own setting</button>}
    </div>
    {editing && <div id={`${uid}-editor`} className="config-part-editor">
      {overrideLabel !== null
        ? <FlightScopeChoice scope={scope} overrideLabel={overrideLabel} onChange={setScope} />
        : <p className="comp-stats">Changes the part's own setting — no configuration is active, so every flight uses it.</p>}
      <div className="field-grid">
        <div className="field">
          <label htmlFor={`${uid}-event`}>{recovery ? 'Deploy at' : 'Separate at'}</label>
          <select id={`${uid}-event`} value={eventShown} onChange={e => edit('event', e.target.value)}>
            {!options.some(([value]) => value === eventShown) && <option value={eventShown}>{eventShown}</option>}
            {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-altitude`}>{recovery ? 'Deploy' : 'Separation'} altitude ({unit})</label>
          <NumField id={`${uid}-altitude`} ariaLabel={`${name} ${verb} altitude (${unit})`}
            onEditStart={onEditStart} onEditEnd={() => onEditEnd(node, scope, shown)} onEditCancel={onEditCancel}
            value={siToUi('altitude', unit, values.altitude)}
            validate={v => Number.isFinite(uiToSi('altitude', unit, v))}
            onCommit={(v, typing) => { if (v !== null) edit('altitude', uiToSi('altitude', unit, v), typing); }} />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-delay`}>{recovery ? 'Deploy' : 'Separation'} delay (s)</label>
          <NumField id={`${uid}-delay`} ariaLabel={`${name} ${verb} delay (s)`} value={values.delay} step={0.5}
            onEditStart={onEditStart} onEditEnd={() => onEditEnd(node, scope, shown)} onEditCancel={onEditCancel}
            onCommit={(v, typing) => { if (v !== null) edit('delay', v, typing); }} />
        </div>
      </div>
      {override && <button type="button" className="file-btn" onClick={() => onEverywhere(node)}>Use the override everywhere</button>}
    </div>}
  </div>;
}
