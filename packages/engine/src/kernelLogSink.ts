/**
 * Routes the TeaVM kernel's stdout/stderr away from console.info/console.error.
 *
 * WHY THIS FILE EXISTS: OpenRocket's core logs at INFO through the whole
 * simulation ("Starting simulation of branch", "Igniting motor", …). TeaVM's
 * runtime wires Java's System.out/System.err to console.info/console.error, so
 * every single flight wrote several lines to the browser console AS ERRORS —
 * noise that buries the real errors a beta tester would need to report, and
 * false positives for anything watching console.error.
 *
 * TeaVM's runtime picks its output sinks with
 *   $rt_putStdout = typeof $rt_putStdoutCustom === "function" ? … : console.info
 *   $rt_putStderr = typeof $rt_putStderrCustom === "function" ? … : console.error
 * evaluated ONCE, at module-evaluation time, reading bare (global) identifiers.
 * So these globals must be installed BEFORE vendor/orkengine.mjs evaluates —
 * which is why this is a side-effect module imported above it in orkEngine.ts
 * (ES modules evaluate in import order) rather than plain code in that file.
 *
 * The kernel output is not thrown away: it is kept in a ring buffer that
 * `kernelLog()` returns, so a diagnostic can still show what the kernel said,
 * and `setKernelLogEcho(true)` restores live console output while debugging.
 */

const RING = 200;
const lines: string[] = [];
let echo = false;

function record(stream: 'out' | 'err', msg: string): void {
  // TeaVM hands us whole lines already (its $rt_createOutputFunction buffers
  // until \n), but guard against a trailing newline either way.
  const text = msg.replace(/\n$/, '');
  if (!text) return;
  lines.push(`[${stream}] ${text}`);
  if (lines.length > RING) lines.splice(0, lines.length - RING);
  if (echo) console.debug(`[ork-kernel] ${text}`);
}

/** The last few hundred lines the kernel wrote, oldest first. */
export function kernelLog(): string[] {
  return lines.slice();
}

/** Drop everything buffered so far (e.g. before a run you want to inspect). */
export function clearKernelLog(): void {
  lines.length = 0;
}

/** Mirror kernel output to console.debug as it happens. Off by default. */
export function setKernelLogEcho(on: boolean): void {
  echo = on;
}

// Install before the kernel module evaluates. Assigning onto globalThis is what
// makes TeaVM's bare-identifier `typeof $rt_putStdoutCustom` resolve to these:
// the vendored module never declares those names itself, so the lookup reaches
// the global scope.
const g = globalThis as Record<string, unknown>;
if (typeof g.$rt_putStdoutCustom !== 'function') {
  g.$rt_putStdoutCustom = (msg: string) => record('out', String(msg));
}
if (typeof g.$rt_putStderrCustom !== 'function') {
  g.$rt_putStderrCustom = (msg: string) => record('err', String(msg));
}
