/** Reader/writer fallback names are sentinels, not motor manufacturers. */
export function namedMotorManufacturer(manufacturer: string | undefined): string | null {
  const maker = manufacturer?.trim();
  return maker && !/^(unknown|custom)$/i.test(maker) ? maker : null;
}
