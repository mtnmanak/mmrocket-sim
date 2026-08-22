import { useState } from 'react';
import { useDialog } from './useDialog.js';
import { GUIDE_SECTIONS } from '../data/userGuide.js';
import { APP_VERSION } from '../version.js';

/**
 * In-app user guide — quick start, feature reference, and the physics/math
 * documentation. Opened from the "❓ Guide" header button. A table of
 * contents on the left jumps between sections; content is our own trusted
 * static HTML.
 */
export function GuideDialog({ onClose }: { onClose: () => void }) {
  const [active, setActive] = useState(GUIDE_SECTIONS[0]?.id ?? '');
  const current = GUIDE_SECTIONS.find((s) => s.id === active) ?? GUIDE_SECTIONS[0];
  const dialogRef = useDialog(onClose);

  return (
    <div className="prefs-overlay" role="presentation" onClick={onClose}>
      <div className="guide-dialog panel" role="dialog" aria-modal="true" aria-label="User guide"
        ref={dialogRef} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}>
        <div className="guide-header">
          <h2 style={{ flex: 1 }}>User Guide <span className="version-beta">v{APP_VERSION}</span></h2>
          <button className="file-btn" onClick={onClose} aria-label="Close user guide">✕ Close</button>
        </div>
        {GUIDE_SECTIONS.length === 0 ? (
          <p className="guide-empty">The guide content is being prepared.</p>
        ) : (
          <div className="guide-body">
            <nav className="guide-toc" aria-label="Guide contents">
              {GUIDE_SECTIONS.map((s) => (
                <button
                  key={s.id}
                  className={s.id === active ? 'guide-toc-item active' : 'guide-toc-item'}
                  onClick={() => {
                    setActive(s.id);
                    document.querySelector('.guide-content')?.scrollTo(0, 0);
                  }}
                >
                  {s.title}
                </button>
              ))}
            </nav>
            <article className="guide-content">
              {current && (
                <>
                  <h2 className="guide-section-title">{current.title}</h2>
                  <div dangerouslySetInnerHTML={{ __html: current.html }} />
                </>
              )}
            </article>
          </div>
        )}
      </div>
    </div>
  );
}
