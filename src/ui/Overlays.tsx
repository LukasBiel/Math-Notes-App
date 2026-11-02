import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useUI } from './store';
import { db } from '../data/db';
import { MATH_TOPICS } from '../data/notes';
import { ACTION_LABELS, DEFAULT_SHORTCUTS, type Action } from '../engine/shortcuts';

export function ContextMenu() {
  const menu = useUI((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 8),
      y: Math.min(menu.y, window.innerHeight - r.height - 8),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'pointerdown' && ref.current?.contains(e.target as Node)) return;
      useUI.setState({ menu: null });
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  if (!menu) return null;
  return (
    <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }}>
      {menu.items.map((it, i) =>
        it.header ? (
          <div key={i} className="menu-header">{it.label}</div>
        ) : (
          <button
            key={i}
            className={(it.danger ? 'danger ' : '') + (it.checked ? 'checked' : '')}
            onClick={() => {
              useUI.setState({ menu: null });
              it.onClick?.();
            }}
          >
            {it.swatch && <span className="menu-swatch" style={{ background: it.swatch }} />}
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

export function Toast() {
  const toast = useUI((s) => s.toast);
  if (!toast) return null;
  return (
    <div className="toast" key={toast.id}>
      <span>{toast.text}</span>
      {toast.undo && (
        <button
          onClick={() => {
            useUI.setState({ toast: null });
            void toast.undo?.();
          }}
        >
          Undo
        </button>
      )}
      <button className="close" title="Close" onClick={() => useUI.setState({ toast: null })}>
        ×
      </button>
    </div>
  );
}

/** Wspólna lista podpowiedzi tematów dla wszystkich pól „Topic”. */
export function TopicDatalist() {
  const notes = useLiveQuery(() => db.notes.toArray(), []) ?? [];
  const used = [...new Set(notes.filter((n) => n.topic && !n.deletedAt).map((n) => n.topic))];
  const all = [...used, ...MATH_TOPICS.filter((t) => !used.some((u) => u.toLowerCase() === t.toLowerCase()))];
  return (
    <datalist id="topic-suggestions">
      {all.map((t) => (
        <option key={t} value={t} />
      ))}
    </datalist>
  );
}

const pretty = (combo: string) =>
  combo
    .split('+')
    .map((k) => (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)))
    .join('+');

export function Hints() {
  const open = useUI((s) => s.hintsOpen);
  const custom = useUI((s) => s.shortcuts);
  const map = { ...DEFAULT_SHORTCUTS, ...custom };
  return (
    <div className="hints">
      {open && (
        <div className="hints-panel">
          <div className="hints-mouse">
            <b>Shift</b> straight line · <b>Space</b> / middle button pan · <b>right button</b> eraser · <b>wheel</b> zoom
          </div>
          <div className="hints-grid">
            {(Object.keys(map) as Action[])
              .filter((a) => map[a].length)
              .map((a) => (
                <div key={a}>
                  <span>{ACTION_LABELS[a]}</span>
                  <kbd>{map[a].map(pretty).join(' / ')}</kbd>
                </div>
              ))}
          </div>
        </div>
      )}
      <button className="hints-toggle" title="Keyboard shortcuts" onClick={() => useUI.setState({ hintsOpen: !open })}>
        ?
      </button>
    </div>
  );
}
