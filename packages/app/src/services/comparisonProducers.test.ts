// @vitest-environment happy-dom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { expect, it } from 'vitest';
import type { ComponentNode, FlightResult, RocketTree, StaticInfo } from '@online-openrocket/engine';
import { INITIAL_UNITS, IMPERIAL_UNITS, noticeQuantity, type UnitSelection } from '../prefs/units.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { ScaleDialog } from '../components/ScaleDialog.js';
import { PropertyPanel } from '../components/PropertyPanel.js';
import { SimRunDetails } from '../components/SimResults.js';
import { fieldNoticeText } from '../components/weatherText.js';
import { ringFitFor } from '../components/ringFit.js';
import { screenEntry } from './catalogueOverlay.js';
import { parseMotorFile, parseRse } from './exMotors.js';
import { samplesToMotorSpec, impulseNote } from './thrustcurve.js';
import { MOTOR_DB } from './motorDb.js';
import { preflightAudit, DENSITY_RANGE_FACTOR } from './preflightAudit.js';
import { SURFACE_MATERIALS } from '../data/materials.js';
import { treeProblems } from '../tree/sanitize.js';
import { planAxialSplit } from '../tree/splitSolid.js';
import { parseForecast, parseCoordinates } from './openMeteo.js';
import { importCdx1 } from './rasaeroFile.js';
import { importOrk } from './orkFile.js';
import { reconcileIncludedMotor, OVERRIDE_INCLUDES_MOTOR } from './statedLaunchWeight.js';
import { statedWeightTextFor } from './unitText.js';
import { groundWindAdvice, flightLimitAdvice, SURFACE_WIND_LIMIT_MS } from './flightAdvisories.js';
import { buildSimRun, SAFETY, commentsOf } from './simReport.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { printOffer } from './printPack.js';
import { componentDxf, dxfUnitFor } from './dxfExport.js';
import { nozzleOversize, nozzleOversizeText } from './nozzleCheck.js';
import { testMotor } from './autoDelay.testSupport.js';
import { formatWarning } from './simWarnings.js';
import { planImport } from './importApply.js';
import { designNotices } from './notices.js';
import { setXmlParser } from './xmlParse.js';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import reviewedCensus from './comparisonCensus.testSupport.json';

/** A conservative coverage census, not a text golden: a new comparison-bearing
 * producer must be assigned a boundary fixture or an explicit scope exemption.
 * Literal wording is not pinned. Counts include split sentences/JSX text. */
function comparisonCensus(root: string): Record<string, number> {
  const found: Record<string, number> = {};
  function scan(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory() && !['node_modules', 'dist', '__fixtures__'].includes(e.name)) scan(path);
      else if (/\.tsx?$/.test(path) && !/\.test\.|\.testSupport\.|changelog|userGuide/.test(path)) {
        const text = readFileSync(path, 'utf8');
        const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
        let count = 0;
        function visit(n: ts.Node) {
          // Include call sites as well: "more propellant ... than loaded mass"
          // can split the comparison words across template spans or JSX nodes.
          if (ts.isCallExpression(n) && /^(noticeQuantity|noticeComparison|noticeNumber|noticeChange|noticeEqual|fmtSi|fmtSig|fmtStepS|siToUi)$/.test(n.expression.getText(file))) count++;
          const literal = ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map(s => s.literal.text).join(' ')
            : ts.isStringLiteral(n) || ts.isJsxText(n) ? n.text : '';
          // Counts/bytes, static help and ordinary ranges can be false positives;
          // the reviewed census records those too so new producers cannot hide.
          if (literal && /outside|exceed|\bover\b|\bunder\b|below|above|\bthan\b|against|at most|at least|limit|range|accepts|maximum|minimum|beyond|too (large|small|long|short|heavy|light)|does not fit|changed|replacing|instead|becomes|[<>≤≥→]/i.test(literal)
            && !ts.isImportDeclaration(n.parent)) count++;
          ts.forEachChild(n, visit);
        }
        visit(file);
        if (count) found[relative(root, path).replaceAll('\\', '/')] = count;
      }
    }
  }
  scan(root);
  return found;
}


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const readFixture = (name: string) => readFileSync(new NodeURL('./__fixtures__/' + name, import.meta.url), 'utf8');
const caught = (run: () => unknown) => { try { run(); return ''; } catch (e) { return String(e); } };
const cdx = (site: string, simulation = '') => '<RASAeroDocument><RocketDesign><BodyTube><Length>20</Length><Diameter>3</Diameter></BodyTube></RocketDesign>'
  + '<LaunchSite>' + site + '</LaunchSite><SimulationList><Simulation>' + simulation + '</Simulation></SimulationList></RASAeroDocument>';
const ork = (condition: string) => '<openrocket version="1.10"><rocket><subcomponents><stage><subcomponents><bodytube><length>1</length><radius>0.05</radius></bodytube></subcomponents></stage></subcomponents></rocket>'
  + '<simulations><simulation><conditions>' + condition + '</conditions></simulation></simulations></openrocket>';
const marked = (cg: number, mass = 2): RocketTree => ({ components: [{ type: 'stage', id: 'stage',
  overrideMass: mass, overrideSubcomponentsMass: true, overrideCGX: cg, overrideSubcomponentsCG: true,
  [OVERRIDE_INCLUDES_MOTOR]: 'Test', children: [{ type: 'bodytube', id: 'mount', length: 0.508 }] }] });
const motor = { designation: 'Test', launchMassKg: 1, lengthM: 0.2, cgXFromFrontM: 0.1 };
const info: StaticInfo = {
  length: 0.37, lengthAerodynamic: 0.37, mass: 1, massEmpty: 1, cgEmpty: 0.19, cg: 0.26,
  rotationalInertia: 0.1, longitudinalInertia: 0.1, rotationalInertiaEmpty: 0.1, longitudinalInertiaEmpty: 0.1,
  cp: 0.29, cna: 8, stabilityCalibers: 1.3, refDiameter: 0.024, warnings: 0, warningTexts: [],
};
function flight(rod = 20, opening = 1, landing = 1): FlightResult {
  return { summary: { maxAltitude: 100, maxVelocity: 30, maxAcceleration: 10, maxMachNumber: 0.1,
    timeToApogee: 3, flightTime: 10, groundHitVelocity: landing, launchRodVelocity: rod, deploymentVelocity: opening, optimumDelay: 1 },
  events: [{ type: 'LAUNCH', time: 0 }, { type: 'LAUNCHROD', time: 1 }, { type: 'BURNOUT', time: 2 },
    { type: 'APOGEE', time: 3 }, { type: 'RECOVERY_DEVICE_DEPLOYMENT', time: 4, source: 'Drogue' }, { type: 'GROUND_HIT', time: 10 }],
  series: { time: [0, 1, 2, 3, 4, 9, 10], altitude: [0, 1, 90, 100, 99, landing, 0],
    velocity: [0, rod, 30, 0, opening, landing, landing], Vz: [0, rod, 30, 0, -opening, -landing, -landing],
    acceleration: [0, 10, 0, 0, 0, 0, 0], mass: [1, 1, 1, 1, 1, 1, 1], thrust: [0, 100, 0, 0, 0, 0, 0],
    drag: [0, 0, 0, 0, 0, 0, 0], mach: [0, 0.1, 0.1, 0, 0, 0, 0], stability: [1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3],
    cpLocation: [0.29, 0.29, 0.29, 0.29, 0.29, 0.29, 0.29], cgLocation: [0.26, 0.26, 0.26, 0.26, 0.26, 0.26, 0.26],
    aoa: [0, 0, 0, 0, 0, 0, 0] } };
}
function report(units: UnitSelection, part: 'rod' | 'drogue' | 'opening' | 'fallback-opening' | 'landing' | 'booster-landing' | 'booster-opening', delta: number): string {
  const kind = part === 'rod' ? 'rod' : part.includes('opening') ? 'opening' : 'landing';
  const limit = part === 'rod' ? 15 : part === 'drogue' ? SAFETY.maxDrogueDescentRate
    : kind === 'opening' ? SAFETY.warnDeploymentVelocity : SAFETY.maxLandingRate;
  const value = limit + (part === 'rod' ? -delta : delta);
  const f = flight(kind === 'rod' ? value : 20, kind === 'opening' ? value : 1, kind === 'landing' ? value : 1);
  if (part === 'drogue') {
    f.events.push({ type: 'RECOVERY_DEVICE_DEPLOYMENT', time: 9, source: 'Main' });
    f.series.Vz![4] = -value;
    f.series.Vz![5] = -value;
  }
  if (part === 'fallback-opening') f.events = f.events.filter(e => e.type !== 'RECOVERY_DEVICE_DEPLOYMENT');
  if (part === 'landing' || part === 'booster-landing') f.events = f.events.filter(e => e.type !== 'RECOVERY_DEVICE_DEPLOYMENT');
  const main = flight();
  const result = part.startsWith('booster') ? { ...main, branches: [
    { name: 'Sustainer', events: main.events, series: main.series }, { name: 'Booster', events: f.events, series: f.series },
  ] } : f;
  const run = buildSimRun({ result, info, motor: { designation: 'Test', diameter: 0.02, length: 0.1,
    times: [0, 2], thrusts: [10, 0], masses: [1, 0.5], cgX: 0.05, ejectionDelay: 2 },
    launch: DEFAULT_CONDITIONS, rocketName: 'Boundary', execMs: 1, units });
  const match = part === 'rod' ? /Rod-exit/ : part === 'drogue' ? /Descent under/ : part === 'booster-landing' ? /Booster lands/
    : part === 'landing' ? /Landing / : part === 'fallback-opening' ? /Deployment/ : part === 'booster-opening' ? /Booster:.*opens/ : /opens /;
  return commentsOf(run).find(c => match.test(c.text))?.text ?? '';
}
async function rendered(units: UnitSelection, component: (host: HTMLDivElement) => void | Promise<void>): Promise<string> {
  localStorage.clear();
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units }));
  const host = document.createElement('div');
  document.body.appendChild(host);
  try { await component(host); return host.textContent ?? ''; }
  finally { host.remove(); localStorage.clear(); }
}
async function scale(units: UnitSelection, delta: number) {
  return rendered(units, async host => {
    const root = createRoot(host);
    const tree: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', id: 'body', length: 0.5,
      outerRadius: (29 - delta * 1000) / 4000 + 0.0023, thickness: 0.0015,
      children: [{ type: 'innertube', id: 'mount', length: 0.1, outerRadius: 0.0078, thickness: 0.0008, motorMount: true }] }] }] };
    try {
      await act(async () => root.render(createElement(PrefsProvider, null, createElement(ScaleDialog, {
        tree, assignedMotorDiameters: {}, onApply: () => {}, onSaveBackup: () => {}, onClose: () => {},
      }))));
      act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
      const text = host.textContent ?? '';
      const match = text.match(/A ([\d.]+ (?:mm|in) \([\d.]+ (?:mm|in)\)) mount does not fit inside the\s+tube around it once scaled — at most (.+?) does\./);
      host.dataset.result = text.includes('mount is just over') ? text.match(/The mount is just over.+?maximum bore/)![0] : match ? match[1] + ' > ' + match[2] : '';
    } finally { act(() => root.unmount()); }
    host.textContent = host.dataset.result!;
  });
}
async function buttons(units: UnitSelection, delta: number, cg?: number, rocketLength = 0.6096) {
  return rendered(units, async host => {
    const rb: ComponentNode = { type: 'railbutton', id: 'rb', position: { method: 'top', offset: 0 } };
    const tree: RocketTree = { components: [{ type: 'stage', children: [
      { type: 'bodytube', id: 'front', length: 0.3556, outerRadius: 0.025 },
      { type: 'bodytube', id: 'aft', length: 0.254, outerRadius: 0.025, children: [rb] },
    ] }] };
    const root = createRoot(host);
    try {
      act(() => root.render(createElement(PrefsProvider, null, createElement(PropertyPanel, {
        tree, node: rb, onPatch: () => {},
        info: { length: 0, mass: 0.002, sectionMass: 0.002, cgX: 0, positionX: 0.3556 },
        rocketInfo: { ...info, length: rocketLength, cg: cg ?? 0.3556 - delta },
      }))));
      const b = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Auto-place rail buttons'))!;
      host.dataset.result = b.disabled ? b.title : '';
    } finally { act(() => root.unmount()); }
    host.textContent = host.dataset.result!;
  });
}
type BoundaryCase = { id: string; run: (u: UnitSelection, d: number) => string | Promise<string>; sign?: number; indices?: [number, number]; at?: 'equal-refusal' | 'inclusive'; single?: boolean };
it.each([INITIAL_UNITS, IMPERIAL_UNITS])('R12 preserves the direction of a rounded inside forward button (%j)', async units => {
  const text = await buttons(units, 0, 0.3556001, 0.8096);
  expect(text).toContain('just inside this tube');
  expect(text).not.toContain('just before this tube');
});
it.each([INITIAL_UNITS, IMPERIAL_UNITS])('R12 preserves the direction of a rounded inside aft button (%j)', async units => {
  const text = await buttons(units, 0, 0.1556, 0.6349999);
  expect(text).toContain('just inside this tube');
  expect(text).not.toContain('just after this tube');
});
const material = SURFACE_MATERIALS.find(m => m.name === 'Mylar')!;
const densityMax = Math.max(...SURFACE_MATERIALS.filter(m => m.group === material.group).map(m => m.density)) * DENSITY_RANGE_FACTOR;
const stageXml = (cg: number) => cdx('', '<SustainerLaunchWt>2</SustainerLaunchWt><SustainerCG>' + cg * 39.37 + '</SustainerCG>');
const cases: BoundaryCase[] = [
  { id: 'C01', run: (u,d) => screenEntry({ ...MOTOR_DB[0]!, totalWeightG: 100, propWeightG: 100 + d * 1000 },u) ?? '' },
  { id: 'C02', run: (u,d) => caught(() => parseMotorFile('test.eng', 'Test 24 70 P ' + (0.1+d) + ' 0.1 Test\n0 0\n1 1\n2 0', [], u)) },
  { id: 'C03', run: (u,d) => caught(() => samplesToMotorSpec({ ...MOTOR_DB[0]!, totalWeightG: 100, propWeightG: 100+d*1000 }, [{time:0,thrust:0},{time:1,thrust:1}],0,undefined,u)) },
  { id: 'C04', run: (u,d) => preflightAudit({components:[{type:'parachute',id:'p',surfaceMaterialName:material.name,surfaceDensity:densityMax+d}]},{},[],u).findings.find(f=>f.kind==='material-density')?.reason ?? '', indices:[0,2] },
  { id: 'C05', run: (u,d) => treeProblems({components:[{type:'bodytube', length:1000+d}]},u).join(' ') },
  { id: 'C06', run: (u,d) => { const p=planAxialSplit(0.1,(0.192+d)/2,{x:0.208,y:0.208,z:0.208},0,u); return p.reason.includes('usable bed')?p.reason:''; } },
  { id: 'C07', run: (u,d) => planAxialSplit(0.4,0.02,{x:0.208,y:0.208,z:0.208,spigot:0.2+d,lean:false},0,u).reason, at:'equal-refusal' },
  { id: 'C08', run: (u,d) => { const p=planAxialSplit(0.2+d,0.02,{x:0.208,y:0.208,z:0.208,spigot:0.01,lean:false},0,u);return p.fits?'':p.reason; } },
  { id: 'C09', run: (u,d) => {const n:ComponentNode={type:'centeringring',id:'r',outerRadius:0.02025+d,length:0.01}; return ringFitFor({components:[{type:'bodytube',id:'b',length:1,outerRadius:0.021,thickness:0.001,children:[n]}]},n,{outside:true,inside:false},u).notes[0]??'';} },
  { id: 'C10', run: (u,d) => {const f=JSON.parse(readFixture('open-meteo/forecast-blackrock-1190m.json')); return caught(()=>parseForecast({...f,elevation:1190.5+d},[1190],u));} },
  { id: 'C11', run: (u,d) => { const xml='<RASAeroDocument><RocketDesign><BodyTube><Length>30</Length><Diameter>3</Diameter></BodyTube><Booster><Length>15</Length><Diameter>3</Diameter><InsideDiameter>3</InsideDiameter><ShoulderLength>2</ShoulderLength><Location>'+ (d?30.0101:30) +'</Location></Booster></RocketDesign></RASAeroDocument>'; return importCdx1(xml,{units:u}).notes.find(n=>n.includes('starts at'))??'';} },
  { id: 'C12', run: (u,d) => {const xml=readFixture('Complex.Two-Stage.CDX1').replace(/<Booster1LaunchWt>[^<]+</,'<Booster1LaunchWt>'+ (4.06-d) +'<');return importCdx1(xml,{units:u}).notes.find(n=>n.includes('LESS than'))?.split('Booster: its ')[1]??'';}, sign:-1 },
  { id: 'C13', run: (u,d) => importCdx1(stageXml(20/39.37+d),{units:u}).notes.find(n=>n.includes('outside the stage'))?.split('works out to ')[1]??'' },
  { id: 'C14', run: (u,d) => reconcileIncludedMotor(marked(0.2,1),'mount',{...motor,launchMassKg:1+d},statedWeightTextFor(u))!.note!, sign:-1, at:'equal-refusal' },
  { id: 'C15', run: (u,d) => reconcileIncludedMotor(marked((0.508+d+0.408)/2),'mount',motor,statedWeightTextFor(u))!.note?.split('stage’s own CG ')[1]??'' },
  { id: 'C16', run: (u,d) => d ? fieldNoticeText('temperatureC',60+d,u,'auto',false,60):'' },
  { id: 'C17', run: scale },
  { id: 'C18', run: buttons, sign:-1, indices:[0,2] },
  { id: 'C19', run: (u,d) => groundWindAdvice(SURFACE_WIND_LIMIT_MS+d,u)??'' },
  { id: 'C20', run: (u,d) => {const f=flight(); f.series.mach=[(10+d)/100];f.series.Vs=[100];f.series.time=[0];return flightLimitAdvice(f,{maxAirspeedMs:10},'Test',undefined,u)[0]?.text??'';} },
  { id: 'C21', run: (u,d) => {const f=flight();f.summary.maxAltitude=100-d;return flightLimitAdvice(f,{armingAltitudeM:100},'Test',undefined,u)[0]?.text??'';},sign:-1,at:'inclusive' },
  ...(['rod','drogue','opening','fallback-opening','landing','booster-landing','booster-opening'] as const).map((part,i)=>({id:'C'+(22+i),run:(u:UnitSelection,d:number)=>report(u,part,d),sign:part==='rod'?-1:1,
    ...(part.includes('opening') ? { at:'inclusive' as const } : {}) })),
  { id:'C29',run:(u,d)=>importOrk(ork('<atmosphere model="extendedisa"><basetemperature>'+(333.15+d)+'</basetemperature></atmosphere>'),{units:u}).notes.find(n=>n.includes('outside the'))??'' },
  { id:'C30',run:(u,d)=>importOrk(ork('<atmosphere model="extendedisa"><basepressure>'+(110000+d*100)+'</basepressure></atmosphere>'),{units:u}).notes.find(n=>n.includes('outside the'))??'' },
  { id:'C31',run:(u,d)=>importCdx1(cdx('<Temperature>'+(140+d*1.8)+'</Temperature>'),{units:u}).notes.find(n=>n.includes('outside the'))??'' },
  { id:'C32',run:(u,d)=>importCdx1(cdx('<Pressure>'+((1100+d)/33.8639)+'</Pressure>'),{units:u}).notes.find(n=>n.includes('outside the'))??'' },
  { id:'C33',run:(u,d)=>importOrk(ork('<launchrodlength>'+(-d)+'</launchrodlength>'),{units:u}).notes.find(n=>n.includes('accepts'))??'',sign:-1 },
  // C34/C35 rings state no bore, so the mount supplies it: a stated zero
  // inner radius is a solid disc, which has no bore to refuse.
  { id:'C34',run:(u,d)=>{const offer=printOffer({type:'centeringring',length:0.01,outerRadius:0.025},{mountOuterRadius:0.025+d},null,'Printer',u);return offer.note?.split('motor mount ')[1]??'';},at:'equal-refusal' },
  { id:'C35',run:(u,d)=>{const text=componentDxf({type:'centeringring',length:0.01,outerRadius:0.025},{mountOuterRadius:0.025+d},'Boundary',dxfUnitFor(u.length))!.text;return text.split('\n').find(n=>n.includes('does not fit'))??'';},single:true },
  { id:'C36',run:async(u,d)=>rendered(u,async host=>{
    const run=buildSimRun({result:flight(),info,motor:testMotor().spec,launch:DEFAULT_CONDITIONS,rocketName:'Boundary',execMs:1,units:u});
    run.railProfile={segments:[[0,15-d,0,1]],railM:2,offsetM:0,allowance:false,thrustEnded:false};
    const root=createRoot(host);
    let text='';
    try{
      act(()=>root.render(createElement(PrefsProvider,null,createElement(SimRunDetails,{run}))));
      act(()=>[...host.querySelectorAll('button')].find(b=>b.textContent?.includes('Show all details'))!.click());
      text=[...host.querySelectorAll('tr')].find(r=>r.cells[0]?.textContent==='Rail needed')!.cells[1]!.textContent!;
    }finally{act(()=>root.unmount());}
    host.textContent=text;
  }),single:true,at:'inclusive' },
  { id:'C37',run:(u,d)=>{
    const tree:RocketTree={components:[{type:'stage',id:'s',nozzleExitDiameter:0.029+5e-5+d,children:[{type:'innertube',id:'m',length:0.1}]}]};
    const w=nozzleOversize(tree,[['m',testMotor()]])[0];
    return w?nozzleOversizeText(w,m=>noticeQuantity('motorDimensions',m,u)):'';
  }},
  { id:'C38',run:(u,d)=>{
    if(!d)return '';
    const w=formatWarning({key:'HighSpeedDeployment',message:'',quantity:{kind:'velocity',value:20+d},sources:[]},u);
    return w.label.split('fixed ')[1]!.split(' — ')[0]+'; '+w.detail;
  },sign:-1},
  { id:'C39',run:(u,d)=>{
    const notes:string[]=[];
    parseRse('<engine-database><engine-list><engine code="Boundary" mfg="Test" dia="29" len="120" initWt="100" propWt="50" delays="5" auto-calc-mass="0"><data>'
      +'<eng-data t="0" f="0" m="'+(101+d*1000)+'"/><eng-data t="0.5" f="60" m="40"/><eng-data t="1" f="0" m="20"/>'
      +'</data></engine></engine-list></engine-database>',notes,u);
    return notes.find(n=>n.includes('neither its loaded mass'))??'';
  }},
  { id:'C40',run:(u,d)=>planAxialSplit(0.2-d,0.02,{x:0.208,y:0.208,z:0.208},0,u).reason,at:'inclusive',sign:-1},
  { id:'C41',run:(u,d)=>[
    ...([['launchrodangle',30,'Rod angle'],['launchlatitude',90,'Latitude'],['launchlongitude',180,'Longitude']] as const).map(([tag,bound,field])=>
      importOrk(ork('<'+tag+'>'+(bound+d/100)+'</'+tag+'>'),{units:u}).notes.find(n=>n.includes(field+' field'))??''),
    importCdx1(cdx('<RodAngle>'+(30+d/100)+'</RodAngle>'),{units:u}).notes.find(n=>n.includes('Rod angle field'))??'',
  ].filter(Boolean).join(' || ')},
  { id:'C42',run:(_u,d)=>{const p=parseCoordinates(String(90+d)+' 0');return p&&!p.ok?p.error:'';}},
  { id:'C43',run:(u,d)=>importOrk(ork('<timestep>'+(0.01-d/10000)+'</timestep>'),{units:u}).notes.find(n=>n.includes('below the'))??'',sign:-1},
  { id:'C44',run:(u,d)=>importOrk(ork('<timestep>'+(0.05-d/100)+'</timestep>'),{units:u}).notes.find(n=>n.includes('It is being flown'))??'',sign:-1},
  { id:'C45',run:(u,d)=>{
    const imported={name:'Boundary',tree:{components:[]},notes:[],motors:{},sourceFormat:'ork' as const};
    const ctx={launch:{...DEFAULT_CONDITIONS,timeStepS:0.05-d/100},text:statedWeightTextFor(u)};
    const p=planImport({...imported,launch:{timeStepS:0.05}},{working:{},configs:{}},ctx);
    const q=planImport(imported,{working:{},configs:{}},ctx);
    const restored=d?designNotices({error:null,buildFailed:false,motorFailures:[],tree:{components:[]},assigned:[],
      restoredByOlderBuild:false,timeStepMigrated:true,timeStepMigratedFrom:0.05-d/100,padMassNote:null,fileNote:null,
      runsCapped:{evicted:0,unsaved:0},lengthText:m=>String(m)},
      {simError:()=>{},staleSession:()=>{},timeStep:()=>{},padMassNote:()=>{},fileNote:()=>{},runsCapped:()=>{}})[0]!.text:'';
    return [p.note.text.includes('simulation time step') ? p.note.text : '',q.note.text.includes('simulation time step') ? q.note.text : '',restored].filter(Boolean).join(' || ');
  }},
  { id:'C46',run:async(_u,d)=>{
    // Call the module Worker directly. No Wrangler, server or network listener.
    const {worker}=await import('../../../api/src/index.js');
    const {unzipSync,strFromU8,zipSync,strToU8}=await import('fflate');
    const bytes=new Uint8Array(readFileSync(new NodeURL('./__fixtures__/reference.ork',import.meta.url)));
    const xml=strFromU8(unzipSync(bytes)['rocket.ork']!).replace('creator="OpenRocket 24.12"','creator="MMRocket Sim"')
      .replace('<simulations>','<simulations><simulation status="notsimulated"><name>Step test</name><conditions><configid>b61d1bfe-9ef0-4607-9756-382bf2bab907</configid><timestep>'+(0.05-d/100)+'</timestep></conditions></simulation>');
    try {
      const response=await worker.fetch(new Request('https://local/experimental/fly?filename=boundary.ork',
        {method:'POST',body:zipSync({'rocket.ork':strToU8(xml)})}),{}, {waitUntil:()=>{}});
      const data=await response.json() as {notes:{api:string[]}};
      expect(response.status).toBe(200);
      return data.notes.api[0]??'';
    } finally {
      const {jsXmlParser}=await import('./xmlParseJs.js');
      setXmlParser(process.env['VITEST_XML_PARSER']==='js'?jsXmlParser:null);
    }
  }},
  { id:'C47',run:(u,d)=>{
    const first=reconcileIncludedMotor(marked(0.4),'mount',motor,statedWeightTextFor(u))!;
    return reconcileIncludedMotor(first.tree,'mount',{...motor,launchMassKg:1+d*10},statedWeightTextFor(u))?.note??'';
  }},
  { id:'C48',run:(_u,d)=>[1.05+d,0.95-d].map(factor=>impulseNote({designation:'Boundary',totImpulseNs:0.32},
    [{time:0,thrust:0},{time:1,thrust:0.32*factor},{time:2,thrust:0}])??'').filter(Boolean).join(' || ')},
];
export const comparisonProducerIds = cases.map(c=>c.id);
it('does not hide a nonfinite impulse integral as threshold roundoff', () => {
  expect(impulseNote({designation:'Overflow',totImpulseNs:1},
    [{time:0,thrust:Number.MAX_VALUE},{time:2,thrust:Number.MAX_VALUE}])).not.toBeNull();
});
it('requires inventory review and a boundary case or scope exemption for new producers', () => {
  expect(comparisonProducerIds).toEqual(Array.from({length:48},(_,i)=>'C'+String(i+1).padStart(2,'0')));
  expect({
    app: comparisonCensus(fileURLToPath(new NodeURL('../', import.meta.url))),
    api: comparisonCensus(fileURLToPath(new NodeURL('../../../api/src/', import.meta.url))),
  }).toEqual(reviewedCensus);
}, 30_000);
it.each(cases.flatMap(c=>[INITIAL_UNITS,IMPERIAL_UNITS,
  ...(c.id==='C36'?[{...INITIAL_UNITS,velocity:'km/h'}]:[]),
  ...(c.id==='C38'?['km/h','mph','kt'].map(velocity=>({...INITIAL_UNITS,velocity})):[]),
].map(units=>({ ...c,units }))))('$id at and just past its boundary (%j)',async c=>{
  const at=await c.run(c.units,0);
  if (!c.at && c.id!=='C35') expect(at,c.id+' at boundary').toBe('');
  else expect(at,c.id+' at boundary').not.toBe('');
  if(c.id==='C36') expect(at).toContain('Reaches');
  if(c.id==='C40') expect(at).toContain('Fits upright');
  if (['C24','C25','C28'].includes(c.id)) expect(at).toContain('fast opening');
  const text=await c.run(c.units,1e-6);
  expect(text,c.id+' past boundary').not.toBe('');
  // The current policy uses field precision, a six-digit ceiling, and words
  // for genuine differences that display alike. Every producer is exercised.
  for (const match of text.matchAll(/[-+−]?\d[\d.,]*(?:e[+-]?\d+)?/g)) {
    const significant = match[0].split('e')[0]!.replace(/[^0-9]/g,'').replace(/^0+/,'').replace(/0+$/,'');
    expect(significant.length,text).toBeLessThanOrEqual(6);
  }
  const semantic = /just (above|below|over|under|beyond|before|after|outside)|slightly (more|less|LESS|different|above|finer)|changed slightly/.test(text);
  if(c.id==='C47') {
    for(const kind of ['mass','CG']) {
      const part=text.match(new RegExp('its '+kind+' override (.+?)(?: from|, and|\\.$)'))![1]!;
      expect(part,text).toMatch(/changed slightly \(now /);
      expect(part).not.toContain('→');
    }
    return;
  }
  if(c.id==='C48') {
    for(const part of text.split(' || ')) {
      const values=[...part.matchAll(/([\d.]+) N·s/g)].map(m=>Number(m[1]));
      expect(values).toHaveLength(2);
      expect((values[0]!-values[1]!)*(part.includes('read high')?1:-1),part).toBeGreaterThan(0);
      const percent=Number(/([-+][\d.]+) %/.exec(part)![1]);
      expect(100*(values[0]!/values[1]!-1),part).toBeCloseTo(percent,1);
    }
    return;
  }
  if(c.id==='C36'){expect(text).toContain('15 m/s');expect(text).toContain('Did not reach');return;}
  if(['C24','C25','C28'].includes(c.id)) expect(text).toContain('hard opening');
  // When a bound supplies the number for a slight difference, it appears
  // once in that comparison, including the counterpart. Never circular copy.
  if (semantic) {
    for (const part of text.split(' || ')) {
      const physical=[...part.matchAll(/([-+−\d.,e]+ [^\s()[\]]+) [([]([-+−\d.,e]+ [^\s()[\]]+)[)\]]/g)].map(m=>m[1]+' ('+m[2]+')');
      expect(new Set(physical).size,part).toBe(physical.length);
    }
    expect(text).not.toMatch(/just (above|below).+just (above|below)/);
    return;
  }
  if(['C41','C42','C43','C44','C45','C46'].includes(c.id)) {
    const values=[...text.matchAll(/([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?) s/g)].map(m=>Number(m[1]));
    if(c.id==='C42'){expect(text).toContain('outside');return;}
    if(c.id==='C41'){expect(text).toContain('maximum');return;}
    expect(values.length,text).toBeGreaterThan(1);
    expect(values[0],text).not.toBe(values[1]);
    return;
  }
  if(c.id==='C35') {
    const m=text.match(/motor mount dia ([\d.]+) (mm|in) does not fit this ring's ([\d.]+) (mm|in) OD/)!;
    expect(m,text).not.toBeNull();expect(Number(m[1])).toBeGreaterThan(Number(m[3]));return;
  }
  const p=[...text.matchAll(/([-+\d.,e]+) ([^\s()[\]]+) [([]([-+\d.,e]+) ([^\s()[\]]+)[)\]]/g)];
  const [a,b]=c.indices??[0,1];
  expect(p.length,text).toBeGreaterThan(Math.max(a,b));
  const differences = [1,3].map(k => {
    const number=(s:string)=>Number(s.replaceAll(',',''));
    return (number(p[a]![k]!)-number(p[b]![k]!))*(c.sign??1);
  });
  expect(differences.every(d=>d>=0),text).toBe(true);
  expect(differences.some(d=>d>0),text).toBe(true);
}, 120_000);

it.each([INITIAL_UNITS, IMPERIAL_UNITS])('R9 rail-button aft-end refusal follows selected units (%j)', async units => {
  const text = await buttons(units, 0, 0.57);
  expect(text).toContain(units.length === 'in' ? 'placed 1 in (25.4 mm) from the aft end' : 'placed 25.4 mm (1 in) from the aft end');
  expect(text).not.toContain('within an inch');
});
it.each([INITIAL_UNITS, IMPERIAL_UNITS, {...INITIAL_UNITS, velocity:'mph'}])('R9 unrecovered high-power booster reports its measured speed (%j)', units => {
  for (const landing of [6.2, SAFETY.maxLandingRate + 1e-4]) {
  const booster=flight(20,1,landing);
  booster.events=booster.events.filter(e=>e.type!=='RECOVERY_DEVICE_DEPLOYMENT');
  const main=flight();
  const run=buildSimRun({result:{...main,branches:[
    {name:'Sustainer',events:main.events,series:main.series},
    {name:'Booster',events:booster.events,series:booster.series},
  ]},info,motor:testMotor().spec,launch:DEFAULT_CONDITIONS,rocketName:'Boundary',execMs:1,units,
    stageMotorInfo:{Booster:{label:'Test',highPower:true}}});
  const text=commentsOf(run).find(c=>c.text.includes('Booster has NO recovery'))!.text;
  expect(text).toContain(noticeQuantity('velocity',landing,units));
  expect(text).not.toMatch(/just (above|below)/);
  }
});
it.each(cases.filter(c=>['C01','C02','C03','C04','C05','C19','C20','C22','C26','C33','C37','C43','C44','C46'].includes(c.id)))('$id does not produce a notice for residue alone',async c=>{
    expect(await c.run(INITIAL_UNITS,1e-15)).toBe('');
  },120_000);

it.each(cases.filter(c=>['C07','C14','C34','C40'].includes(c.id)))('$id R9 names an equal boundary only once',async c=>{
  const text=await c.run(INITIAL_UNITS,0);
  const values=[...text.matchAll(/([-+−\d.,e]+ [^\s()[\]]+) [([]([-+−\d.,e]+ [^\s()[\]]+)[)\]]/g)].map(m=>m[1]+' ('+m[2]+')');
  expect(values.length,text).toBeGreaterThan(0);
  expect(new Set(values).size,text).toBe(values.length);
});
it('C36 R9 reaches the rail target within residue', async()=>{
  expect(await cases.find(c=>c.id==='C36')!.run(INITIAL_UNITS,1e-15)).toContain('Reaches');
});

it('R9 caps impulse percentages and retains small nonzero certified impulse',()=>{
  const text=impulseNote({designation:'Small',totImpulseNs:1e-7},
    [{time:0,thrust:0},{time:1,thrust:1.23456789},{time:2,thrust:0}])!;
  expect(text).toContain('1e-7 N·s it is certified for');
  for(const m of text.matchAll(/[-+]?\d[\d.,]*(?:e[+-]?\d+)?/g)) {
    expect(m[0].split('e')[0]!.replace(/[^0-9]/g,'').replace(/^0+/,'').replace(/0+$/,'').length,text).toBeLessThanOrEqual(6);
  }
});
