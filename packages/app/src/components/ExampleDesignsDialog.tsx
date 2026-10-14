import { useLayoutEffect, useRef, useState } from 'react';
import { EXAMPLE_DESIGNS, loadExampleFile, type ExampleDesign } from '../data/exampleDesigns.js';
import { Modal } from './Modal.js';
import { Note } from './Note.js';

export function ExampleDesignsDialog({ onOpen, onClose }: { onOpen: (file: File) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const onOpenRef = useRef(onOpen);
  useLayoutEffect(() => { onOpenRef.current = onOpen; });
  useLayoutEffect(() => () => { pending.current?.abort(); }, []);
  const close = () => { pending.current?.abort(); onClose(); };
  const open = async (example: ExampleDesign) => {
    if (pending.current && !pending.current.signal.aborted) return;
    const operation = new AbortController();
    pending.current = operation;
    setBusy(true); setError(null);
    try {
      const file = await loadExampleFile(example, operation.signal);
      if (!operation.signal.aborted) onOpenRef.current(file);
    } catch (e) {
      if (!operation.signal.aborted) setError(e instanceof Error ? e.message : 'The example could not be loaded. Try again.');
    } finally {
      if (!operation.signal.aborted) { pending.current = null; setBusy(false); }
    }
  };
  return <Modal label="Example designs" className="example-design-dialog" onClose={close}>
    <h2>Example designs</h2>
    <p>Open an example as an ordinary design, then edit or save your own copy. Select a stage to read its Comment.</p>
    <Note tier="caution"><p>These designs use assumed build masses, a vertical 2 m launch guide and no wind at sea level. An assumed mass or balance point can make the app show more stability margin than the built rocket has. Measure the built rocket and set the actual launch conditions before using a flight result.</p></Note>
    <div role="status" aria-live="polite" className="example-load-status">
      {busy ? 'Loading example…' : null}
      {error ? <Note tier="caution">{error}</Note> : null}
    </div>
    <ul className="recent-design-list example-design-list" aria-busy={busy}>
      {EXAMPLE_DESIGNS.map(example => <li key={example.id}>
        <button type="button" className="file-btn" disabled={busy} onClick={() => { void open(example); }}>
          <span>{example.name}</span><small>{example.explanation}</small>
        </button>
      </li>)}
    </ul>
    <div className="modal-actions"><button type="button" className="file-btn" onClick={close}>Close</button></div>
  </Modal>;
}
