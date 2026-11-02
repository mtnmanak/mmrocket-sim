import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { BaseSequencer } from 'vitest/node';
import { expect, it } from 'vitest';
import { ProjectShardSequencer } from './project-shard-sequencer.mjs';

const root = resolve('shard-fixture');
const spec = (name, file) => ({ project: { name }, moduleId: resolve(root, file) });
const app = Array.from({ length: 9 }, (_, i) => spec('app', `file-${i}.test.ts`));
const jsxml = app.map((s) => spec('jsxml', s.moduleId));
const files = [...app, spec('app', 'app-only.test.ts'), ...jsxml];
const orders = [files, [...jsxml, ...app, files[9]],
  files.filter((_, i) => i % 2 === 1).reverse().concat(files.filter((_, i) => i % 2 === 0))];
const identity = (s) => `${s.project.name}\u0000${s.moduleId}`;

async function assertPartitions(Sequencer) {
  for (let count = 2; count <= 5; count++) {
    const selections = await Promise.all(orders.map(async (order) => {
      const shards = [];
      for (let index = 1; index <= count; index++) {
        const ctx = { config: { root, shard: { index, count } } };
        shards.push((await new Sequencer(ctx).shard(order)).map(identity).sort());
      }
      // Array equality, rather than Set equality, also detects repeated specs.
      expect(shards.flat().sort()).toEqual(files.map(identity).sort());
      return shards;
    }));
    for (const selection of selections.slice(1)) expect(selection).toEqual(selections[0]);
  }
}

it('partitions every project/file exactly once for 2..5 shards regardless of glob order', async () => {
  await assertPartitions(ProjectShardSequencer);
  expect(ProjectShardSequencer.prototype.sort).toBe(BaseSequencer.prototype.sort);
});

it('rejects the installed base sequencer at a split pair boundary', async () => {
  await expect(assertPartitions(BaseSequencer)).rejects.toThrow();
});

it('rejects a copy of the subclass with the project removed from its hash', async () => {
  class PathOnlyMutation extends ProjectShardSequencer {
    async shard(input) {
      const { root, shard: { index, count } } = this.ctx.config;
      const [start, end] = this.calculateShardRange(input.length, index, count);
      const slash = (path) => path.replace(/\\/g, '/');
      return Array.from(input, (spec) => {
        const specPath = resolve(slash(root), slash(spec.moduleId)).slice(root.length);
        return { spec, hash: createHash('sha1').update(specPath).digest('hex') };
      }).sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)
        .slice(start, end).map(({ spec }) => spec);
    }
  }
  await expect(assertPartitions(PathOnlyMutation)).rejects.toThrow();
});
