export interface MotorSample { time: number; thrust: number }
export interface RepairedCurve {
  samples: MotorSample[];
  repairs: string[];
  /** Source indices for surviving samples and their parallel mass/CG arrays. */
  keptIndices: number[];
}
export declare const MAX_MOTOR_THRUST_N: number;
export declare function sampleListProblem(samples: unknown): string | null;
export declare function repairSamples(samples: readonly MotorSample[]): RepairedCurve;
export declare function flownCurve(samples: readonly MotorSample[]): { samples: MotorSample[]; repairs: string[] };
