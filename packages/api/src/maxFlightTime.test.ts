import { afterEach, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { authenticatedWorker as worker } from './auth.testSupport.js';
import { bytesOf, orkOf } from './fixtures.testSupport.js';
import * as flightRunner from '../../app/src/services/flightRunner.js';
import type { ImportPlan } from '../../app/src/services/importApply.js';

afterEach(() => vi.restoreAllMocks());

function request(xml: string, limit: number, filename: string) {
  const body = orkOf(xml.replace('<simulations>', `<simulations><simulation><conditions><maxtime>${limit}</maxtime></conditions></simulation>`));
  return worker.fetch(new Request(`http://local/experimental/fly?filename=${filename}`,
    { method: 'POST', body: new Uint8Array(body).buffer }), undefined, { waitUntil: () => {} });
}

function withPolicyNote(note: ImportPlan['note'], text: string): ImportPlan['note'] {
  return { ...note, text: `${note.text}\n${text}`,
    group: { ...note.group, lines: [...note.group.lines, { kind: 'note', tier: 'information', text }] } };
}

it.each([1, 3600, 50000, 0.5, 1200, 1200.000000000001])('129 API explicitly flies 1200 s despite uploaded maxtime %s', async limit => {
  const xml = strFromU8(unzipSync(bytesOf('reference.ork'))['rocket.ork']!);
  // Derive unrelated motor/catalogue notes at runtime rather than pinning shipped motor data.
  const baselineResponse = await request(xml, 1200, 'limit.ork');
  expect(baselineResponse.status).toBe(200);
  const baseline = await baselineResponse.json() as { notes: { import: ImportPlan['note'] } };
  expect(baseline.notes.import.text).not.toContain('Maximum flight time');
  const spy = vi.spyOn(flightRunner, 'flyLaunch');
  const response = await request(xml, limit, 'limit.ork');
  expect(response.status, await response.clone().text()).toBe(200);
  expect(spy).toHaveBeenCalled();
  expect(spy.mock.calls[0]![1].simOptions.maxTime).toBe(1200);
  const out = await response.json() as { notes: { import: ImportPlan['note'] } };
  const expected = Math.abs(limit - 1200) > 1e-10
    ? withPolicyNote(baseline.notes.import, "This API overrides the file's Maximum flight time; flown at 1200 s.")
    : baseline.notes.import;
  expect(out.notes.import).toEqual(expected);
}, 60_000);

it.each([3600, 50000, 0.5, 1200.000000000001])('129 API refusal at %s never claims the uploaded design flew or offers a UI clamp', async limit => {
  const xml = '<openrocket version="1.10"><rocket><subcomponents><stage><subcomponents>'
    + '<bodytube><length>1</length><radius>0.03</radius></bodytube></subcomponents></stage></subcomponents></rocket>'
    + '<simulations></simulations></openrocket>';
  const baselineResponse = await request(xml, 1200, 'motorless.ork');
  expect(baselineResponse.status).toBe(422);
  const baseline = await baselineResponse.json() as { error: { importNote: ImportPlan['note'] } };
  expect(baseline.error.importNote.text).not.toContain('Maximum flight time');
  const spy = vi.spyOn(flightRunner, 'flyLaunch');
  const response = await request(xml, limit, 'motorless.ork');
  expect(response.status).toBe(422);
  expect(spy).not.toHaveBeenCalled();
  const out = await response.json() as { error: { importNote: ImportPlan['note'] } };
  const expected = Math.abs(limit - 1200) > 1e-10
    ? withPolicyNote(baseline.error.importNote, "This API uses a Maximum flight time of 1200 s instead of the file's setting. The flight was refused.")
    : baseline.error.importNote;
  expect(out.error.importNote).toEqual(expected);
}, 60_000);
