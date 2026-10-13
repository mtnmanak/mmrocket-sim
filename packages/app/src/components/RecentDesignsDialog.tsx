import { useEffect, useState } from 'react';
import { Modal } from './Modal.js';
import { Note } from './Note.js';
import { clearRecentDesigns, listRecentDesigns, recentDesignFile, type RecentDesign } from '../services/recentDesigns.js';

export function RecentDesignsDialog({ onOpen, onClose }: { onOpen: (file: File) => void; onClose: () => void }) {
  const [entries, setEntries] = useState<RecentDesign[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    let active = true;
    void listRecentDesigns().then(rows => {
      if (active) { setEntries(rows); setBusy(false); }
    }, e => {
      if (active) { setError(e instanceof Error ? e.message : 'Recent designs could not be read.'); setBusy(false); }
    });
    return () => { active = false; };
  }, [retry]);
  const open = async (name: string) => {
    setBusy(true); setError(null);
    try {
      const file = await recentDesignFile(name);
      if (file) onOpen(file);
      else setError('This copy is no longer in Recent. Open the file from your device instead.');
    } catch (e) { setError(e instanceof Error ? e.message : 'This copy could not be opened.'); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    setConfirmClear(false); setBusy(true); setError(null);
    try { await clearRecentDesigns(); setEntries([]); }
    catch (e) { setError(e instanceof Error ? e.message : 'Recent copies could not be cleared.'); }
    finally { setBusy(false); }
  };
  return <Modal label="Recent designs" onClose={onClose}>
    <h2>Recent designs</h2>
    <p>These are copies kept in this browser when a file was opened or saved. Changes to the file on your device are not read here.</p>
    <div role="status" aria-live="polite">
      {busy ? <p>Loading recent designs…</p> : null}
      {error ? <Note tier="caution"><p>{error}</p></Note> : null}
      {!busy && !error && entries.length === 0 ? <p>No recent designs. Open or save a design file to keep a copy here.</p> : null}
    </div>
    <ul className="recent-design-list">{entries.map(e => <li key={e.name}>
      <button className="file-btn" disabled={busy} onClick={() => { void open(e.name); }}>
        <span>{e.name}</span>
        <small>{new Date(e.openedAt).toLocaleString()} · {(e.size / 1024).toFixed(1)} KiB</small>
      </button>
    </li>)}</ul>
    <div className="modal-actions">
      <button className="file-btn" onClick={onClose}>Close</button>
      {error ? <button className="file-btn" disabled={busy} onClick={() => {
        setError(null); setBusy(true); setRetry(r => r + 1);
      }}>Retry</button> : null}
      <button className="file-btn" disabled={busy || entries.length === 0} onClick={() => setConfirmClear(true)}>Clear recent</button>
    </div>
    {confirmClear && <Modal label="Clear recent copies?" onClose={() => setConfirmClear(false)}>
      <h2>Clear recent copies?</h2>
      <p>Clear every Recent copy? Files on your device and the current design stay.</p>
      <div className="modal-actions">
        <button className="file-btn" onClick={() => setConfirmClear(false)}>Keep copies</button>
        <button className="file-btn modal-danger" onClick={() => { void clear(); }}>Clear copies</button>
      </div>
    </Modal>}
  </Modal>;
}
