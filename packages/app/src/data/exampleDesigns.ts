import type { Quantity } from '../prefs/units.js';

export interface ExampleDesign {
  id: string;
  name: string;
  fileName: string;
  explanation: string;
  quantities?: readonly [text: string, quantity: Quantity, si: number][];
  asset: () => Promise<{ default: string }>;
}

// C-A3: each archive is a separate lazy asset; opening the chooser reads no designs.
export const EXAMPLE_DESIGNS: readonly ExampleDesign[] = [
  { id: 'minimum-diameter', name: 'Minimum-diameter single stage', fileName: 'minimum-diameter.ork',
    explanation: 'An 18 mm motor fits directly in the body tube. Rounded fins and a small parachute show a simple single-stage layout.',
    quantities: [['18 mm', 'motorDimensions', 0.018]],
    asset: () => import('./examples/minimum-diameter.ork?url') },
  { id: 'dual-deploy', name: 'Dual-deploy high power', fileName: 'dual-deploy.ork',
    explanation: 'An H128 motor lifts a two-inch airframe. A drogue opens at apogee and the main opens at 100 m on descent, assuming electronic deployment.',
    quantities: [['two-inch', 'length', 0.0508], ['100 m', 'altitude', 100]],
    asset: () => import('./examples/dual-deploy.ork?url') },
  { id: 'two-stage', name: 'Two stages with recovery', fileName: 'two-stage.ork',
    explanation: 'A D12 booster lights a C6 sustainer at burnout. The stages separate at booster burnout. The sustainer parachute opens at apogee and the booster parachute at 50 m on descent, assuming electronic deployment.',
    quantities: [['50 m', 'altitude', 50]],
    asset: () => import('./examples/two-stage.ork?url') },
  { id: 'cluster', name: 'Three-motor cluster', fileName: 'cluster.ork',
    explanation: 'Three B6 motors in one clustered mount fire together. The layout assumes all three ignite; a parachute opens at apogee, assuming electronic deployment.',
    asset: () => import('./examples/cluster.ork?url') },
  { id: 'boattail', name: 'Boattail single stage', fileName: 'boattail.ork',
    explanation: 'A reducing transition behind the body is a boattail. The D12 mount reaches through the tail; rounded fins and an apogee parachute complete the layout, assuming electronic deployment.',
    asset: () => import('./examples/boattail.ork?url') },
  { id: 'freeform', name: 'Freeform rounded fins', fileName: 'freeform.ork',
    explanation: 'A C6-powered rocket uses a custom fin outline with a rounded cross-section. Select the fin set to edit its points; its parachute opens at apogee, assuming electronic deployment.',
    asset: () => import('./examples/freeform.ork?url') },
];

export async function loadExampleFile(example: ExampleDesign, signal?: AbortSignal): Promise<File> {
  if (signal?.aborted) throw new DOMException('Example load cancelled.', 'AbortError');
  const { default: url } = await example.asset();
  if (signal?.aborted) throw new DOMException('Example load cancelled.', 'AbortError');
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`${example.name} could not be loaded. Try again when the app is available offline or the connection returns.`);
  const bytes = await response.arrayBuffer();
  if (signal?.aborted) throw new DOMException('Example load cancelled.', 'AbortError');
  return new File([bytes], example.fileName, { type: 'application/octet-stream' });
}
