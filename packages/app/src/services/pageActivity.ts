/** Page-lifetime input/import evidence survives history resets and failed opens. */
export function createPageActivity() {
  let touched = false;
  let imports = 0;
  const touch = () => { touched = true; };
  return {
    isUntouched: () => !touched && imports === 0,
    importsInProgress: () => imports,
    startImport: () => {
      touch();
      imports++;
      let finished = false;
      return () => { if (!finished) { finished = true; imports--; } };
    },
    listen: (target: Window) => {
      const events = ['pointerdown', 'keydown', 'drop', 'paste'];
      events.forEach(name => target.addEventListener(name, touch, true));
      return () => { events.forEach(name => target.removeEventListener(name, touch, true)); };
    },
  };
}

export const pageActivity = createPageActivity();
