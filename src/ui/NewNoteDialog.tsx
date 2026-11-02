import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type NoteKind } from '../data/db';
import { addClasses, createNote, KINDS, makeTitle, sortClasses } from '../data/notes';
import { useUI } from './store';
import { InlineEdit } from './InlineEdit';

export function NewNoteDialog() {
  const open = useUI((s) => s.newNote.open);
  return open ? <NewNoteForm /> : null;
}

const close = () => useUI.setState({ newNote: { open: false } });

/** Wszystko ma sensowne domyślne wartości – wystarczy Enter. */
function NewNoteForm() {
  const ui = useUI.getState();
  const classes = useLiveQuery(() => db.classes.toArray(), []) ?? [];
  const notes = useLiveQuery(() => db.notes.toArray(), []) ?? [];
  const [classId, setClassId] = useState<string | null>(ui.lastClassId);
  const [kind, setKind] = useState<NoteKind>(ui.lastKind);
  const [topic, setTopic] = useState('');
  const [addingClass, setAddingClass] = useState(false);
  const topicRef = useRef<HTMLInputElement>(null);

  useEffect(() => topicRef.current?.focus(), []);

  // ostatnie tematy w wybranej klasie – jako szybkie przyciski
  const recentTopics = [
    ...new Set(
      notes
        .filter((n) => !n.deletedAt && n.topic && n.classId === classId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((n) => n.topic),
    ),
  ].slice(0, 5);

  const create = () => {
    close();
    void createNote({ classId, kind, topic });
  };

  return (
    <div className="backdrop" onPointerDown={close}>
      <div
        className="dialog"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          if (e.key === 'Enter' && !addingClass) create();
        }}
      >
        <h2>New note</h2>

        <div className="field">
          <label>Class</label>
          <div className="chips">
            {sortClasses(classes).map((c) => (
              <button
                key={c.id}
                className={'chip' + (classId === c.id ? ' active' : '')}
                style={classId === c.id ? { background: c.color, borderColor: c.color } : { borderColor: c.color + '66' }}
                onClick={() => setClassId(c.id)}
              >
                {c.name}
              </button>
            ))}
            <button className={'chip' + (classId === null ? ' active' : '')} onClick={() => setClassId(null)}>
              Unsorted
            </button>
            {addingClass ? (
              <InlineEdit
                value=""
                placeholder="7A, 7B…"
                className="chip-input"
                onDone={async (v) => {
                  setAddingClass(false);
                  if (v) {
                    const c = await addClasses(v);
                    if (c) setClassId(c.id);
                  }
                  topicRef.current?.focus();
                }}
              />
            ) : (
              <button className="chip ghost" onClick={() => setAddingClass(true)}>
                + class
              </button>
            )}
          </div>
        </div>

        <div className="field">
          <label>Type</label>
          <div className="chips">
            {KINDS.map((k) => (
              <button key={k.id} className={'chip' + (kind === k.id ? ' active' : '')} onClick={() => setKind(k.id)}>
                {k.icon} {k.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Topic <span className="optional">optional</span></label>
          <input
            ref={topicRef}
            className="text-input"
            list="topic-suggestions"
            placeholder="e.g. Fractions"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
          {recentTopics.length > 0 && (
            <div className="chips small">
              {recentTopics.map((t) => (
                <button key={t} className={'chip' + (topic === t ? ' active' : '')} onClick={() => setTopic(t)}>
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="dialog-footer">
          <span className="preview">{makeTitle(kind, topic, Date.now())}</span>
          <button className="primary" onClick={create}>
            Create <kbd>Enter</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
