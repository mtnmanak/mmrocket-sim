/** Ambient types for the vendored TeaVM engine artifact (see engine-java/). */
declare module '*orkengine.mjs' {
  export function reset(): void;
  export function newRocket(): number;
  export function buildRocket(treeJson: string): number;
  export function setMotorById(
    rocket: number, componentId: string, designation: string, diameter: number,
    length: number, times: number[], thrusts: number[], masses: number[],
    cgX: number, ejectionDelay: number): void;
  export function addNoseCone(
    rocket: number, length: number, aftRadius: number,
    thickness: number, shape: string, materialDensity: number): number;
  export function addBodyTube(
    rocket: number, length: number, outerRadius: number,
    thickness: number, materialDensity: number): number;
  export function addTrapezoidFins(
    parent: number, finCount: number, rootChord: number, tipChord: number,
    sweep: number, height: number, thickness: number, materialDensity: number): number;
  export function addInnerTube(
    parent: number, length: number, outerRadius: number,
    thickness: number, materialDensity: number): number;
  export function addParachute(parent: number, diameter: number, dragCoefficient: number): number;
  export function setMotor(
    rocket: number, mount: number, designation: string, diameter: number, length: number,
    times: number[], thrusts: number[], masses: number[], cgX: number, ejectionDelay: number): void;
  export function getStaticInfo(rocket: number): string;
  export function getComponentInfo(rocket: number, componentId: string): string;
  export function simulate(
    rocket: number, launchRodLength: number, launchRodAngle: number,
    windAverage: number, windStdDeviation: number, launchAltitude: number,
    timeStep: number): string;
  export function simulateJson(rocket: number, optionsJson: string): string;
  export function main(): void;
}
