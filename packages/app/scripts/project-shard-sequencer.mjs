import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { BaseSequencer } from 'vitest/node';

const slash = (path) => path.replace(/\\/g, '/');

/**
 * Vitest 5.0.5 BaseSequencer hashes only the path (dist/chunks/index.1TqnEahn.js:
 * 7768-7779). Project globs push specs in completion order (dist/chunks/
 * cli-api.De07GUeT.js:10329-10337), so equal-path app/jsxml specs can swap at a
 * shard boundary on separate runners. Include the project to make that split
 * independent of glob completion order; inherit Vitest's sort unchanged.
 */
export class ProjectShardSequencer extends BaseSequencer {
  async shard(files) {
    const { root, shard: { index, count } } = this.ctx.config;
    const [start, end] = this.calculateShardRange(files.length, index, count);
    return Array.from(files, (spec) => {
      const specPath = resolve(slash(root), slash(spec.moduleId)).slice(root.length);
      return { spec, hash: createHash('sha1').update(`${spec.project.name}\u0000${specPath}`).digest('hex') };
    }).sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)
      .slice(start, end).map(({ spec }) => spec);
  }
}
