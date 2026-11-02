import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type ClassGroup, type NoteMeta } from '../data/db';
import {
  addClasses, CLASS_COLORS, createNote, deleteClass, duplicateNote, emptyTrash, kindInfo, openNote,
  purgeNote, relDate, renameClass, renameNote, restoreNote, setClassColor, sortClasses, trashNote, updateNote,
} from '../data/notes';
import { openMenu, toggleCollapsed, useUI, type MenuItem } from './store';
import { InlineEdit } from './InlineEdit';
import { Account } from './Account';

const lastTouched = (n: NoteMeta) => Math.max(n.updatedAt, n.openedAt);
const byRecent = (a: NoteMeta, b: NoteMeta) => lastTouched(b) - lastTouched(a);
const DRAG_TYPE = 'application/x-note-id';

export function Sidebar() {
  const classes = useLiveQuery(() => db.classes.toArray(), []) ?? [];
  const notes = useLiveQuery(() => db.notes.toArray(), []) ?? [];
  const searchFocusTick = useUI((s) => s.searchFocusTick);
  const collapsed = useUI((s) => s.collapsed);
  const [q, setQ] = useState('');
  const [addingClass, setAddingClass] = useState(false);
  // każde kliknięcie „+” montuje pole od nowa → zawsze dostaje kursor
  const [addKey, setAddKey] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchFocusTick) {
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  }, [searchFocusTick]);

  const classMap = useMemo(() => new Map(classes.map((c) => [c.id, c])), [classes]);
  const live = notes.filter((n) => !n.deletedAt).sort(byRecent);
  const trash = notes.filter((n) => n.deletedAt).sort((a, b) => b.deletedAt! - a.deletedAt!);
  const unsorted = live.filter((n) => !n.classId || !classMap.has(n.classId));

  const query = q.trim().toLowerCase();
  const results = query
    ? live.filter((n) =>
        [n.title, n.topic, kindInfo(n.kind).label, classMap.get(n.classId ?? '')?.name ?? '']
          .join(' ')
          .toLowerCase()
          .includes(query),
      )
    : [];

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <input
          ref={searchRef}
          type="search"
          className="search"
          placeholder="Find note…  (Ctrl+K)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results[0]) {
              void openNote(results[0].id);
              setQ('');
              searchRef.current?.blur();
            }
            if (e.key === 'Escape') {
              setQ('');
              searchRef.current?.blur();
            }
          }}
        />
        <button className="new-note" onClick={() => useUI.setState({ newNote: { open: true } })} title="New note (Alt+N)">
          + New note
        </button>
      </div>

      <div className="sidebar-scroll">
        {query ? (
          <Section title={`Results (${results.length})`}>
            {results.map((n) => (
              <NoteRow key={n.id} note={n} cls={classMap.get(n.classId ?? '')} classes={classes} showClass />
            ))}
            {!results.length && <div className="empty">Nothing found.</div>}
          </Section>
        ) : (
          <>
            {live.length > 0 && (
              <Section title="Recent">
                {live.slice(0, 5).map((n) => (
                  <NoteRow key={n.id} note={n} cls={classMap.get(n.classId ?? '')} classes={classes} showClass />
                ))}
              </Section>
            )}

            <Section
              title="Classes"
              action={
                <button
                  className="icon-btn"
                  title="Add class"
                  onClick={() => {
                    setAddingClass(true);
                    setAddKey((k) => k + 1);
                  }}
                >
                  +
                </button>
              }
            >
              {(addingClass || classes.length === 0) && (
                <div className="add-class">
                  <AddClassInput key={addKey} autoFocus={addKey > 0} onClose={() => setAddingClass(false)} />
                  {classes.length === 0 && <div className="empty">Add your classes – comma separated.</div>}
                </div>
              )}
              {sortClasses(classes).map((c) => (
                <ClassSection
                  key={c.id}
                  cls={c}
                  notes={live.filter((n) => n.classId === c.id)}
                  classes={classes}
                  collapsed={!!collapsed['c:' + c.id]}
                />
              ))}
            </Section>

            {unsorted.length > 0 && (
              <Section title="Unsorted" dropClassId={null}>
                {unsorted.map((n) => (
                  <NoteRow key={n.id} note={n} classes={classes} />
                ))}
              </Section>
            )}

            {trash.length > 0 && (
              <div className="section">
                <div className="section-title clickable" onClick={() => toggleCollapsed('trashOpen')}>
                  <span>{collapsed.trashOpen ? '▾' : '▸'} Trash ({trash.length})</span>
                  {collapsed.trashOpen && (
                    <button
                      className="link-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        void emptyTrash();
                      }}
                    >
                      Empty
                    </button>
                  )}
                </div>
                {collapsed.trashOpen &&
                  trash.map((n) => (
                    <div key={n.id} className="note-row trashed">
                      <span className="note-title">{n.title}</span>
                      <button className="link-btn" onClick={() => void restoreNote(n.id)}>
                        Restore
                      </button>
                      <button className="link-btn danger" title="Delete forever" onClick={() => void purgeNote(n.id)}>
                        ×
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </>
        )}
      </div>
      <Account />
    </aside>
  );
}

/** Pole „dodaj klasy”: Enter albo wyjście z pola dodaje wpisane klasy (po przecinku), Escape zamyka. */
function AddClassInput({ autoFocus, onClose }: { autoFocus: boolean; onClose: () => void }) {
  const [v, setV] = useState('');
  const commit = () => {
    if (v.trim()) void addClasses(v);
    setV('');
    onClose();
  };
  return (
    <input
      className="inline-edit"
      autoFocus={autoFocus}
      value={v}
      placeholder="e.g. 7A, 7B, 8C"
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setV('');
          onClose();
        }
      }}
    />
  );
}

function Section(props: { title: string; action?: React.ReactNode; children: React.ReactNode; dropClassId?: string | null }) {
  const { className, ...dropHandlers } = useDrop(props.dropClassId);
  return (
    <div className={'section ' + (className ?? '')} {...dropHandlers}>
      <div className="section-title">
        <span>{props.title}</span>
        {props.action}
      </div>
      {props.children}
    </div>
  );
}

/** Upuszczenie notatki na klasę przenosi ją tam. */
function useDrop(classId: string | null | undefined) {
  const [over, setOver] = useState(false);
  return {
    className: over ? 'drop-over' : undefined,
    onDragOver: (e: React.DragEvent) => {
      if (classId === undefined || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      setOver(false);
      const id = e.dataTransfer.getData(DRAG_TYPE);
      if (id && classId !== undefined) {
        e.preventDefault();
        void updateNote(id, { classId });
      }
    },
  };
}

function ClassSection({ cls, notes, classes, collapsed }: { cls: ClassGroup; notes: NoteMeta[]; classes: ClassGroup[]; collapsed: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const allCollapsed = useUI((s) => s.collapsed);
  const drop = useDrop(cls.id);

  // tematy posortowane wg ostatniej aktywności; notatki bez tematu na końcu
  const topics = new Map<string, NoteMeta[]>();
  for (const n of notes) {
    if (!n.topic) continue;
    if (!topics.has(n.topic)) topics.set(n.topic, []);
    topics.get(n.topic)!.push(n);
  }
  const noTopic = notes.filter((n) => !n.topic);

  const menu = (e: React.MouseEvent) =>
    openMenu(e, [
      { label: 'New note here', onClick: () => void createNote({ classId: cls.id }) },
      { label: 'Rename', onClick: () => setRenaming(true) },
      { label: 'Color', header: true },
      ...CLASS_COLORS.map((c): MenuItem => ({ label: '', swatch: c, checked: c === cls.color, onClick: () => void setClassColor(cls.id, c) })),
      { label: 'Delete class', danger: true, onClick: () => void deleteClass(cls.id) },
    ]);

  return (
    <div className={'class-section ' + (drop.className ?? '')} onDragOver={drop.onDragOver} onDragLeave={drop.onDragLeave} onDrop={drop.onDrop}>
      <div className="class-row" onClick={() => toggleCollapsed('c:' + cls.id)} onContextMenu={menu}>
        <span className="caret">{collapsed ? '▸' : '▾'}</span>
        <span className="class-dot" style={{ background: cls.color }} />
        {renaming ? (
          <InlineEdit
            value={cls.name}
            onDone={(v) => {
              setRenaming(false);
              if (v) void renameClass(cls.id, v);
            }}
          />
        ) : (
          <span className="class-name" onDoubleClick={(e) => { e.stopPropagation(); setRenaming(true); }}>
            {cls.name}
          </span>
        )}
        <span className="count">{notes.length || ''}</span>
        <button
          className="icon-btn hover-only"
          title={`New note in ${cls.name}`}
          onClick={(e) => {
            e.stopPropagation();
            void createNote({ classId: cls.id });
          }}
        >
          +
        </button>
        <button className="icon-btn hover-only" title="More" onClick={menu}>
          ⋯
        </button>
      </div>

      {!collapsed && (
        <div className="class-body">
          {[...topics.entries()].map(([topic, ns]) => {
            const key = `t:${cls.id}:${topic}`;
            const tc = !!allCollapsed[key];
            return (
              <div key={topic} className="topic">
                <div className="topic-row" onClick={() => toggleCollapsed(key)}>
                  <span className="caret">{tc ? '▸' : '▾'}</span>
                  <span className="topic-name">{topic}</span>
                  <span className="count">{ns.length}</span>
                  <button
                    className="icon-btn hover-only"
                    title={`New note: ${cls.name} – ${topic}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void createNote({ classId: cls.id, topic });
                    }}
                  >
                    +
                  </button>
                </div>
                {!tc && ns.map((n) => <NoteRow key={n.id} note={n} classes={classes} hideTopic />)}
              </div>
            );
          })}
          {noTopic.map((n) => (
            <NoteRow key={n.id} note={n} classes={classes} />
          ))}
          {!notes.length && <div className="empty">No notes yet – click + to start.</div>}
        </div>
      )}
    </div>
  );
}

function NoteRow({ note, cls, classes, showClass, hideTopic }: {
  note: NoteMeta;
  cls?: ClassGroup;
  classes: ClassGroup[];
  showClass?: boolean;
  hideTopic?: boolean;
}) {
  const current = useUI((s) => s.currentNoteId === note.id);
  const [renaming, setRenaming] = useState(false);
  const info = kindInfo(note.kind);
  // w grupie tematu nazwa „Lesson – Fractions · 3 Oct” powtarzałaby temat
  const shown = hideTopic && note.autoTitle ? note.title.replace(` – ${note.topic}`, '') : note.title;

  const menu = (e: React.MouseEvent) =>
    openMenu(e, [
      { label: 'Rename', onClick: () => setRenaming(true) },
      { label: 'Duplicate', onClick: () => void duplicateNote(note.id) },
      { label: 'Move to', header: true },
      ...sortClasses(classes).map((c): MenuItem => ({
        label: c.name,
        swatch: c.color,
        checked: note.classId === c.id,
        onClick: () => void updateNote(note.id, { classId: c.id }),
      })),
      { label: 'Unsorted', checked: !note.classId, onClick: () => void updateNote(note.id, { classId: null }) },
      { label: 'Move to trash', danger: true, onClick: () => void trashNote(note.id) },
    ]);

  return (
    <div
      className={'note-row' + (current ? ' current' : '')}
      draggable={!renaming}
      onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, note.id)}
      onClick={() => void openNote(note.id)}
      onDoubleClick={() => setRenaming(true)}
      onContextMenu={menu}
      title={note.autoTitle ? 'Double-click to rename' : undefined}
    >
      <span className="kind-icon" title={info.label}>{info.icon}</span>
      {renaming ? (
        <InlineEdit
          value={note.autoTitle ? '' : note.title}
          placeholder={note.title}
          onDone={(v) => {
            setRenaming(false);
            if (v !== null) void renameNote(note.id, v);
          }}
        />
      ) : (
        <span className="note-title">{shown}</span>
      )}
      {showClass && cls && (
        <span className="class-tag" style={{ background: cls.color + '22', color: cls.color }}>{cls.name}</span>
      )}
      <span className="note-date">{relDate(note.updatedAt)}</span>
      <button className="icon-btn hover-only" title="More" onClick={menu}>
        ⋯
      </button>
    </div>
  );
}
