import { useEffect, useRef, useState } from 'react';
import { useUI } from './store';
import { ShapeIcon } from './icons';
import { SHAPE_LABELS } from '../engine/shapes';
import { DEFAULT_SHORTCUTS, SHAPE_ACTIONS } from '../engine/shortcuts';
import type { ShapeKind } from '../engine/types';

/** Jeden przycisk „figury” + lista do wyboru (ostatnio użyta figura jest na przycisku). */
export function ShapesButton() {
  const tool = useUI((s) => s.tool);
  const kind = useUI((s) => s.shapeKind);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  const pick = (k: ShapeKind) => {
    useUI.setState({ tool: 'shape', shapeKind: k });
    setOpen(false);
  };

  return (
    <div className="shapes" ref={ref}>
      <button
        className={tool === 'shape' ? 'active' : ''}
        title={`${SHAPE_LABELS[kind]} (${DEFAULT_SHORTCUTS[kind][0].toUpperCase()}) – click again for more shapes`}
        onClick={() => (tool === 'shape' ? setOpen(!open) : pick(kind))}
      >
        <ShapeIcon kind={kind} />
        <span
          className="caret-down"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          ▾
        </span>
      </button>
      {open && (
        <div className="shapes-menu">
          {SHAPE_ACTIONS.map((k) => (
            <button key={k} className={k === kind ? 'on' : ''} onClick={() => pick(k)}>
              <ShapeIcon kind={k} />
              <span>{SHAPE_LABELS[k]}</span>
              <kbd>{DEFAULT_SHORTCUTS[k][0].toUpperCase()}</kbd>
            </button>
          ))}
          <div className="shapes-hint">
            Shapes snap to the grid · <b>Shift</b> square / circle / 15° / right triangle · <b>Alt</b> free placement
          </div>
        </div>
      )}
    </div>
  );
}
