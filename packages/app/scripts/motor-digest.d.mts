/** Types for motor-digest.mjs — the only surface tsc sees (no allowJs). Keep in step: motor-digest.test.mjs checks. */
export interface DigestDataType {
  readonly order: number;
  readonly multiplier: number;
}
export declare const DIGEST_DATA_TYPE: {
  readonly TIME_ARRAY: DigestDataType;
  readonly MASS_SPECIFIC: DigestDataType;
  readonly MASS_PER_TIME: DigestDataType;
  readonly CG_SPECIFIC: DigestDataType;
  readonly CG_PER_TIME: DigestDataType;
  readonly FORCE_PER_TIME: DigestDataType;
};
export declare class MotorDigest {
  update(type: DigestDataType, values: ArrayLike<number>): void;
  getDigest(): string;
}
export declare function md5Hex(data: Uint8Array): string;
export declare function digestRasp(text: string): string[];
export declare function digestRse(text: string): string[];
export declare function digestMotorFile(text: string, format?: string | null): string[];
