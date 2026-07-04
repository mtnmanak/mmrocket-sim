/** Shared CSV cell escaping (RFC 4180 quoting) for the export services. */
export function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
