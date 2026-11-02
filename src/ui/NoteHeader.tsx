import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type NoteKind } from '../data/db';
import { KINDS, renameNote, sortClasses, updateNote } from '../data/notes';
import { useUI } from './store';
import { InlineEdit } from './InlineEdit';
import { pickPdfFile } from '../pdf/importPdf';

/** Pasek otwartej notatki: typ, nazwa, klasa, temat – wszystko zmienialne jednym klikiem. */
export function NoteHeader() {
  const id = useUI((s) => s.currentNoteId);
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const note = useLiveQuery(() => (id ? db.notes.get(id) : undefined), [id]);
  const classes = useLiveQuery(() => db.classes.toArray(), []) ?? [];
  const [renaming, setRenaming] = useState(false);

  return (
    <div className="note-header">
      <button
        className="icon-btn"
        title={(sidebarOpen ? 'Hide' : 'Show') + ' sidebar (Tab)'}
        onClick={() => useUI.setState({ sidebarOpen: !sidebarOpen })}
      >
        ☰
      </button>
      {!sidebarOpen && (
        <button className="icon-btn plus" title="New note (Alt+N)" onClick={() => useUI.setState({ newNote: { open: true } })}>
          +
        </button>
      )}
      {note && (
        <>
          <select
            className="kind-select"
            value={note.kind}
            title="Type"
            onChange={(e) => void updateNote(note.id, { kind: e.target.value as NoteKind })}
          >
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.icon} {k.label}
              </option>
            ))}
          </select>

          {renaming ? (
            <InlineEdit
              className="title-edit"
              value={note.autoTitle ? '' : note.title}
              placeholder={note.title}
              onDone={(v) => {
                setRenaming(false);
                if (v !== null) void renameNote(note.id, v);
              }}
            />
          ) : (
            <button
              className={'note-title-btn' + (note.autoTitle ? ' auto' : '')}
              title={note.autoTitle ? 'Automatic name – click to rename' : 'Click to rename (empty = automatic name)'}
              onClick={() => setRenaming(true)}
            >
              {note.title}
            </button>
          )}

          <select
            className="class-select"
            value={note.classId ?? ''}
            title="Class"
            onChange={(e) => void updateNote(note.id, { classId: e.target.value || null })}
          >
            <option value="">Unsorted</option>
            {sortClasses(classes).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <TopicInput key={note.id} value={note.topic} onCommit={(t) => void updateNote(note.id, { topic: t })} />
          <button className="pdf-btn import" title="Import PDF to write on it (Ctrl+O) – or drop a PDF file on the board" onClick={pickPdfFile}>
            Import PDF
          </button>
          <button className="pdf-btn" title="Export PDF (Ctrl+P)" onClick={() => useUI.setState({ exportOpen: true })}>
            Export PDF
          </button>
        </>
      )}
    </div>
  );
}

function TopicInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (v.trim() !== value) onCommit(v);
  };
  return (
    <input
      className="topic-input"
      list="topic-suggestions"
      placeholder="Topic"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setV(value);
          setTimeout(() => (e.target as HTMLInputElement).blur());
        }
      }}
    />
  );
}
