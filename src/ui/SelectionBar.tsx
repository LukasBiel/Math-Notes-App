import { COLORS, useUI } from './store';

/** Pasek nad zaznaczeniem: kolor, duplikuj, kopiuj, usuń. */
export function SelectionBar() {
  const sel = useUI((s) => s.selection);
  const api = useUI((s) => s.api);
  if (!sel || !api) return null;
  // nad zaznaczeniem; jeśli brak miejsca u góry – pod nim
  const top = sel.y > 110 ? sel.y - 52 : sel.y + sel.h + 14;
  return (
    <div className="sel-bar" style={{ left: Math.max(8, sel.x), top }} onPointerDown={(e) => e.stopPropagation()}>
      <span className="sel-count">{sel.count} selected</span>
      {sel.ink &&
        COLORS.map((c) => (
          <button key={c} className="sel-swatch" title="Change color" onClick={() => api.recolorSelection(c)}>
            <span style={{ background: c }} />
          </button>
        ))}
      <button title="Duplicate (Ctrl+D)" onClick={() => api.duplicateSelection()}>
        Duplicate
      </button>
      <button title="Copy (Ctrl+C) – paste with Ctrl+V, also in another note" onClick={() => api.copySelection()}>
        Copy
      </button>
      <button className="danger" title="Delete (Del)" onClick={() => api.deleteSelection()}>
        Delete
      </button>
    </div>
  );
}
