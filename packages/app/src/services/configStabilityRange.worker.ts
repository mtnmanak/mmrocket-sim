import { KERNEL_HANDLES } from './buildDesign.js';
import { StabilityRangeCalculator, type StabilityRangeInput } from './configStabilityRange.js';

const calculator = new StabilityRangeCalculator(KERNEL_HANDLES);
let generation = 0;
self.onmessage = async (event: MessageEvent<{ id: number; input?: StabilityRangeInput }>) => {
  const { id, input } = event.data;
  generation = id;
  if (!input) return;
  try {
    const result = await calculator.calculate(input, () => generation !== id);
    if (result && generation === id) self.postMessage({ id, result });
  } catch (e) {
    if (generation === id) self.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
