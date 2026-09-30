import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useBackdropClose, useDialog } from './useDialog.js';
import { GUIDE_SECTIONS } from '../data/userGuide.js';
import { APP_VERSION } from '../version.js';
import { findGuideMatches, highlightGuide, indexGuide, type GuideMatch } from './guideSearch.js';

const GuideHtml = memo(function GuideHtml({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
});

/**
 * In-app user guide — quick start, feature reference, and the physics/math
 * documentation. Opened from the "❓ Guide" header button. A table of
 * contents on the left jumps between sections; content is our own trusted
 * static HTML. App.tsx lazy-loads it, and with it data/userGuide.ts, which
 * nothing else in the app imports (audit 2026-09-22, row 510).
 */
export function GuideDialog({ onClose }: { onClose: () => void }) {
  const [active, setActive] = useState(GUIDE_SECTIONS[0]?.id ?? '');
  const [index] = useState(() => indexGuide(GUIDE_SECTIONS));
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ query: string; matches: GuideMatch[] }>({ query: '', matches: [] });
  const [selected, setSelected] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const composing = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const current = index.find((s) => s.section.id === active) ?? index[0];
  const html = useMemo(() => current ? highlightGuide(current, results.matches) : '', [current, results.matches]);
  const dialogRef = useDialog(onClose);
  const backdrop = useBackdropClose(onClose);
  const pending = query.trim() !== results.query;

  useEffect(() => () => clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    const content = contentRef.current;
    content?.querySelectorAll('.guide-match-current').forEach((mark) => mark.classList.remove('guide-match-current'));
    const marks = content?.querySelectorAll<HTMLElement>(`[data-guide-match="${selected}"]`);
    marks?.forEach((mark) => mark.classList.add('guide-match-current'));
    marks?.[0]?.scrollIntoView({ block: 'center' });
  }, [active, results, selected]);

  const search = (value: string, backwards = false) => {
    clearTimeout(timer.current);
    const matches = findGuideMatches(index, value);
    const next = backwards ? Math.max(0, matches.length - 1) : 0;
    setResults({ query: value.trim(), matches });
    setSelected(next);
    if (matches[next]) setActive(matches[next].sectionId);
  };

  const changeQuery = (value: string) => {
    setQuery(value);
    clearTimeout(timer.current);
    if (!value.trim()) search('');
    else if (!composing.current) timer.current = setTimeout(() => search(value), 200);
  };

  const step = (direction: number) => {
    if (pending) { search(query, direction < 0); return; }
    if (!results.matches.length) return;
    const next = (selected + direction + results.matches.length) % results.matches.length;
    setSelected(next);
    setActive(results.matches[next]!.sectionId);
  };

  return (
    <div className="prefs-overlay" role="presentation" {...backdrop}>
      <div className="guide-dialog panel" role="dialog" aria-modal="true" aria-label="User guide"
        ref={dialogRef} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}>
        <div className="guide-header">
          <h2 style={{ flex: 1 }}>User Guide <span className="version-beta">v{APP_VERSION}</span></h2>
          <button className="file-btn" onClick={onClose} aria-label="Close user guide">✕ Close</button>
        </div>
        <div className="guide-search" role="search" aria-label="User guide">
          <label htmlFor="guide-search">Search guide</label>
          <input id="guide-search" ref={inputRef} type="search" value={query}
            aria-describedby="guide-search-help" autoComplete="off"
            onChange={(e) => changeQuery(e.target.value)}
            onCompositionStart={() => { composing.current = true; clearTimeout(timer.current); }}
            onCompositionEnd={(e) => { composing.current = false; changeQuery(e.currentTarget.value); }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing || composing.current) return;
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            }} />
          {query && <button className="file-btn" aria-label="Clear guide search" onClick={() => {
            changeQuery('');
            inputRef.current?.focus();
          }}>Clear</button>}
          <button className="file-btn" aria-label="Previous match" disabled={pending || !results.matches.length}
            onClick={() => step(-1)}>Previous</button>
          <button className="file-btn" aria-label="Next match" disabled={pending || !results.matches.length}
            onClick={() => step(1)}>Next</button>
          <span className="guide-search-count" role="status" aria-live="polite" aria-atomic="true">
            {pending ? 'Searching…' : results.matches.length ? `${selected + 1} of ${results.matches.length}` : results.query ? 'No matches' : ''}
          </span>
          <span id="guide-search-help">Enter: next match. Shift+Enter: previous.</span>
        </div>
        {GUIDE_SECTIONS.length === 0 ? (
          <p className="guide-empty">The guide content is being prepared.</p>
        ) : (
          <div className="guide-body">
            <nav className="guide-toc" aria-label="Guide contents">
              {GUIDE_SECTIONS.map((s) => (
                // aria-current says which section is on show (audit
                // 2026-09-22) — the `active` class said it to the eye only.
                <button
                  key={s.id}
                  className={s.id === active ? 'guide-toc-item active' : 'guide-toc-item'}
                  aria-current={s.id === active ? 'page' : undefined}
                  onClick={() => {
                    setActive(s.id);
                    contentRef.current?.scrollTo(0, 0);
                  }}
                >
                  {s.title}
                </button>
              ))}
            </nav>
            {/* A focusable, named region (audit 2026-09-22). Nine of the twelve
                sections hold no link, so nothing in them could take focus, and
                the Tab trap wrapped from the last contents button straight back
                to Close: the keyboard could not scroll past the first screen.
                Focused, the arrow and Page keys scroll it. */}
            <article className="guide-content" tabIndex={0} role="region" ref={contentRef}
              aria-label={current?.section.title ?? 'User guide'}
              onClick={(e) => {
                const link = (e.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');
                if (!link) return;
                const target = contentRef.current?.querySelector<HTMLElement>(link.getAttribute('href')!);
                if (!target) return;
                e.preventDefault();
                target.focus({ preventScroll: true });
                target.scrollIntoView({ block: 'start' });
              }}>
              <GuideHtml html={html} />
            </article>
          </div>
        )}
      </div>
    </div>
  );
}
