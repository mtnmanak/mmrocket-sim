import { CHANGELOG } from '../changelog.js';
import { RELEASES_URL, releaseAnchor } from '../releaseLinks.mjs';
import { APP_VERSION } from '../version.js';
import { useBackdropClose, useDialog } from './useDialog.js';

/**
 * What's-new dialog, opened from the version badge in the header. App.tsx
 * lazy-loads it, and with it changelog.ts, which nothing else in the app
 * imports (audit 2026-09-22, row 510).
 */
export function ChangelogDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useDialog(onClose);
  const backdrop = useBackdropClose(onClose);
  const newest = CHANGELOG[0]!;
  return (
    <div className="prefs-overlay" role="presentation" {...backdrop}>
      <div className="prefs-dialog panel" role="dialog" aria-modal="true" aria-label="Changelog"
        ref={dialogRef} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h2 style={{ flex: 1 }}>What's new — v{APP_VERSION} <span className="version-beta">beta</span></h2>
          <button className="file-btn" onClick={onClose} aria-label="Close changelog">✕ Close</button>
        </div>
        <section className="changelog-entry">
          <h3>
            v{newest.version}
            <span className="changelog-date">{newest.date}</span>
          </h3>
          <p className="changelog-title">{newest.title}</p>
          <ul>
            {(newest.summary ?? newest.items).map((item, i) => <li key={i}>{item}</li>)}
          </ul>
          <p><a href={`${RELEASES_URL}#${releaseAnchor(newest.version)}`} target="_blank" rel="noopener noreferrer">
            Full release notes for v{newest.version}
          </a></p>
          <p>Release notes open in a new tab.</p>
        </section>
        <section className="changelog-entry">
          <h3>Earlier releases</h3>
          {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- Safari drops list semantics under list-style: none. */}
          <ul className="changelog-earlier" role="list">
            {CHANGELOG.slice(1, 11).map((entry) => (
              <li key={entry.version}>
                <a href={`${RELEASES_URL}#${releaseAnchor(entry.version)}`} target="_blank" rel="noopener noreferrer">v{entry.version}</a>
                <span className="changelog-date">{entry.date}</span>{' '}{entry.title}
              </li>
            ))}
          </ul>
          <p><a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">All releases</a></p>
        </section>
      </div>
    </div>
  );
}
