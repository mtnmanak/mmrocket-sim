// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { createPageActivity } from './pageActivity.js';

it.each(['pointerdown', 'keydown', 'drop', 'paste'])('latches %s at window capture before stopped bubbling', event => {
  const activity = createPageActivity();
  const stop = activity.listen(window);
  const field = document.createElement('input');
  document.body.append(field);
  field.addEventListener(event, e => e.stopPropagation());
  try {
    expect(activity.isUntouched()).toBe(true);
    field.dispatchEvent(new Event(event, { bubbles: true }));
    expect(activity.isUntouched()).toBe(false);
  } finally { field.remove(); stop(); }
});
it('scroll and wheel leave the page untouched and cleanup removes input tracking', () => {
  const activity = createPageActivity();
  const stop = activity.listen(window);
  window.dispatchEvent(new Event('scroll'));
  window.dispatchEvent(new Event('wheel'));
  expect(activity.isUntouched()).toBe(true);
  stop();
  window.dispatchEvent(new Event('pointerdown'));
  expect(activity.isUntouched()).toBe(true);
});
it('counts concurrent imports and stays touched after both finish with empty undo', () => {
  const activity = createPageActivity();
  const finish = activity.startImport();
  const finishOther = activity.startImport();
  expect(activity.importsInProgress()).toBe(2);
  expect(activity.isUntouched()).toBe(false);
  finish(); finish();
  expect(activity.importsInProgress()).toBe(1);
  finishOther();
  expect(activity.importsInProgress()).toBe(0);
  expect(activity.isUntouched()).toBe(false);
});
