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

it('splits exactly by sha1(project NUL root-relative path), so every runner agrees', async () => {
  // An independent reference computed here: anything per-process in the key
  // (a seed, a pid, a time) or a different path form changes the split and
  // fails this, though the one-process order test above cannot see it.
  const relative = (s) => s.moduleId.slice(root.length).replace(/\\/g, '/');
  const key = (s) => createHash('sha1').update(`${s.project.name}\u0000${relative(s)}`).digest('hex');
  const sorted = [...files].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)).map(identity);
  const assertReference = async (Sequencer) => {
    for (let count = 2; count <= 5; count++) {
      let at = 0;
      for (let index = 1; index <= count; index++) {
        const size = Math.floor(files.length / count) + (index <= files.length % count ? 1 : 0);
        const ctx = { config: { root, shard: { index, count } } };
        expect((await new Sequencer(ctx).shard(files)).map(identity)).toEqual(sorted.slice(at, at + size));
        at += size;
      }
    }
  };
  await assertReference(ProjectShardSequencer);
  // Mutation: a per-process salt in the key (here the pid, folded into the
  // project name the subclass hashes) changes the split.
  class SaltedKey extends ProjectShardSequencer {
    async shard(input) {
      const byKey = new Map(input.map((s) => [`${s.project.name}${process.pid}\u0000${s.moduleId}`, s]));
      const salted = input.map((s) => ({ ...s, project: { name: `${s.project.name}${process.pid}` } }));
      return (await super.shard(salted)).map((s) => byKey.get(`${s.project.name}\u0000${s.moduleId}`));
    }
  }
  await expect(assertReference(SaltedKey)).rejects.toThrow();
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
