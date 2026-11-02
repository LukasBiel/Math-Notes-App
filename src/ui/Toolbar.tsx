import { COLORS, useUI, WIDTHS, type Tool } from './store';
import { ShapesButton } from './ShapesButton';
import { EraserIcon, HandIcon, LandscapeIcon, PageIcon, PenIcon, PortraitIcon, RedoIcon, SelectIcon, UndoIcon } from './icons';

const TOOLS: { id: Tool; label: string; icon: () => React.JSX.Element }[] = [
  { id: 'select', label: 'Select (V) – click or draw a lasso around writing; drag to move, corner to scale', icon: SelectIcon },
  { id: 'pen', label: 'Pen (P)', icon: PenIcon },
  { id: 'eraser', label: 'Eraser (E, or right mouse button)', icon: EraserIcon },
  { id: 'hand', label: 'Pan (H, or hold Space)', icon: HandIcon },
];

export function Toolbar() {
  const s = useUI();
  const set = useUI.setState;
  // kolor/grubość: przy figurach zostajemy w figurach, inaczej wracamy do pisaka
  const drawTool = s.tool === 'shape' ? 'shape' : 'pen';

  return (
    // po kliknięciu oddajemy fokus, żeby spacja/skróty nie „klikały” przycisków
    <div className="toolbar" onPointerUp={() => (document.activeElement as HTMLElement | null)?.blur()}>
      <div className="group">
        {TOOLS.map((t) => (
          <button key={t.id} title={t.label} className={s.tool === t.id ? 'active' : ''} onClick={() => set({ tool: t.id })}>
            <t.icon />
          </button>
        ))}
        <ShapesButton />
      </div>

      <div className="group">
        {COLORS.map((c) => (
          <button
            key={c}
            className={'swatch' + (s.color === c ? ' active' : '')}
            title={c}
            onClick={() => {
              // jest zaznaczenie – kolor zmienia zaznaczone
              if (s.selection?.ink) {
                s.api?.recolorSelection(c);
                set({ color: c });
              } else {
                set({ color: c, tool: drawTool });
              }
            }}
          >
            <span style={{ background: c }} />
          </button>
        ))}
      </div>

      <div className="group">
        {WIDTHS.map((w, i) => (
          <button
            key={w}
            className={s.width === w ? 'active' : ''}
            title={`Width ${i + 1} (key ${i + 1})`}
            onClick={() => set({ width: w, tool: drawTool })}
          >
            <span className="dot" style={{ width: 3 + i * 3, height: 3 + i * 3, background: s.color }} />
          </button>
        ))}
        <input
          type="range"
          min={0.5}
          max={30}
          step={0.5}
          value={s.width}
          title={`Width: ${s.width}`}
          onChange={(e) => set({ width: Number(e.target.value) })}
        />
      </div>

      <div className="group">
        <label className="small" title="Smoothing (higher = smoother, with a slight lag)">
          Smooth
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={s.smoothing}
            onChange={(e) => set({ smoothing: Number(e.target.value) })}
          />
        </label>
        <button
          className={'text' + (s.pressure ? ' active' : '')}
          title="Width follows pen pressure (needs Windows Ink)"
          onClick={() => set({ pressure: !s.pressure })}
        >
          Pressure
        </button>
      </div>

      <div className="group">
        <button
          title="Page tool (F) – click empty space to add an A4 page, drag a page to move it"
          className={s.tool === 'frame' ? 'active' : ''}
          onClick={() => set({ tool: s.tool === 'frame' ? 'pen' : 'frame' })}
        >
          <PageIcon />
        </button>
        <button
          title={s.frameOrientation === 'portrait' ? 'Pages: portrait (click for landscape)' : 'Pages: landscape (click for portrait)'}
          onClick={() => set({ frameOrientation: s.frameOrientation === 'portrait' ? 'landscape' : 'portrait' })}
        >
          {s.frameOrientation === 'portrait' ? <PortraitIcon /> : <LandscapeIcon />}
        </button>
        <button className="text" title="Add next page below the last one (Shift+F)" onClick={() => s.api?.addPage()}>
          + Page
        </button>
      </div>

      <div className="group">
        <button title="Undo (Ctrl+Z) · Alt+Z undoes the last burst" disabled={!s.canUndo} onClick={() => s.api?.undo()}>
          <UndoIcon />
        </button>
        <button title="Redo (Ctrl+Y)" disabled={!s.canRedo} onClick={() => s.api?.redo()}>
          <RedoIcon />
        </button>
      </div>

      <div className="group">
        <button className="text" title="Zoom out (-)" onClick={() => s.api?.zoomBy(0.8)}>−</button>
        <button className="text zoom" title="Reset zoom (0)" onClick={() => s.api?.zoomReset()}>
          {Math.round(s.zoom * 100)}%
        </button>
        <button className="text" title="Zoom in (=)" onClick={() => s.api?.zoomBy(1.25)}>+</button>
      </div>
    </div>
  );
}
