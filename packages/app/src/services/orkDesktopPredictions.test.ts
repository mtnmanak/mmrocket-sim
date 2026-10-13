// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { exportOrk, importOrk } from './orkFile.js';
import { flightDataForExport, importedSummaryRuns, summaryDocument } from './orkFlightData.js';
import { defaultTree } from '../tree/treeModel.js';
import { flushSession, loadSession, saveSessionDebounced } from './session.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';

const file = (simulations: string, creator = 'OpenRocket 24.12') =>
  `<openrocket version="1.10" creator="${creator}"><rocket><name>Desktop design</name><subcomponents><stage><name>Stage</name><subcomponents><bodytube><name>Body</name><length>0.3</length><radius>0.025</radius><thickness>0.001</thickness></bodytube></subcomponents></stage></subcomponents></rocket><simulations>${simulations}</simulations></openrocket>`;
const sim = (id: string, attrs: string, extra = '') =>
  `<simulation status="outdated"><name>Flight ${id}</name><conditions><configid>${id}</configid></conditions>${extra}<flightdata ${attrs}/></simulation>`;

describe('desktop stored predictions', () => {
  it('excludes external data rather than claiming desktop computed it', () => {
    const external = '<simulation status="external"><name>Measured flight</name><conditions><configid>a</configid></conditions><flightdata maxaltitude="456"/></simulation>';
    expect(importOrk(file(external)).desktopPredictions).toBeUndefined();
    const imported = importOrk(file(external + sim('a', 'maxaltitude="123"')));
    expect(imported.desktopPredictions).toEqual([
      { name: 'Flight a', configId: 'a', status: 'outdated', sourceVersion: '24.12', data: { maxAltitude: 123 } },
    ]);
    expect(importedSummaryRuns(imported)).toEqual([]);
  });

  it('reads each finite summary independently, with configuration and writer version', () => {
    const imported = importOrk(file(sim('a', 'maxaltitude="123.4" maxvelocity="56" maxmach="NaN"')
      + sim('b', 'maxaltitude="789" flighttime="90" maxacceleration="Infinity"')
      + sim('bad', 'maxaltitude="no"') + '<simulation><name>No data</name></simulation>'));
    expect(imported.desktopPredictions).toEqual([
      { name: 'Flight a', configId: 'a', status: 'outdated', sourceVersion: '24.12', data: { maxAltitude: 123.4, maxVelocity: 56 } },
      { name: 'Flight b', configId: 'b', status: 'outdated', sourceVersion: '24.12', data: { maxAltitude: 789, flightTime: 90 } },
    ]);
    expect(imported.storedSimulations).toBeUndefined();
    expect(importedSummaryRuns(imported)).toEqual([]);
  });

  it('does not relabel app summaries or unknown app aero tags as desktop numbers', () => {
    const tagged = importOrk(file(sim('a', 'maxaltitude="123"', '<aeromodel>classic</aeromodel>')));
    expect(tagged.storedSimulations).toHaveLength(1);
    expect(tagged.desktopPredictions).toBeUndefined();
    for (const creator of ['MMRocket Sim', 'Online OpenRocket']) {
      expect(importOrk(file(sim('a', 'maxaltitude="123"'), creator)).desktopPredictions).toBeUndefined();
    }
    expect(importOrk(file(sim('a', 'maxaltitude="123"', '<aeromodel>future</aeromodel>'))).desktopPredictions).toBeUndefined();
  });

  it('does not confuse file-format version with desktop version', () => {
    const imported = importOrk(file(sim('a', 'maxaltitude="0"'), 'OpenRocket'));
    expect(imported.desktopPredictions?.[0]?.sourceVersion).toBeUndefined();
    expect(imported.desktopPredictions?.[0]?.data.maxAltitude).toBe(0);
  });

  it('stored predictions cannot change imported launch conditions', () => {
    const conditions = '<conditions><configid>a</configid><windaverage>3</windaverage><windturbulence>0.2</windturbulence></conditions>';
    const without = importOrk(file(`<simulation>${conditions}</simulation>`));
    const withData = importOrk(file(`<simulation>${conditions}<flightdata maxaltitude="9000" maxvelocity="900"/></simulation>`));
    expect(withData.launch).toEqual(without.launch);
  });

  it('keeps a cloned file-owned snapshot through reload without exporting it as app flightdata', () => {
    localStorage.clear();
    const imported = importOrk(file(sim('a', 'maxaltitude="123"')));
    const document = summaryDocument(imported)!;
    expect(document.desktopPredictions).toHaveLength(1);
    imported.desktopPredictions![0]!.data.maxAltitude = 999;
    loadSession();
    saveSessionDebounced({ tree: defaultTree(), launch: DEFAULT_CONDITIONS, importedDocument: document });
    flushSession();
    expect(loadSession()?.importedDocument?.desktopPredictions?.[0]?.data.maxAltitude).toBe(123);
    const output = exportOrk({ tree: defaultTree(), name: 'Desktop design', flightData: flightDataForExport({
      runs: [], savedConfigs: [], importedDocument: document, activeConfigId: null,
      assigned: [], mountIds: [], designKey: '', conditionsKey: '',
      model: { aeroMode: 'classic', effectiveKbf: false, autoSupersonic: false },
      hasNozzle: false, motorSetKeyOf: () => '', hardwareDeltaKg: 0, primaryMountOf: () => null,
    }) });
    expect(importOrk(output).desktopPredictions).toBeUndefined();
    expect(importOrk(output).storedSimulations).toBeUndefined();
  });

  it('drops malformed persisted comparisons without losing the session', () => {
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree: defaultTree(), launch: DEFAULT_CONDITIONS,
      importedDocument: { name: 'File', storedSimulations: [], desktopPredictions: [{ name: 'bad', configId: 4, data: null }] } }));
    const session = loadSession();
    expect(session).not.toBeNull();
    expect(session?.importedDocument?.desktopPredictions).toBeUndefined();
  });
});
