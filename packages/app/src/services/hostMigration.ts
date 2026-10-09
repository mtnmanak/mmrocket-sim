/**
 * v0.047 rename: the app moved from openrocket.mountainmanrockets.com to
 * mmrsim.mountainmanrockets.com. The old origin served the app for a grace
 * period (a 301 would have stranded installed PWAs mid-update: workbox
 * precache fetches fail on cross-origin redirects), during which it had to
 * stop behaving like a PWA and tell the user where the app lives now. That
 * period ended on 2026-08-21, when the old origin began 301-redirecting here
 * (a Cloudflare zone rule), so this layer no longer runs on it; whether to
 * remove it is a separate decision. localStorage is
 * origin-scoped, so autosaved work does NOT follow the move — users export
 * .ork files and reopen them at the new address.
 */
export const CANONICAL_HOST = 'mmrsim.mountainmanrockets.com';

const RETIRED_HOSTS = ['openrocket.mountainmanrockets.com'];

export function isRetiredHost(hostname: string): boolean {
  return RETIRED_HOSTS.includes(hostname);
}

/** Unregister every service worker and drop its caches so the retired
 * origin always loads fresh from the network. Best-effort: never throws. */
export async function dismantlePwa(): Promise<void> {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = (await globalThis.caches?.keys?.()) ?? [];
    await Promise.all(keys.map((k) => globalThis.caches.delete(k)));
  } catch {
    /* a broken cleanup must never block the app */
  }
}
