import { expect, it } from 'vitest';
import * as ignition from './ignitionEvent.js';
import * as report from './simReport.js';

it.each([['ignitionEvent', 'IGNITION_EVENTS', ignition], ['simReport', 'PHYSICS_REVISIONS', report]] as const)(
  'S7a-3 %s does not export %s', (_moduleName, name, module) => {
    expect(module).not.toHaveProperty(name);
  });
