import { CANONICAL_HOST, isRetiredHost } from '../services/hostMigration.js';

/** Persistent (not dismissible) on purpose, like the autosave warning:
 * while the user is on the retired origin their autosaves are stranded
 * there, so the notice must survive until they actually move. */
export function MovedNotice({ hostname }: { hostname: string }) {
  if (!isRetiredHost(hostname)) return null;
  return (
    <div className="file-note autosave-warn" role="alert">
      📦 This app has moved to{' '}
      <a href={`https://${CANONICAL_HOST}/`}>{CANONICAL_HOST}</a> — update your
      bookmark, and reinstall the home-screen app from the new address.
      Designs autosaved in this browser stay with the old address: export your
      design (Save / Export → .ork) and open it at the new one.
    </div>
  );
}
