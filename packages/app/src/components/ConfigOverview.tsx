import { useMemo } from 'react';
import type { ComponentNode } from '@online-openrocket/engine';
import { savedConfigLabel, type FlightTree, type SavedConfig } from '../model/design.js';
import { motorMounts, stages } from '../tree/treeModel.js';
import { deploymentTuple } from '../services/foreignConfigLayers.js';
import { describeIgnitionTuple, separationTuple } from '../services/flightOverrideText.js';
import { describeFlownDeployment, describeFlownSeparation } from '../services/flightOverrideSummary.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { overrideFor } from '../services/flightState.js';

type Part = { node: ComponentNode; family: 'recovery' | 'separation' | 'ignition' };

export function configurationParts(tree: FlightTree): Part[] {
  const parts: Part[] = motorMounts(tree).filter(node => node.id).map(node => ({ node, family: 'ignition' }));
  const top = stages(tree)[0];
  const visit = (nodes: ComponentNode[]) => {
    for (const node of nodes) {
      if (node.id && (node.type === 'parachute' || node.type === 'streamer')) parts.push({ node, family: 'recovery' });
      if (node.id && node !== top && (node.type === 'stage' || node.type === 'parallelstage')) parts.push({ node, family: 'separation' });
      visit(node.children ?? []);
    }
  };
  visit(tree.components);
  return parts;
}

function partValue(part: Part, config: Pick<SavedConfig, 'motors' | 'deployments' | 'separations' | 'ignitions' | 'unmatchedRefs'>,
  tree: FlightTree, unit: string) {
  const { node, family } = part;
  const id = node.id!;
  if (family === 'ignition') {
    const motor = overrideFor(config.motors, id);
    const ref = overrideFor(config.unmatchedRefs, id);
    if (!motor) return { text: ref ? `${ref.designation} (not loaded)` : 'No motor', override: false };
    return { text: `${motor.label} · ${describeIgnitionTuple(overrideFor(config.ignitions, id) ?? overrideFor(tree.ignitionDefaults, id) ?? motor.ignition, 'warning')}`,
      override: !!overrideFor(config.ignitions, id) };
  }
  const tuple = family === 'recovery' ? overrideFor(config.deployments, id) : overrideFor(config.separations, id);
  const effectiveNode = { ...node, ...tuple };
  return { text: family === 'recovery' ? describeFlownDeployment(deploymentTuple(effectiveNode), unit)
    : describeFlownSeparation(separationTuple(effectiveNode), unit), override: !!tuple };
}

export function ConfigOverview({ configs, activeConfigId, tree, onApply, onShowPart }: {
  configs: SavedConfig[]; activeConfigId: string | null; tree: FlightTree;
  onApply: (config: SavedConfig) => void;
  onShowPart: (id: string, family: Part['family']) => void;
}) {
  const { prefs } = usePrefs();
  const parts = useMemo(() => configurationParts(tree), [tree]);
  return <details className="panel config-overview">
    <summary>All configurations</summary>
    {configs.length === 0 ? <p className="comp-stats">No saved configurations.</p> :
      <div className="config-table-scroll" role="region" aria-label="All configurations" tabIndex={0}>
        <table className="config-table">
          <caption className="sr-only">Effective settings for every saved flight configuration</caption>
          <thead><tr><th scope="col">Configuration</th>{parts.map(p => <th key={p.node.id} scope="col">
            {p.node.name || p.node.type}<br />{p.family === 'ignition' ? 'Motor · ignition' : p.family === 'recovery' ? 'Recovery' : 'Separation'}
          </th>)}</tr></thead>
          <tbody>{configs.map((config, index) => {
            // The active configuration is already applied. Re-applying it resets
            // Undo and replaces the notice bar, so its row only navigates: its
            // name is not a button, and a cell goes to that part's row (review
            // of b9-int, finding 2). The choosers never re-apply it either.
            const active = config.id === activeConfigId;
            const label = savedConfigLabel(config);
            return <tr key={config.id} aria-current={active ? 'true' : undefined}>
              <th scope="row">{active ? <span>{label}</span>
                : <button className="file-btn" aria-label={`Apply ${label} — configuration ${index + 1}`}
                  onClick={() => onApply(config)}>{label}</button>}
                {config.isDefault && <span> — file default</span>}
                {active && <span className="config-active-tag"> — active</span>}
              </th>
              {parts.map(part => {
                const value = partValue(part, config, tree, prefs.units.altitude);
                const what = `${part.node.name || part.node.type}: ${value.text}${value.override ? ' — override' : ''}`;
                return <td key={part.node.id}><button className="file-btn" onClick={() => {
                  if (!active) onApply(config);
                  onShowPart(part.node.id!, part.family);
                }}
                  aria-label={active ? `Show ${what} — ${label}, the active configuration`
                    : `Apply ${label} — configuration ${index + 1}; ${what}`}>
                  {value.text}{value.override && <strong> — override</strong>}
                </button></td>;
              })}
            </tr>;
          })}</tbody>
        </table>
      </div>}
  </details>;
}
