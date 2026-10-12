import { useMemo } from 'react';
import type { ComponentNode } from '@online-openrocket/engine';
import { savedConfigLabel, type FlightTree, type SavedConfig, type FlightOverrides } from '../model/design.js';
import { motorMounts, stages } from '../tree/treeModel.js';
import { deploymentTuple } from '../services/foreignConfigLayers.js';
import { describeComponentFlightTuple, describeIgnitionTuple, separationTuple } from '../services/flightOverrideText.js';
import { usePrefs } from '../prefs/PrefsContext.js';

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
    const motor = config.motors[id];
    if (!motor) return { text: config.unmatchedRefs?.[id] ? `${config.unmatchedRefs[id]!.designation} (not loaded)` : 'No motor', override: false };
    return { text: `${motor.label} · ${describeIgnitionTuple(config.ignitions?.[id] ?? tree.ignitionDefaults?.[id] ?? motor.ignition, 'warning')}`,
      override: !!config.ignitions?.[id] };
  }
  const tuple = family === 'recovery' ? config.deployments?.[id] : config.separations?.[id];
  const effective = family === 'recovery' ? deploymentTuple({ ...node, ...tuple }) : separationTuple({ ...node, ...tuple });
  return { text: describeComponentFlightTuple(effective, unit, 'warning'), override: !!tuple };
}

/** Read-only destinations for the grid; CFG-2 adds the scoped editors here. */
export function ConfigPartSummaries({ tree, overrides }: { tree: FlightTree; overrides: FlightOverrides }) {
  const { prefs } = usePrefs();
  const parts = useMemo(() => configurationParts(tree), [tree]);
  return <>{(['recovery', 'separation'] as const).map(family => {
    const rows = parts.filter(p => p.family === family);
    return rows.length > 0 && <section key={family} aria-label={family === 'recovery' ? 'Recovery' : 'Stages'}>
      <h3>{family === 'recovery' ? 'Recovery' : 'Stages'}</h3>
      {rows.map(part => {
        const value = partValue(part, { motors: {}, ...overrides }, tree, prefs.units.distance);
        return <div key={part.node.id} id={`cfg-part-${part.node.id!}`} tabIndex={-1} className="config-part-summary">
          <strong>{part.node.name || part.node.type}</strong>
          <p className="comp-stats">{value.text}{value.override ? ' — override' : ' — uses own setting'}</p>
        </div>;
      })}
    </section>;
  })}</>;
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
          <tbody>{configs.map((config, index) => <tr key={config.id} aria-current={config.id === activeConfigId ? 'true' : undefined}>
            <th scope="row"><button className="file-btn" aria-label={`Apply ${savedConfigLabel(config)} — configuration ${index + 1}`}
              onClick={() => onApply(config)}>{savedConfigLabel(config)}</button>
              {config.isDefault && <span> — file default</span>}
              {config.id === activeConfigId && <span className="config-active-tag"> — active</span>}
            </th>
            {parts.map(part => {
              const value = partValue(part, config, tree, prefs.units.distance);
              return <td key={part.node.id}><button className="file-btn" onClick={() => { onApply(config); onShowPart(part.node.id!, part.family); }}
                aria-label={`Apply ${savedConfigLabel(config)} — configuration ${index + 1}; ${part.node.name || part.node.type}: ${value.text}${value.override ? ' — override' : ''}`}>
                {value.text}{value.override && <strong> — override</strong>}
              </button></td>;
            })}
          </tr>)}</tbody>
        </table>
      </div>}
  </details>;
}
