import rawRecord from '../data/catalogueSnapshot.json';
import { MOTOR_DB_DATE } from './motorDb.js';

/**
 * WHICH CURATED SNAPSHOT THE BUNDLE IS (owner 113-9e, 2026-10-28).
 *
 * catalogueSnapshot.json names the published snapshot whose rows the shipped
 * motors.json already holds: the snapshot's own motors file sha (the 25-field
 * motors-full.json the refresh froze, which is NOT a file in this repository,
 * so it cannot be computed here) and its curves file sha (the bundled
 * motorCurves.json's own bytes). When the live manifest names exactly those
 * files, catalogueOverlay.ts installs "no change" without downloading the
 * ~600 KB motors file.
 *
 * Until the release pipeline writes it, every value is null and the record is
 * unknown: the check downloads as it always has. A record whose date is not the
 * shipped catalogue's (a hand refresh that left it behind) is unknown too.
 */
export interface BundledSnapshot {
  generated: string;
  motorsSha256: string;
  curvesSha256: string;
}

const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

let override: { record: unknown } | null = null;

/** The record when it is known and belongs to THIS bundle, else null. */
export function bundledSnapshot(): BundledSnapshot | null {
  const r = (override ? override.record : rawRecord) as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || r['schema'] !== 1) return null;
  if (!digest(r['motorsSha256']) || !digest(r['curvesSha256']) || r['generated'] !== MOTOR_DB_DATE) return null;
  return { generated: r['generated'], motorsSha256: r['motorsSha256'], curvesSha256: r['curvesSha256'] };
}

/** Tests only: read `record` in place of the committed file; `null` restores the file. */
export function setBundledSnapshotForTests(record: unknown): void {
  override = record === null ? null : { record };
}
