/** Absolute so release links also work when the app is embedded. */
export const RELEASES_URL = 'https://mmrsim.mountainmanrockets.com/releases/';

/** Shared by release-page section IDs and links from the app. */
export function releaseAnchor(version) {
  return `v${version}`;
}
