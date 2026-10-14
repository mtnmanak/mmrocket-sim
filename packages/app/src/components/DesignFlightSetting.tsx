import { GlossaryHelp } from './GlossaryHelp.js';
import { fieldTerm } from '../tree/glossaryTerms.js';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { DeploymentTuple, FlightOverrides, SeparationTuple } from '../model/design.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtFieldValue, siToUi } from '../prefs/units.js';
import { deploymentTuple } from '../services/foreignConfigLayers.js';
import { describeFlownDeployment, describeFlownSeparation, overrideFliesDifferently } from '../services/flightOverrideSummary.js';
import { Note } from './Note.js';
import { overrideFor } from '../services/flightState.js';
import { separationTuple } from '../services/flightOverrideText.js';
import { stages } from '../tree/treeModel.js';
import { numOrNull } from '../tree/nodeNum.js';

/** The tab every flight setting below is edited on (CFG-SPEC D1/D2a). */
export const CONFIG_TAB_LINK = 'Set on Motors & Configuration ▸';

/**
 * What the Design tab needs to show a part's flight settings read-only
 * (CFG-SPEC B1, ruling D2a). Absent in isolated panel tests: the own setting is
 * still shown, with no override line and no link.
 */
export interface DesignFlightContext {
  overrides: FlightOverrides;
  /** The active configuration's label, or null with none active. */
  configLabel: string | null;
  /** The detached working settings own the overrides (no configuration is active). */
  detached: boolean;
  /** Switches to Motors & Configuration and focuses that part's row. */
  onOpenPart?: (nodeId: string) => void;
  /** Switches to Motors & Configuration and focuses that stage's nozzle exit field. */
  onOpenNozzle?: (stageId: string) => void;
  /** Stages whose nozzle exit field Motors & Configuration shows (`nozzleEditableStageIds`). */
  nozzleEditable?: ReadonlySet<string>;
}

/**
 * Deployment (parachute, streamer) or separation (stage, strap-on set), shown
 * read-only on Design: the part's own setting, what the active owner flies when
 * it overrides it, and a link to the one place both are edited. The wording is
 * the configuration rows' own (`describeFlownDeployment` / `describeFlownSeparation`).
 */
export function DesignFlightSetting({ tree, node, context }: {
  tree: RocketTree; node: ComponentNode; context?: DesignFlightContext;
}) {
  const { prefs } = usePrefs();
  const unit = prefs.units.altitude;
  const recovery = node.type === 'parachute' || node.type === 'streamer';
  const heading = recovery ? 'Deployment' : 'Separation';
  const top = stages(tree)[0];
  if (!recovery && node.type === 'stage' && top !== undefined && top.id === node.id) {
    return <div className="design-flight-setting" role="group" aria-label={heading}>
      <h3 className="field-label-help">{heading} <GlossaryHelp term={fieldTerm(node.type, 'separationEvent')} label={heading} /></h3>
      <p className="comp-stats">The top stage never separates, so it has no separation setting to fly.</p>
    </div>;
  }
  const ownTuple = recovery ? deploymentTuple(node) : separationTuple(node);
  const own = 'deployEvent' in ownTuple ? describeFlownDeployment(ownTuple, unit) : describeFlownSeparation(ownTuple, unit);
  const override: DeploymentTuple | SeparationTuple | undefined = !node.id ? undefined : recovery
    ? overrideFor(context?.overrides.deployments, node.id) : overrideFor(context?.overrides.separations, node.id);
  const flown = override === undefined ? null : 'deployEvent' in override
    ? describeFlownDeployment(override, unit) : describeFlownSeparation(override, unit);
  const differs = override !== undefined && overrideFliesDifferently(ownTuple, override);
  const owner = context?.configLabel != null ? `In “${context.configLabel}”` : context?.detached ? 'In the working settings' : null;
  const open = context?.onOpenPart;
  return <div className="design-flight-setting" role="group" aria-label={heading}>
    <div className="design-flight-head">
      <h3>{heading}</h3>
      {open && node.id && <button type="button" className="file-btn"
        aria-label={`${heading}: set on Motors & Configuration`}
        onClick={() => open(node.id!)}>{CONFIG_TAB_LINK}</button>}
      <GlossaryHelp term={fieldTerm(node.type, recovery ? 'deployEvent' : 'separationEvent')} label={heading} />
    </div>
    {/* D7 I10: the effective value beside each setting. An override that
        flies differently is Caution and the own setting says it is not flown;
        one that flies the same is explained quietly (the retired banner's rule). */}
    <p className="comp-stats">Own setting: {own}{differs && owner !== null && ` — not flown ${owner.replace(/^In/, 'in')}`}</p>
    {flown !== null && owner !== null && <Note as="p" tier={differs ? 'caution' : 'information'} className="comp-stats">
      {owner}: <strong>overridden</strong> — {flown}{!differs && ' (flies the same as the own setting)'}
    </Note>}
  </div>;
}

/**
 * A stage's nozzle exit diameter, read-only on Design (CFG-SPEC A4): it is
 * edited on Motors & Configuration beside the motor it belongs to.
 */
export function DesignNozzleSetting({ node, context }: { node: ComponentNode; context?: DesignFlightContext }) {
  const { prefs } = usePrefs();
  const unit = prefs.units.motorDimensions;
  // The same reading Motors & Configuration's field takes (App: numOrNull).
  const value = numOrNull(node, 'nozzleExitDiameter');
  const text = value === null ? 'automatic' : value === 0 ? 'off (0)' : `${fmtFieldValue(siToUi('motorDimensions', unit, value), prefs.fieldPrecision)} ${unit}`;
  const editable = !!node.id && !!context?.onOpenNozzle && (context.nozzleEditable?.has(node.id) ?? false);
  return <div className="design-flight-setting" role="group" aria-label="Nozzle exit">
    <p className="comp-stats">
      Nozzle exit: {text}
      {editable
        ? <>{' — '}<button type="button" className="file-btn" aria-label="Nozzle exit: edit on Motors & Configuration"
          onClick={() => context!.onOpenNozzle!(node.id!)}>edit on Motors &amp; Configuration ▸</button></>
        : context?.onOpenNozzle
          ? ' — edited on Motors & Configuration once this stage has a motor mount.'
          : ' — edited on Motors & Configuration.'}
      {' '}<GlossaryHelp term={fieldTerm(node.type, 'nozzleExitDiameter')} label="Nozzle exit" />
    </p>
  </div>;
}
