// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { exportOrk } from './orkFile.js';
import { importMotorFiles } from './importMotorFiles.js';
import { defaultTree, motorMounts } from '../tree/treeModel.js';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
const eng = 'A8 18 70 3-5 0.00312 0.01624 Estes\n0.05 8.2\n0.3 3.5\n0.7 0\n';

it('EX omissions report a typed export consequence without changing the output', () => {
  const tree = defaultTree();
  const mount = motorMounts(tree)[0]!.id!;
  const onOmittedMotor = vi.fn();
  const args = { tree, name: 'Missing EX', motors: { [mount]: {
    designation: 'Missing', manufacturer: 'EX', delay: 3, exMotorId: 'ex:missing',
    diameter: 0.018, length: 0.07,
  } } };
  // Every export mints desktop UUIDs for app ids; compare all other bytes.
  const stable = (xml: string) => xml.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID');
  const baseline = stable(exportOrk(args));
  expect(stable(exportOrk({ ...args, onOmittedMotor }))).toBe(baseline);
  expect(onOmittedMotor).toHaveBeenCalledOnce();
  onOmittedMotor.mockClear();
  exportOrk({ tree, name: 'No EX', onOmittedMotor });
  expect(onOmittedMotor).not.toHaveBeenCalled();
});

it('ordinary and wholly refused motor imports remain quiet; partial imports carry Caution', async () => {
  const good = new File([eng], 'good.eng');
  const bad = new File(['not a motor'], 'bad.eng');
  expect((await importMotorFiles([good])).tier).toBe('information');
  expect((await importMotorFiles([bad])).tier).toBe('information');
  const partial = await importMotorFiles([good, bad]);
  expect(partial.tier).toBe('caution');
  expect(partial.parsed).toHaveLength(1);
  expect(partial.error).toContain('Skipped 1 file');
});
