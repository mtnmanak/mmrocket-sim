import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';

/** Measure the desktop band or phone vitals; phone tabs keep their own root layer. */
export function WorkspaceBar({ children }: { children: ReactNode }) {
  const { prefs } = usePrefs();
  const enabled = prefs.stickyWorkspaceBar === true;
  const ref = useRef<HTMLDivElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const observed = useRef<Element | null>(null);

  const measure = useCallback(() => {
    const band = ref.current;
    if (!band) return;
    const target = window.matchMedia('(max-width: 767px)').matches
      ? band.querySelector('.vitals-strip') : band;
    if (observerRef.current && target !== observed.current) {
      if (observed.current) observerRef.current.unobserve(observed.current);
      if (target) observerRef.current.observe(target);
      observed.current = target;
    }
    document.documentElement.style.setProperty('--workspace-bar-h',
      `${enabled && window.matchMedia('(min-height: 700px)').matches && !window.matchMedia('print').matches
        ? target?.getBoundingClientRect().height ?? 0 : 0}px`);
  }, [enabled]);

  // Child layout effects precede parent scroll effects in this commit.
  useLayoutEffect(() => { measure(); });

  useLayoutEffect(() => {
    const band = ref.current;
    if (!band) return;
    const root = document.documentElement;
    const tall = window.matchMedia('(min-height: 700px)');
    const phone = window.matchMedia('(max-width: 767px)');
    const print = window.matchMedia('print');
    const observer = new ResizeObserver(measure);
    observerRef.current = observer;
    measure();
    tall.addEventListener('change', measure);
    phone.addEventListener('change', measure);
    print.addEventListener('change', measure);
    return () => {
      observer.disconnect();
      observerRef.current = null;
      observed.current = null;
      tall.removeEventListener('change', measure);
      phone.removeEventListener('change', measure);
      print.removeEventListener('change', measure);
      root.style.removeProperty('--workspace-bar-h');
    };
  }, [measure]);

  return <div ref={ref} className={`workspace-bar${enabled ? ' workspace-bar-sticky' : ''}`}>{children}</div>;
}
