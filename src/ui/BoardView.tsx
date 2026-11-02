import { useEffect, useRef } from 'react';
import { Board } from '../engine/board';
import { db } from '../data/db';
import { saveNoteContent } from '../data/notes';

export function BoardView({ noteId }: { noteId: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let board: Board | null = null;
    let dead = false;
    Promise.all([db.notes.get(noteId), db.docs.get(noteId)]).then(([note, doc]) => {
      if (dead || !ref.current) return;
      const images = {
        get: async (id: string) => (await db.images.get(id))?.dataUrl,
        put: async (id: string, dataUrl: string) => void (await db.images.put({ id, dataUrl })),
      };
      board = new Board(ref.current, { doc: doc?.elements ?? [], cam: note?.cam, images }, (els, cam, changed) => {
        void saveNoteContent(noteId, els, cam, changed);
      });
    });
    return () => {
      dead = true;
      board?.destroy();
    };
  }, [noteId]);

  return <div ref={ref} className="board" />;
}
