import { usePrefs } from '../prefs/PrefsContext.js';
import { Icon, type IconName } from './Icon.js';

const MODES = [
  { value: 'dark', label: 'Dark', icon: 'moon', title: 'Dark — light text on a dark screen' },
  { value: 'light', label: 'Light', icon: 'sun', title: 'Light — dark text on a light screen' },
  { value: 'daylight', label: 'Daylight', icon: 'sun-bold',
    title: 'Daylight — black on white at maximum contrast, for reading the screen in bright sunlight' },
] as const satisfies readonly { value: string; label: string; icon: IconName; title: string }[];
type ScreenMode = typeof MODES[number]['value'];

/** One shared control for the header and the tour; only the header is an anchor. */
/** The tour card renders a second switch while the header's is live, so the two groups take different names. */
export function ScreenModeSwitch({ tourAnchor = false, label = 'Screen mode' }: { tourAnchor?: boolean; label?: string }) {
  const { prefs, setPrefs, resolvedTheme, daylight } = usePrefs();
  const selected = daylight ? 'daylight' : resolvedTheme;
  const following = prefs.theme === 'system' && !daylight;
  const choose = (mode: ScreenMode) => {
    if (mode === selected) return;
    setPrefs(mode === 'daylight' ? { ...prefs, daylight: true }
      : { ...prefs, theme: mode, themeExplicit: true, daylight: false });
  };

  // Buttons with roving tabindex keep one Tab stop, and let us focus the new
  // choice on arrows without depending on each browser's radio-input behavior.
  return <div className="screen-mode-switch" role="radiogroup" aria-label={label}
    data-tour={tourAnchor ? 'screen-mode' : undefined}>
    {MODES.map((mode, index) => {
      const checked = mode.value === selected;
      return <button key={mode.value} type="button" role="radio"
        className="file-btn screen-mode-option" aria-label={mode.label}
        aria-checked={checked} tabIndex={checked ? 0 : -1}
        title={mode.title + (checked && following
          ? '. Following your system setting; Theme in Preferences changes that' : '')}
        onClick={() => choose(mode.value)}
        onKeyDown={event => {
          // Leave browser shortcuts alone (Alt+Left is Back; Ctrl+Home scrolls).
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          let next: number;
          switch (event.key) {
            case 'ArrowRight': case 'ArrowDown': next = (index + 1) % MODES.length; break;
            case 'ArrowLeft': case 'ArrowUp': next = (index + MODES.length - 1) % MODES.length; break;
            case 'Home': next = 0; break;
            case 'End': next = MODES.length - 1; break;
            default: return;
          }
          event.preventDefault();
          choose(MODES[next]!.value);
          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
        }}>
        <Icon name={mode.icon} />{checked && <span aria-hidden="true">{mode.label}</span>}
      </button>;
    })}
  </div>;
}
