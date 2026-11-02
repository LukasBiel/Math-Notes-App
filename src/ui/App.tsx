import { useEffect, useState } from 'react';
import { bootstrap } from '../data/notes';
import { initSync } from '../data/sync';
import { BoardView } from './BoardView';
import { Toolbar } from './Toolbar';
import { Sidebar } from './Sidebar';
import { NoteHeader } from './NoteHeader';
import { NewNoteDialog } from './NewNoteDialog';
import { ExportDialog } from './ExportDialog';
import { PdfImportDialog } from './PdfImportDialog';
import { InlineEdit } from './InlineEdit';
import { SelectionBar } from './SelectionBar';
import { ContextMenu, Hints, Toast, TopicDatalist } from './Overlays';
import { useUI } from './store';

let booting: Promise<void> | null = null;

export function App() {
  const [ready, setReady] = useState(false);
  const noteId = useUI((s) => s.currentNoteId);
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const reload = useUI((s) => s.boardReload);

  useEffect(() => {
    (booting ??= bootstrap().then(() => {
      void initSync();
    })).then(() => setReady(true));
  }, []);

  return (
    <div className="app">
      {sidebarOpen && <Sidebar />}
      <main className="main">
        {ready && noteId && <BoardView key={noteId + ':' + reload} noteId={noteId} />}
        <div className="topbar">
          <NoteHeader />
          <Toolbar />
        </div>
        <Hints />
        <FrameNameEdit />
        <SelectionBar />
      </main>
      <NewNoteDialog />
      <ExportDialog />
      <PdfImportDialog />
      <ContextMenu />
      <Toast />
      <TopicDatalist />
    </div>
  );
}

/** Zmiana nazwy strony – pole w miejscu etykiety na tablicy. */
function FrameNameEdit() {
  const edit = useUI((s) => s.frameEdit);
  if (!edit) return null;
  return (
    <div className="frame-edit" style={{ left: edit.x, top: edit.y - 4 }}>
      <InlineEdit
        value={edit.value}
        placeholder="Page name"
        onDone={(v) => {
          useUI.setState({ frameEdit: null });
          if (v !== null) useUI.getState().api?.renameFrame(edit.id, v);
        }}
      />
    </div>
  );
}
