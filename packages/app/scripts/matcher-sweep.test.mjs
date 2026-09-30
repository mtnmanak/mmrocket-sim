import { describe, expect, it } from 'vitest';
import { audit, classify } from './matcher-sweep.classify.mjs';
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
