/** N020: references into the shipped guide glossary, never a second set of definitions. */
const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const components: Record<string, string> = {
  stage: 'Stage / serial staging', nosecone: 'Nose cone / nose profile', bodytube: 'Body tube',
  transition: 'Transition', trapezoidfinset: 'Trapezoidal fin', ellipticalfinset: 'Elliptical fin',
  freeformfinset: 'Freeform fin', tubefinset: 'Tube fin', innertube: 'Inner tube / motor mount',
  tubecoupler: 'Tube coupler', centeringring: 'Centering ring', bulkhead: 'Bulkhead',
  engineblock: 'Engine block / thrust ring', launchlug: 'Launch lug', railbutton: 'Rail button',
  parachute: 'Canopy', streamer: 'Streamer', shockcord: 'Shock cord / shroud lines',
  masscomponent: 'Mass component / mass object', fairing: 'Camera shroud / fairing',
  protuberance: 'Protuberance', podset: 'Pod set', parallelstage: 'Parallel booster / strap-on booster',
};
const fields: Record<string, string> = {
  name: 'Component / part / component tree', color: 'Component display color',
  length: 'Geometry length / width / height', width: 'Geometry length / width / height',
  height: 'Geometry length / width / height', thickness: 'Wall thickness / fin thickness',
  radius: 'Diameter / radius / bore', outerRadius: 'Diameter / radius / bore',
  foreRadius: 'Diameter / radius / bore', aftRadius: 'Diameter / radius / bore',
  outerDiameter: 'Rail button dimensions', innerDiameter: 'Rail button dimensions',
  totalHeight: 'Rail button dimensions', baseHeight: 'Rail button dimensions',
  flangeHeight: 'Rail button dimensions', screwHeight: 'Rail button dimensions',
  shape: 'Nose cone / nose profile', shapeParameter: 'Shape parameter', filled: 'Solid (filled)',
  flipped: 'Boattail', shoulderRadius: 'Shoulder / coupler', shoulderLength: 'Shoulder / coupler',
  shoulderThickness: 'Shoulder / coupler', shoulderCapped: 'Shoulder end capped',
  foreShoulderRadius: 'Shoulder / coupler', foreShoulderLength: 'Shoulder / coupler',
  foreShoulderThickness: 'Shoulder / coupler', foreShoulderCapped: 'Shoulder end capped',
  aftShoulderRadius: 'Shoulder / coupler', aftShoulderLength: 'Shoulder / coupler',
  aftShoulderThickness: 'Shoulder / coupler', aftShoulderCapped: 'Shoulder end capped',
  density: 'Material density', material: 'Material density', filletDensity: 'Material density',
  finish: 'Surface finish / roughness', motorMount: 'Inner tube / motor mount',
  caseAirframe: 'Minimum-diameter / sub-minimum rocket', motorOverhang: 'Motor overhang',
  maxMotorLength: 'Max motor length', finCount: 'Fin set', cant: 'Cant angle',
  rotation: 'Fin rotation', rootChord: 'Chord / root chord / tip chord',
  tipChord: 'Chord / root chord / tip chord', sweep: 'Sweep', crossSection: 'Airfoil / fin cross-section',
  airfoilSection: 'Airfoil / fin cross-section', airfoilLeDiamond: 'Edge chamfer length',
  airfoilTeDiamond: 'Edge chamfer length', finLeRadius: 'LE bluntness radius',
  tabHeight: 'Fin tab / through-the-wall tab', tabLength: 'Fin tab / through-the-wall tab',
  tabOffset: 'Fin tab / through-the-wall tab', tabOffsetMethod: 'Fin tab / through-the-wall tab',
  filletRadius: 'Root fillet', cluster: 'Cluster', clusterScale: 'Cluster', clusterRotation: 'Cluster',
  radialPosition: 'Axial / radial', radialDirection: 'Angle around body / clock angle',
  radialDistance: 'Radial reference', radiusOffset: 'Radial reference', radiusMethod: 'Radial reference',
  angleOffset: 'Angle around body / clock angle', angleMethod: 'Angle reference',
  instanceCount: 'Instance', instanceSeparation: 'Instance', count: 'Protuberance',
  diameter: 'Canopy', spillHoleDiameter: 'Spill hole / vent', lineCount: 'Shock cord / shroud lines',
  lineLength: 'Shock cord / shroud lines', cordLength: 'Shock cord / shroud lines',
  packedLength: 'Packed diameter / packed length', packedRadius: 'Packed diameter / packed length',
  cd: 'Cd / CD / drag coefficient', cdFrontal: 'Drag class', dragClass: 'Drag class', plateAngle: 'Plate angle',
  deployEvent: 'Deployment / deployment trigger', deployAltitude: 'Deployment / deployment trigger',
  deployDelay: 'Deployment / deployment trigger', separationEvent: 'Separation event / separation delay',
  separationAltitude: 'Separation event / separation delay', separationDelay: 'Separation event / separation delay',
  nozzleExitDiameter: 'Nozzle exit diameter', mass: 'Mass / weight', massComponentType: 'Mass component / mass object',
  stripLength: 'Streamer', stripWidth: 'Streamer', fairingForeShape: 'Camera shroud / fairing',
  fairingAftShape: 'Camera shroud / fairing', conformal: 'Conformal',
  overrideMass: 'Mass override / CG override', overrideCGX: 'Mass override / CG override',
  overrideCD: 'Cd override', overrideSubcomponentsMass: 'Mass override / CG override',
  overrideSubcomponentsCG: 'Mass override / CG override', overrideSubcomponentsCD: 'Cd override',
  positionMethod: 'Position relative to / Offset', positionOffset: 'Position relative to / Offset',
  lineDensity: 'Material density', surfaceDensity: 'Material density',
};
export function componentTerm(type: string): string | undefined {
  const title = components[type];
  return typeof title === 'string' ? slug(title) : undefined;
}
export function fieldTerm(type: string, key: string): string | undefined {
  const title = type === 'transition' && key === 'shape' ? 'Transition'
    : type !== 'railbutton' && key === 'innerDiameter' ? 'Diameter / radius / bore'
    : type === 'railbutton' && key === 'instanceSeparation' ? 'Rail button dimensions'
    : type === 'railbutton' && key === 'instanceCount' ? 'Rail button'
    : type === 'centeringring' && key === 'length' ? 'Wall thickness / fin thickness'
    : fields[key];
  return typeof title === 'string' ? slug(title) : undefined;
}
