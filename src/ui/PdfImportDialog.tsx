import { useState } from 'react';
import { useUI } from './store';
import { runPdfImport } from '../pdf/importPdf';

/** Długi PDF: które strony wziąć? Domyślnie wszystkie – wystarczy Enter. */
export function PdfImportDialog() {
  const req = useUI((s) => s.pdfImport);
  return req ? <Form key={req.name + req.count} /> : null;
}

function Form() {
  const req = useUI.getState().pdfImport!;
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(req.count);
  const valid = from >= 1 && to <= req.count && from <= to;

  const cancel = () => {
    void req.doc.loadingTask.destroy();
    useUI.setState({ pdfImport: null });
  };
  const run = () => {
    if (!valid) return;
    useUI.setState({ pdfImport: null });
    void runPdfImport(req.doc, req.name, from, to);
  };

  return (
    <div className="backdrop" onPointerDown={cancel}>
      <div
        className="dialog"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel();
          if (e.key === 'Enter') run();
        }}
      >
        <h2>Import “{req.name}”</h2>
        <p className="muted">This PDF has {req.count} pages. Which ones do you need?</p>
        <div className="range">
          <label>From</label>
          <input type="number" min={1} max={req.count} value={from} onChange={(e) => setFrom(Number(e.target.value))} autoFocus />
          <label>to</label>
          <input type="number" min={1} max={req.count} value={to} onChange={(e) => setTo(Number(e.target.value))} />
        </div>
        <div className="dialog-footer">
          <span className="preview">{valid ? `${to - from + 1} pages` : 'Check the page numbers'}</span>
          <button className="ghost-btn" onClick={cancel}>
            Cancel
          </button>
          <button className="primary" disabled={!valid} onClick={run}>
            Import <kbd>Enter</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
