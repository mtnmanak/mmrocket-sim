import { usePrefs } from '../prefs/PrefsContext.js';
import { UNITS, type Quantity } from '../prefs/units.js';

/**
 * The unit displayed next to a value, clickable in place (desktop OpenRocket
 * behavior): picking a unit switches that quantity group everywhere and
 * persists via preferences. Rendered as a borderless select styled as text.
 */
export function UnitChip({ quantity }: { quantity: Quantity }) {
  const { prefs, setPrefs } = usePrefs();
  return (
    <select
      className="unit-chip"
      title="Change this unit (applies everywhere)"
      aria-label="Unit"
      value={prefs.units[quantity]}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) =>
        setPrefs({ ...prefs, units: { ...prefs.units, [quantity]: e.target.value } })}
    >
      {UNITS[quantity].map((u) => (
        <option key={u.symbol} value={u.symbol}>{u.symbol}</option>
      ))}
    </select>
  );
}
