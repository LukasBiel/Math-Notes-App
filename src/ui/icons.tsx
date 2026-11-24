const base = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const PenIcon = () => (
  <svg {...base}><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1z" /><path d="M14.5 6.5l3 3" /></svg>
);

export const EraserIcon = () => (
  <svg {...base}><path d="M8 20h12" /><path d="M5.5 15.5l9-9a2 2 0 012.8 0l2.2 2.2a2 2 0 010 2.8L12 19H8.5l-3-3a1 1 0 010-.5z" /><path d="M9.5 11.5l5 5" /></svg>
);

export const HandIcon = () => (
  <svg {...base}><path d="M8 13V5.5a1.5 1.5 0 013 0V12" /><path d="M11 11V4.5a1.5 1.5 0 013 0V12" /><path d="M14 11.5V6a1.5 1.5 0 013 0v7.5c0 4-2.5 6.5-6 6.5-2.5 0-3.8-1.2-5-3l-2.3-3.7a1.5 1.5 0 012.5-1.6L8 13" /></svg>
);

export const UndoIcon = () => (
  <svg {...base}><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 010 12h-3" /></svg>
);

export const RedoIcon = () => (
  <svg {...base}><path d="M15 14l5-5-5-5" /><path d="M20 9H10a6 6 0 000 12h3" /></svg>
);

export const PageIcon = () => (
  <svg {...base}><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M9 8h6M9 12h6M9 16h3" /></svg>
);

export const PortraitIcon = () => (
  <svg {...base}><rect x="7" y="4" width="10" height="16" rx="1.5" /></svg>
);

export const LandscapeIcon = () => (
  <svg {...base}><rect x="4" y="7" width="16" height="10" rx="1.5" /></svg>
);

export const SelectIcon = () => (
  <svg {...base}><path d="M5 3l14 8-6 1.5L10 19 5 3z" /></svg>
);

export const CompassIcon = () => (
  <svg {...base}><circle cx="12" cy="4.5" r="1.8" /><path d="M11 6.2L6 20M13 6.2L18 20" /><path d="M7.5 15.5h9" /></svg>
);

export const GridIcon = () => (
  <svg {...base}><rect x="4" y="4" width="16" height="16" rx="1.5" /><path d="M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16" /></svg>
);

/** Ikony figur – rysowane tak, jak wygląda figura. */
export function ShapeIcon({ kind }: { kind: string }) {
  switch (kind) {
    case 'line':
      return <svg {...base}><path d="M5 19L19 5" /></svg>;
    case 'arrow':
      return <svg {...base}><path d="M5 19L19 5" /><path d="M11 5h8v8" /></svg>;
    case 'rect':
      return <svg {...base}><rect x="4" y="6" width="16" height="12" rx="1" /></svg>;
    case 'ellipse':
      return <svg {...base}><circle cx="12" cy="12" r="8" /></svg>;
    case 'triangle':
      return <svg {...base}><path d="M12 4L20 19H4z" /></svg>;
    case 'angle':
      return <svg {...base}><path d="M19 6L5 19h15" /><path d="M10 19a5 5 0 00-1.6-3.7" /></svg>;
    case 'axes':
      return <svg {...base}><path d="M3 15h17M17 12l3 3-3 3M9 21V4M6 7l3-3 3 3" /></svg>;
    default:
      return <svg {...base}><path d="M3 12h17M17 9l3 3-3 3M7 10v4M12 10v4" /></svg>;
  }
}
