import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
const root = process.cwd().replaceAll('\\', '/');
const emit = row => appendFileSync(process.env.MATCHER_OUT, JSON.stringify(row) + '\n');
writeFileSync(`${process.env.MATCHER_OUT}.pid`, String(process.pid));
const libraries = {};
for (const side of ['baseline', 'current']) {
  const src = side === 'baseline' ? `${root}/.matcher-sweep/baseline/packages/app/src` : `${root}/packages/app/src`;
  const mod = file => import(pathToFileURL(`${src}/services/${file}.ts`).href);
  libraries[side] = { ...await mod('orkFile'), ...await mod('rocksimFile'), ...await mod('rasaeroFile'), ...await mod('motorDb'), ...await mod('motorMatch'), ...await mod('zipMember'), ...await mod('xmlUtil'), ...await mod('importApply'),
    ...await import(pathToFileURL(`${src}/components/LaunchPanel.tsx`).href) };
}
for (const file of JSON.parse(readFileSync(process.env.MATCHER_LIST, 'utf8'))) {
  for (const side of ['baseline', 'current']) {
    const win = new Window();
    Object.assign(globalThis, { DOMParser: win.DOMParser, XMLSerializer: win.XMLSerializer, localStorage: win.localStorage });
    globalThis.fetch = () => Promise.reject(new Error('Offline matcher sweep'));
    const lib = libraries[side];
    const data = readFileSync(file.path);
    const kind = /\.rkt$/i.test(file.path) ? 'rkt' : /\.cdx1$/i.test(file.path) ? 'cdx1' : 'ork';
    try {
      const bytes = data[0] === 0x50 && data[1] === 0x4b ? lib.unzipMember(data, `.${kind}`, kind) : data;
      if (kind === 'rkt' && new TextDecoder().decode(bytes.subarray(0, 64)).includes('[[RS')) {
        let rejection;
        try { lib.importRkt(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)); }
        catch (error) { rejection = String(error); }
        if (!rejection?.includes('BINARY RockSim')) throw new Error('Binary importer rejection changed');
        emit({ ...file, side, kind, status: 'unsupported-binary', error: rejection, raw: null });
        await win.happyDOM.close();
        continue;
      }
      const xml = lib.decodeXml(bytes).xml.replace(/^\uFEFF?\s*<\?xml[^?]*\?>/, '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
      const doc = new win.DOMParser().parseFromString(xml, 'text/xml');
      if (doc.querySelector('parsererror')) throw new Error('Raw inventory XML parse failure');
      if (kind === 'rkt' && doc.documentElement.tagName === 'SOAP-ENV:Envelope'
        && xml.includes('clr/nsassem/RASAero/')) {
        let rejection;
        try { lib.importRkt(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)); }
        catch (error) { rejection = String(error); }
        if (!rejection?.includes('missing RocketDesign')) throw new Error('Legacy RASAero rejection changed');
        emit({ ...file, side, kind, status: 'unsupported-legacy-rasaero', error: rejection,
          legacyEngineNames: [...doc.querySelectorAll('EngineName')].map(el => el.textContent.trim()) });
        await win.happyDOM.close();
        continue;
      }
      const text = (el, tag) => el.querySelector(`:scope > ${tag}`)?.textContent?.trim() ?? '';
      const sims = [...doc.querySelectorAll(kind === 'rkt' ? 'SimulationResults' : 'Simulation')];
      const raw = kind === 'rkt' ? [...doc.querySelectorAll('EngineSet')].map((el, ordinal) => ({ ordinal, designation: text(el, 'EngineCode'), manufacturer: text(el, 'EngineMfg'), mount: text(el, 'MountSerialNo'),
        config: el.closest('SimulationResults') ? `rocksim-sim-${sims.indexOf(el.closest('SimulationResults')) + 1}` : 'rocksim-design',
        fingerprint: ['EngineCode', 'EngineMfg', 'MountSerialNo', 'IgnitionDelay', 'EjectionDelay'].map(t => text(el, t)).join('|') }))
        : kind === 'ork' ? [...doc.querySelectorAll('motormount > motor')].map((el, ordinal) => ({ ordinal, designation: text(el, 'designation'), manufacturer: text(el, 'manufacturer'), config: el.getAttribute('configid') }))
          : [...doc.querySelectorAll('SustainerEngine, Booster1Engine, Booster2Engine')].map((el, ordinal) => {
            const s = el.closest('Simulation');
            const name = el.textContent.trim();
            const parts = name.split(/\s{2,}/);
            const enabled = el.tagName === 'SustainerEngine' || text(s, el.tagName.replace('Engine', '').replace('Booster', 'IncludeBooster')).toLowerCase() === 'true';
            return { ordinal, designation: parts[0]?.replace(/-([0-9]+|[pP])$/, ''), manufacturer: parts[1]?.replace(/^\(|\)$/g, ''), original: name,
              config: `rasaero-sim-${sims.indexOf(s) + 1}`, slot: el.tagName,
              excluded: !enabled ? 'disabled booster' : name.includes('NoThrust') || !name ? 'empty/NoThrust' : parts.length !== 2 ? 'unreadable engine string' : undefined };
          });
      const input = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const imported = kind === 'rkt' ? lib.importRkt(input) : kind === 'ork' ? lib.importOrk(input) : lib.importCdx1(input);
      const refs = [];
      const results = new Map();
      const cachedMatch = async ref => {
        const key = JSON.stringify(ref);
        if (!results.has(key)) results.set(key, await lib.matchImportedMotor(ref));
        return results.get(key);
      };
      for (const [ci, cfg] of (imported.configs ?? []).entries()) {
        for (const [ri, ref] of Object.values(cfg.motors).entries()) {
          const how = lib.matchDbMotor(ref.designation, ref.diameter > 0 ? ref.diameter * 1000 : undefined, undefined, ref.manufacturer, ref.matchContext);
          const result = await cachedMatch(ref);
          refs.push({ config: cfg.id, configOrdinal: ci, motorOrdinal: ri, ref: { ...ref, mountId: undefined }, id: result.motor?.meta.motorId ?? how?.motor.motorId ?? null,
            designation: lib.MOTOR_DB.find(m => m.motorId === result.motor?.meta.motorId)?.designation ?? how?.motor.designation,
            tier: how?.tier, rivals: how?.rivals.map(m => m.motorId), reason: how?.reason,
            loaded: !!result.motor, missing: result.missing, note: result.openNote ?? result.note });
        }
      }
      const groupKey = config => raw.filter(r => r.config === config).map(r => r.fingerprint).sort().join('\n');
      for (const r of raw) {
        if (r.excluded || !r.designation) { r.excluded ??= 'empty motor name'; continue; }
        let config = r.config;
        if (kind === 'rkt' && !refs.some(x => x.config === config)) {
          config = [...new Set(refs.map(x => x.config))].find(c => groupKey(c) === groupKey(r.config));
        }
        const matches = refs.map((x, i) => ({ x, i })).filter(({ x }) => x.config === config && x.ref.designation === r.designation
          && (!r.manufacturer || x.ref.manufacturer === r.manufacturer));
        r.resolved = matches.map(x => x.i);
        if (!r.resolved.length) r.excluded = 'unattached or importer-discarded; review file notes';
        else r.reconciliation = config === r.config ? 'direct' : 'folded duplicate simulation';
      }
      const resolved = await lib.resolveImportMotors(imported, cachedMatch);
      const textUnits = { mass: kg => `${kg} kg`, length: m => `${m} m` };
      const plan = lib.planImport(imported, resolved, { launch: { ...lib.DEFAULT_CONDITIONS }, text: textUnits });
      const switches = plan.snapshot.savedConfigs.map(c => ({ config: c.id,
        note: lib.planConfigSwitch({ ...plan.snapshot, unmatchedRefs: plan.unmatchedRefs }, c, textUnits).note }));
      emit({ ...file, side, kind, raw, refs, notes: imported.notes, opened: plan.snapshot.activeConfigId, openNote: plan.note, switches, status: 'ok' });
    } catch (error) { emit({ ...file, side, status: 'error', error: String(error) }); }
    await win.happyDOM.close();
  }
}
