// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { importRkt } from './rocksimFile.js';
import { findNode } from '../tree/treeModel.js';

it.each(['duplicate', 'missing', 'empty-collision'])('J4 r3 resolved XML mount survives %s serials', scenario => {
  const body = (name: string, serial: string, bore: number) => `<BodyTube><Name>${name}</Name>${serial}<OD>60</OD><ID>${bore}</ID><Len>500</Len><IsInsideTube>1</IsInsideTube><RadialLoc>40</RadialLoc><IsMotorMount>1</IsMotorMount></BodyTube>`;
  const set = (serial: string, code: string) => `<EngineSet><EngineCode>${code}</EngineCode><EngineMfg>Home</EngineMfg><MountSerialNo>${serial}</MountSerialNo><EngineCount>1</EngineCount><IgnitionDelay>0</IgnitionDelay><EjectionDelay>5</EjectionDelay></EngineSet>`;
  const duplicate = scenario === 'duplicate';
  const parts = duplicate ? body('First', '<SerialNo>7</SerialNo>', 29) + body('Second', '<SerialNo>7</SerialNo>', 54)
    : (scenario === 'empty-collision' ? body('First', '<SerialNo/>', 29) : '') + body('Second', '', 54);
  const sets = duplicate ? set('7', 'A') + set('7', 'B') : set('-1', 'B');
  const result = importRkt(`<RockSimDocument><FileVersion>4</FileVersion><DesignInformation><RocketDesign><StageCount>1</StageCount><UseKnownMass>1</UseKnownMass><Stage3Mass>100</Stage3Mass><Stage3Parts><BodyTube><OD>160</OD><ID>158</ID><Len>600</Len><AttachedParts>${parts}</AttachedParts></BodyTube></Stage3Parts><SimulationResults><Mass0>200</Mass0><TimeToBurnout>2</TimeToBurnout><Stage3Engines>${scenario === 'empty-collision' ? set('-1', 'A') : ''}${sets}</Stage3Engines></SimulationResults></RocketDesign></DesignInformation></RockSimDocument>`);
  const refs = Object.values(result.configs[0]!.motors);
  // Since J5's S1b-1 (accepted 19 Nov) a duplicated MountSerialNo refuses that configuration's motors rather than guessing.
  expect(refs.map(r => r.matchContext?.mountBoreMm).sort()).toEqual(duplicate ? [] : scenario === 'empty-collision' ? [29, 54] : [54]);
  for (const [id, ref] of Object.entries(result.configs[0]!.motors)) {
    expect(ref.matchContext?.mountBoreMm).toBe(findNode(result.tree, id)!.name === 'First' ? 29 : 54);
  }
  if (scenario === 'missing') expect(refs[0]!.matchContext?.physical?.motorMassG).toBe(100);
});

it.each(['stale', 'duplicate'])('J4 S1b-g2 uses the resolved active mount bore with an inactive %s serial', scenario => {
  const body = (serial: string, bore: number) => `<BodyTube><Name>Mount</Name><SerialNo>${serial}</SerialNo><OD>${bore + 2}</OD><ID>${bore}</ID><Len>500</Len><IsInsideTube>1</IsInsideTube><IsMotorMount>1</IsMotorMount></BodyTube>`;
  const xml = `<RockSimDocument><FileVersion>4</FileVersion><DesignInformation><RocketDesign><Name>T</Name><StageCount>1</StageCount>
    <Stage3Parts>${body('active', 54)}</Stage3Parts><Stage2Parts>${body(scenario === 'stale' ? 'inactive' : 'active', 38)}</Stage2Parts>
    <Stage1Parts/><SimulationResults><Stage3Engines><EngineSet><EngineCode>J360SK</EngineCode><EngineMfg>CTI</EngineMfg>
    <MountSerialNo>${scenario === 'stale' ? 'inactive' : 'active'}</MountSerialNo><EngineCount>1</EngineCount><EjectionDelay>10</EjectionDelay>
    </EngineSet></Stage3Engines></SimulationResults></RocketDesign></DesignInformation></RockSimDocument>`;
  const result = importRkt(xml);
  const refs = [...Object.values(result.motors), ...result.configs.flatMap(c => Object.values(c.motors))];
  expect(refs.length).toBeGreaterThan(0);
  for (const ref of refs) expect(ref.matchContext?.mountBoreMm).toBe(54);
});
