interface ConfigContent {
  id: string;
  name: string | null;
  motors: Record<string, unknown>;
  unmatchedRefs?: Record<string, unknown>;
  stageActiveness?: Record<string, boolean>;
  padMassKg?: number;
}

/** Dry saves carry launch conditions in a simulation, but need no empty panel row. */
export function isLoneEmptyConfig(
  configs: readonly ConfigContent[], hasResult: (id: string) => boolean,
): boolean {
  const lone = configs.length === 1 ? configs[0] : undefined;
  return !!lone && !lone.name?.trim() && Object.keys(lone.motors).length === 0
    && Object.keys(lone.unmatchedRefs ?? {}).length === 0
    && !Object.values(lone.stageActiveness ?? {}).includes(false)
    // A v0.116/v0.117 file hangs its weighed pad mass on this configuration;
    // dropping it would lose the value under a note promising to keep it.
    && lone.padMassKg === undefined
    && !hasResult(lone.id);
}
