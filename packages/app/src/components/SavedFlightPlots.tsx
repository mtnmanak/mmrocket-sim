import { useId, useState } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';
import { MAX_FLIGHT_PLOTS, type SavedFlightPlot } from '../prefs/flightPlots.js';
import { Note } from './Note.js';

type Layout = Pick<SavedFlightPlot, 'panels' | 'comparison'>;

// Native selects match the existing comparison and branch pickers; the
// platform owns their popup geometry and keyboard interaction.
export function SavedFlightPlots({ current, onApply }: { current: Layout; onApply: (layout: Layout) => void }) {
  const { prefs, setPrefs, saveFailing } = usePrefs();
  const plots = prefs.flightPlots ?? [];
  const [chosen, setChosen] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [deleted, setDeleted] = useState<{ plot: SavedFlightPlot; index: number } | null>(null);
  const inputId = useId(), errorId = useId();
  const selected = plots.find(p => p.id === chosen);
  const write = (next: SavedFlightPlot[]) => setPrefs({ ...prefs, flightPlots: next });
  const validName = () => {
    const title = name.trim();
    if (!title) { setError('Enter a name for these plots.'); return null; }
    if (plots.some(p => p.name.toLowerCase() === title.toLowerCase() && p.id !== chosen)) {
      setError('That name is already used. Enter a different name.'); return null;
    }
    setError(''); return title;
  };

  return <div className="saved-flight-plots">
    <div className="comparison-controls">
      <label>Saved plots
        <select value={selected ? chosen : ''} onChange={e => {
          setChosen(e.target.value); setName(plots.find(p => p.id === e.target.value)?.name ?? ''); setError('');
        }}>
          <option value="">{plots.length ? 'Choose saved plots' : 'No saved plots'}</option>
          {plots.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <button className="chart-btn" disabled={!selected} onClick={() => {
        if (selected) { onApply({ panels: [...selected.panels], comparison: selected.comparison }); setStatus(`Applied ${selected.name}.`); }
      }}>Apply</button>
      <button className="chart-btn" disabled={!selected} onClick={() => {
        if (!selected) return;
        const title = validName();
        if (title) { write(plots.map(p => p.id === chosen ? { ...p, name: title } : p)); setStatus(`Renamed to ${title}.`); }
      }}>Rename</button>
      <button className="chart-btn" disabled={!selected} onClick={() => {
        if (!selected) return;
        setDeleted({ plot: selected, index: plots.indexOf(selected) });
        write(plots.filter(p => p.id !== chosen)); setChosen(''); setName(''); setError(''); setStatus(`Deleted ${selected.name}.`);
      }}>Delete</button>
    </div>
    <form noValidate className="comparison-controls" onSubmit={e => {
      e.preventDefault();
      const title = validName();
      if (!title) return;
      if (plots.some(p => p.name.toLowerCase() === title.toLowerCase())) {
        setError('That name is already used. Enter a different name.'); return;
      }
      if (plots.length >= MAX_FLIGHT_PLOTS) { setError('Delete a saved plot before adding another (limit 50).'); return; }
      const plot = { ...current, panels: [...current.panels], name: title, id: crypto.randomUUID() };
      write([...plots, plot]); setChosen(plot.id); setName(title); setStatus(`Saved ${title}.`);
    }}>
      <label htmlFor={inputId}>Plot name</label>
      <input id={inputId} value={name} maxLength={80} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
        onChange={e => { setName(e.target.value); setError(''); }} />
      <button className="chart-btn" type="submit">Save current plots</button>
    </form>
    {error && <Note as="p" tier="information" id={errorId} role="alert">{error}</Note>}
    <p className="chart-comparison-note" role="status">{status || 'Save the series and comparison axes for use with any flight in this browser.'}</p>
    {deleted && <button className="chart-btn" onClick={() => {
      if (plots.some(p => p.id === deleted.plot.id || p.name.toLowerCase() === deleted.plot.name.toLowerCase()) || plots.length >= MAX_FLIGHT_PLOTS) {
        setError('Cannot restore these plots while their name is in use or the list is full.'); return;
      }
      const next = [...plots]; next.splice(deleted.index, 0, deleted.plot); write(next);
      setChosen(deleted.plot.id); setName(deleted.plot.name); setStatus(`Restored ${deleted.plot.name}.`); setDeleted(null); setError('');
    }}>Undo delete</button>}
    {saveFailing && <Note as="p" tier="caution">The browser could not store these plots. Changes work only for this session; they may be lost on reload.</Note>}
  </div>;
}
