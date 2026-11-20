import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const guide = readFileSync(new URL('../user-guide.md', import.meta.url), 'utf8');
it('J6 documents ignition on every loaded motor and comparison on unloaded mounts', () => {
  const airstart = guide.split('**Airstart**')[1].split('\n\n')[0];
  expect(airstart).toContain('Every loaded motor');
  expect(airstart).toContain('single-stage design');
  expect(airstart).not.toContain('has no airstart setting');
  const fly = guide.split('**Fly screen**')[1].split('\n\n')[0];
  expect(fly).toContain('including before a motor is loaded');
});

it('r5 documents configuration loading locks and display bounds without holding the starter', () => {
  expect(guide).toContain('Wait for the motor to finish loading');
  expect(guide).toContain('both **Flight configuration** choosers are unavailable');
  expect(guide).not.toContain('the original and its copies receive that motor');
  expect(guide).toContain('refuse values too large to display in every altitude unit');
  expect(guide).toContain('storage failure alone does not hold the unchanged starter design');
});
