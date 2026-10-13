import type { AeroDiagnostics, StaticInfo } from '@online-openrocket/engine';

/** N022: retain the kernel's reported CP and worst-plane convention, in SI. */
export function rollPlaneAnalysis(diagnostics: AeroDiagnostics, info: Pick<StaticInfo, 'cg' | 'refDiameter'>) {
  const defined = ([x, , , cna]: AeroDiagnostics['cp']) => x !== null && Number.isFinite(x)
    && cna !== null && Number.isFinite(cna) && Math.abs(cna) > 1e-8;
  const cp = diagnostics.cpByTheta.map((plane) => defined(plane) ? plane[0] : null);
  const margin = cp.map((x) => x !== null && Number.isFinite(info.cg)
    && Number.isFinite(info.refDiameter) && info.refDiameter > 0 ? (x - info.cg) / info.refDiameter : null);
  // Match the full coordinate, not a new minimum search: the kernel owns ties.
  const worstIndex = defined(diagnostics.worstCP) && diagnostics.worstCP[3]! > 1e-8
    ? diagnostics.cpByTheta.findIndex((plane) => defined(plane)
    && plane.every((v, i) => v === diagnostics.worstCP[i])) : -1;
  const noLift = diagnostics.cpByTheta.map((plane) => plane[3] !== null && Number.isFinite(plane[3]) && Math.abs(plane[3]) <= 1e-8);
  return { angles: cp.map((_x, i) => i), cp, margin, noLift, worstAngle: worstIndex >= 0 ? worstIndex : null };
}
