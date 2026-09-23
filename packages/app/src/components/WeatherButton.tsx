import { useOnline } from '../services/net.js';

/**
 * ☁ GET WEATHER… — the one way into the weather lookup, on the Launch panel
 * and the phone Fly screen (weather build, step 3). It opens App's dialog;
 * nothing is fetched until the dialog asks, and nothing written until Apply.
 *
 * Offline it greys out and says why, the way ↻ Check thrustcurve.org does.
 * Weather already applied is ordinary launch conditions and flies offline.
 */
export const WEATHER_BUTTON_TITLE =
  'Fetch one hour’s forecast for your launch site from Open-Meteo, review it, then apply what you want.';
export const WEATHER_OFFLINE_TITLE =
  'Needs a connection — the weather comes from Open-Meteo. Everything else works offline.';

export function WeatherButton({ onClick }: { onClick: () => void }) {
  const online = useOnline();
  return (
    <button type="button" className="file-btn weather-btn" onClick={onClick} disabled={!online}
      title={online ? WEATHER_BUTTON_TITLE : WEATHER_OFFLINE_TITLE}>
      ☁ Get weather…
    </button>
  );
}
