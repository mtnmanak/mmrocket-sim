import { APP_VERSION, CHANGELOG, PRE_VERSIONING_NOTE } from '../version.js';

/** What's-new dialog, opened from the version badge in the header. */
export function ChangelogDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="prefs-overlay" role="presentation" onClick={onClose}>
      <div className="prefs-dialog panel" role="dialog" aria-label="Changelog"
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h2 style={{ flex: 1 }}>What's new — v{APP_VERSION} <span className="version-beta">beta</span></h2>
          <button className="file-btn" onClick={onClose} aria-label="Close changelog">✕ Close</button>
        </div>
        {CHANGELOG.map((entry) => (
          <section key={entry.version} className="changelog-entry">
            <h3>
              v{entry.version}
              <span className="changelog-date">{entry.date}</span>
            </h3>
            <p className="changelog-title">{entry.title}</p>
            <ul>
              {entry.items.map((item, i) => <li key={i}>{item}</li>)}
            </ul>
          </section>
        ))}
        <p className="changelog-pre">{PRE_VERSIONING_NOTE}</p>
      </div>
    </div>
  );
}
