/** Preserve exchange identities while disclosing the two upstream density slips. */
export function elasticCordNote(name: unknown, density: number | undefined): string | undefined {
  if (!((name === 'Elastic cord (flat 19 mm, 3/4 in)' && density === 0.0012)
    || (name === 'Elastic cord (flat 25 mm, 1 in)' && density === 0.0016))) return undefined;
  return 'This upstream elastic-cord material has a suspect low density. It can understate harness mass and lead to a canopy that is too small. '
    + 'Choose the matching “Elastic cord, corrected” material, or edit a saved entry in My materials to use a measured line density, then pick it here. Existing designs keep their stated density.';
}
