import { afterEach, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { authenticatedWorker as worker } from './auth.testSupport.js';
import { bytesOf, orkOf } from './fixtures.testSupport.js';
import * as flightRunner from '../../app/src/services/flightRunner.js';

afterEach(() => vi.restoreAllMocks());

it.each([1, 3600, 50000, 0.5, 1200, 1200.000000000001])('129 API explicitly flies 1200 s despite uploaded maxtime %s', async limit => {
  const xml = strFromU8(unzipSync(bytesOf('reference.ork'))['rocket.ork']!);
  const body = orkOf(xml.replace('<simulations>', `<simulations><simulation><conditions><maxtime>${limit}</maxtime></conditions></simulation>`));
  const spy = vi.spyOn(flightRunner, 'flyLaunch');
  const response = await worker.fetch(new Request('http://local/experimental/fly?filename=limit.ork',
    { method: 'POST', body: new Uint8Array(body).buffer }), undefined, { waitUntil: () => {} });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(spy).toHaveBeenCalled();
  expect(spy.mock.calls[0]![1].simOptions.maxTime).toBe(1200);
  const out = await response.json() as { notes: { import: { text: string } } };
  expect(out.notes.import.text).not.toContain('Maximum flight time field');
  if (Math.abs(limit - 1200) > 1e-10) expect(out.notes.import.text).toContain('flown at 1200 s');
  else expect(out.notes.import.text).not.toContain('flown at 1200 s');
}, 60_000);

it.each([3600, 50000])('129 API refusal at %s never claims the uploaded design flew or offers a UI clamp', async limit => {
  const body = orkOf('<openrocket version="1.10"><rocket><subcomponents><stage><subcomponents>'
    + '<bodytube><length>1</length><radius>0.03</radius></bodytube></subcomponents></stage></subcomponents></rocket>'
    + `<simulations><simulation><conditions><maxtime>${limit}</maxtime></conditions></simulation></simulations></openrocket>`);
  const spy = vi.spyOn(flightRunner, 'flyLaunch');
  const response = await worker.fetch(new Request('http://local/experimental/fly?filename=motorless.ork',
    { method: 'POST', body: new Uint8Array(body).buffer }), undefined, { waitUntil: () => {} });
  expect(response.status).toBe(422);
  expect(spy).not.toHaveBeenCalled();
  const text = await response.text();
  expect(text).not.toContain('flown at');
  expect(text).not.toContain('Maximum flight time field');
}, 60_000);
