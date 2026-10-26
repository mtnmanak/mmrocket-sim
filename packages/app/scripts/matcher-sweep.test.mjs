import { describe, expect, it } from 'vitest';
import { audit, classify } from './matcher-sweep.classify.mjs';
import { mutations, replaceMutationAnchor } from './matcher-sweep.mutate.mjs';
import { readFileSync } from 'node:fs';

describe('mutation harness anchor guards', () => {
  it('does not linearly search simulation nodes for RASAero nozzle notes', () => {
    const source = readFileSync(new URL('../src/services/rasaeroFile.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('sims.indexOf(');
  });
  it('does not rewrite CDATA inside comments or linearly search simulations per motor', () => {
    const source = readFileSync(new URL('./matcher-sweep.worker.mjs', import.meta.url), 'utf8');
    expect(source).not.toContain('.replace(/<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/g');
    expect(source).not.toContain('sims.indexOf(');
    expect(source).not.toContain(".closest('Simulation')");
  });
  it('refuses missing and ambiguous anchors before replacing source', () => {
    expect(() => replaceMutationAnchor('one', 'absent', 'x', 'missing')).toThrow('expected 1 hit, found 0');
    expect(() => replaceMutationAnchor('one one', 'one', 'x', 'duplicate')).toThrow('expected 1 hit, found 2');
    expect(replaceMutationAnchor('one two', 'one', 'x', 'unique')).toBe('x two');
  });

  it('mutates physical-evidence multiple sets separately from diagnostic burn time', () => {
    const source = readFileSync(new URL('../src/services/rocksimMotorEvidence.ts', import.meta.url), 'utf8');
    const [, , anchor, replacement] = mutations.find(([name]) => name === 'rkt-evidence-multiple-sets');
    const changed = replaceMutationAnchor(source, anchor, replacement, 'rkt-evidence-multiple-sets');
    const split = source.indexOf('export function rocksimMotorEvidence');
    expect(changed.slice(0, split)).toBe(source.slice(0, split));
    expect(changed.slice(split)).not.toBe(source.slice(split));
  });
});
describe('matcher sweep accounting (no local corpus needed)', () => {
  const meta = { selectedFiles: 1, expectedFiles: 1 };
  const record = side => ({ key: 'fixture', side, status: 'ok', sha256: 'hash', raw: [{ ordinal: 0, designation: 'C6', resolved: [0] }], refs: [{ id: 'c6', loaded: true }] });
  it('classifies against independent allowed identities, including unavailable and unknown truth', () => {
    const right = { id: 'right', loaded: true }, wrong = { id: 'wrong', loaded: true }, none = { id: null, loaded: false };
    expect(classify(right, wrong, ['right'])).toBe('right→wrong');
    expect(classify(right, none, ['right'])).toBe('right→nothing');
    expect(classify(none, wrong, ['right'])).toBe('none→wrong');
    expect(classify(none, right, ['right'])).toBe('none→right');
    expect(classify(wrong, right, ['right'])).toBe('wrong→right');
    expect(classify(wrong, none, [])).toBe('wrong→nothing');
    expect(classify(wrong, { id: 'wrong2', loaded: true }, ['right'])).toBe('wrong→wrong');
    expect(classify(wrong, right, null)).toBe('UNVERIFIABLE');
  });
  it('requires complete paired input, parsing, ordinals and raw/importer reconciliation', () => {
    const b = record('baseline'), c = record('current');
    expect(audit(meta, [b, c]).pass).toBe(true);
    expect(audit({ ...meta, expectedFiles: 2 }, [b, c]).pass).toBe(false);
    expect(audit({ selectedFiles: 2, expectedFiles: 2 }, [b, c]).pass).toBe(false);
    expect(audit(meta, [b]).pass).toBe(false);
    expect(audit(meta, [b, { ...c, status: 'error' }]).pass).toBe(false);
    expect(audit(meta, [b, { ...c, raw: [] }]).pass).toBe(false);
    expect(audit(meta, [b, { ...c, raw: [{ ordinal: 0, designation: 'C6' }] }]).pass).toBe(false);
    expect(audit(meta, [b, { ...c, refs: [...c.refs, { id: 'hidden', loaded: true }] }]).pass).toBe(false);
    expect(audit(meta, [b, { ...c, refs: [{ id: 'unknown-change', loaded: true }] }]).pass).toBe(false);
    expect(audit(meta, [b, { ...c, sha256: 'changed-input' }]).pass).toBe(false);
  });
  it('rejects each forbidden transition even when the oracle is known', () => {
    const b = record('baseline'), c = record('current');
    b.raw[0].designation = c.raw[0].designation = 'G80';
    const right = { id: '5f4294d20002310000000068', loaded: true };
    const wrong = { id: 'different-motor', loaded: true };
    const none = { id: null, loaded: false };
    for (const [from, to] of [[right, wrong], [right, none], [none, wrong]]) {
      expect(audit(meta, [{ ...b, refs: [from] }, { ...c, refs: [to] }]).pass).toBe(false);
    }
  });
});
