import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';

/**
 * NEVER A SILENTLY-BLANK PAGE, FROM THE FIRST BYTE (audit 2026-09-30).
 *
 * main.tsx paints a failure into the root, but main.tsx runs only after the
 * whole static import graph has loaded and evaluated — so a chunk that could
 * not be fetched (a first visit at a field, a hashed file a deploy removed) or
 * a module that threw while evaluating left #root empty: the blank page its
 * own comment said could not happen. index.html now carries a classic inline
 * script, ahead of the app, that paints the failure itself and stands down
 * once the app has drawn.
 *
 * These cases load the REAL index.html into a fresh happy-dom window, with its
 * inline scripts running as a browser runs them, and leave out only the app's
 * own module script, which each case then fails in the way it is testing.
 */
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const APP_SCRIPT = /<script type="module" src="\/src\/main\.tsx"><\/script>/;

const open: Window[] = [];
afterEach(async () => {
  for (const w of open.splice(0)) await w.happyDOM.close();
});

function boot(): Window {
  const win = new Window({
    url: 'https://mmrsim.example/',
    // The only code evaluated is this repo's own index.html, so happy-dom's
    // warning about running untrusted scripts in a VM context does not apply.
    settings: {
      enableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  open.push(win);
  expect(html, 'the app is started by one module script').toMatch(APP_SCRIPT);
  win.document.write(html.replace(APP_SCRIPT, ''));
  return win;
}

const fallback = (win: Window) => win.document.querySelector('#root [data-startup-failure]');

/** A script element that failed to load, the way the browser reports it: an error event at the element. */
function failScript(win: Window, attrs: Record<string, string>): void {
  const s = win.document.createElement('script');
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  // Connected, so the event's capture path starts at the window, as a real one's does.
  win.document.head.appendChild(s);
  s.dispatchEvent(new win.Event('error'));
}

describe('index.html — the startup-failure painter', () => {
  it('runs before the app: it is a classic inline script ahead of the module script', () => {
    const at = html.indexOf('data-startup-painter');
    expect(at, 'the painter script').toBeGreaterThan(-1);
    expect(at).toBeLessThan(html.search(APP_SCRIPT));
  });

  it('says the app could not start, and offers a reload, when the app’s module fails to load', () => {
    const win = boot();
    failScript(win, { type: 'module', crossorigin: '', src: './assets/index-x.js' });
    const box = fallback(win);
    expect(box, 'the startup-failure message').not.toBeNull();
    expect(box!.textContent).toMatch(/could not start/);
    const reload = [...box!.querySelectorAll('button')].find((b) => /Reload/.test(b.textContent ?? ''));
    expect(reload, 'the reload button').toBeTruthy();
    expect(box!.textContent).toContain('./assets/index-x.js');
  });

  it('paints a module that threw while evaluating, with its message as text', () => {
    const win = boot();
    // A message that would be markup if it were ever written with innerHTML.
    const err = new win.Error('boom <img src=x onerror=alert(1)>');
    win.dispatchEvent(new win.ErrorEvent('error', { error: err, message: err.message }));
    const box = fallback(win);
    expect(box).not.toBeNull();
    expect(box!.textContent).toContain('boom <img src=x onerror=alert(1)>');
    expect(box!.querySelector('img')).toBeNull();
  });

  it('paints an unhandled rejection before the app has drawn', () => {
    const win = boot();
    const ev = new win.Event('unhandledrejection');
    Object.assign(ev, { reason: new win.Error('chunk gone') });
    win.dispatchEvent(ev);
    expect(fallback(win)?.textContent).toContain('chunk gone');
  });

  it('ignores what is not the app failing: a blocked analytics script, an image, a cross-origin "Script error."', () => {
    const win = boot();
    // Cloudflare injects a classic deferred beacon; ad blockers refuse it.
    failScript(win, { defer: '', src: 'https://static.cloudflareinsights.com/beacon.min.js' });
    const img = win.document.createElement('img');
    win.document.body.appendChild(img);
    img.dispatchEvent(new win.Event('error'));
    // A cross-origin script's error arrives with no error object.
    win.dispatchEvent(new win.ErrorEvent('error', { message: 'Script error.' }));
    expect(fallback(win)).toBeNull();
    expect(win.document.getElementById('root')!.childElementCount).toBe(0);
  });

  it('stands down once the app has drawn: a later error never paints over a working app', async () => {
    const win = boot();
    const root = win.document.getElementById('root')!;
    const app = win.document.createElement('div');
    app.className = 'app';
    root.appendChild(app);
    await new Promise((r) => setTimeout(r, 0));    // the mount is observed
    // Even if the app later leaves the root empty, the failure is main.tsx's to report now.
    root.removeChild(app);
    win.dispatchEvent(new win.ErrorEvent('error', { error: new win.Error('late'), message: 'late' }));
    failScript(win, { type: 'module', src: './assets/lazy-x.js' });
    expect(fallback(win)).toBeNull();
    expect(root.childElementCount).toBe(0);
  });

  it('paints once: a second failure does not stack a second message', () => {
    const win = boot();
    win.dispatchEvent(new win.ErrorEvent('error', { error: new win.Error('first'), message: 'first' }));
    win.dispatchEvent(new win.ErrorEvent('error', { error: new win.Error('second'), message: 'second' }));
    const root = win.document.getElementById('root')!;
    expect(root.querySelectorAll('[data-startup-failure]')).toHaveLength(1);
    expect(root.textContent).toContain('first');
    expect(root.textContent).not.toContain('second');
  });
});
