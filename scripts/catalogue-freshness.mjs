import { createHash } from 'node:crypto';
import { checkedTimestamp, contentHash, unorderedCurveContentHash, validatePreviousManifest } from '../packages/app/scripts/catalogue-publish.mjs';
import { FIELDS } from '../packages/app/scripts/fetch-motor-db.mjs';

const BASE = 'https://catalogue.mountainmanrockets.com/';

/** Read-only proof: a recent refresh checked the exact rows/curves we bundle. */
export async function publishedCatalogueCheck(snapshot, curves, getBytes, now = Date.now(), maxAgeDays = 8) {
  try {
    const manifest = JSON.parse(await getBytes(`${BASE}manifest.json`));
    validatePreviousManifest(manifest);
    const entry = manifest.snapshots.find(s => s.id === manifest.current);
    const at = manifest.checkedAt;
    if (!checkedTimestamp(at)
      || typeof manifest.checkedRunId !== 'string' || !/^[1-9]\d*$/.test(manifest.checkedRunId)
      || Date.parse(at) < Date.parse(entry.motors.generated) || Date.parse(at) < Date.parse(snapshot.generated)
      || Date.parse(at) > now || Math.floor((now - Date.parse(at)) / 86_400_000) > maxAgeDays) return null;
    const docs = {};
    for (const kind of ['motors', 'curves']) {
      const bytes = Buffer.from(await getBytes(new URL(entry[kind].path, BASE).href));
      if (bytes.length !== entry[kind].bytes || createHash('sha256').update(bytes).digest('hex') !== entry[kind].sha256) return null;
      docs[kind] = JSON.parse(bytes);
    }
    const rows = doc => Buffer.from(JSON.stringify({ motors: doc.motors.map(row =>
      Object.fromEntries(FIELDS.filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]]))) }));
    if (contentHash(rows(docs.motors)) !== contentHash(rows(snapshot))
      || unorderedCurveContentHash(Buffer.from(JSON.stringify(docs.curves)))
        !== unorderedCurveContentHash(Buffer.from(JSON.stringify(curves)))) return null;
    return at.slice(0, 10);
  } catch { return null; } // Missing, offline, malformed or mismatched evidence never clears an alarm.
}
