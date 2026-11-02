import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useUI } from '../ui/store';
import { showToast } from '../data/notes';

/** Strona PDF jako obrazek + jej rozmiar w punktach PDF (1/72 cala). */
export interface PdfPageImage {
  dataUrl: string;
  wPt: number;
  hPt: number;
}

/** Szerokość renderowanej strony w pikselach – ok. 190 dpi dla A4, ostre przy wydruku. */
const RENDER_WIDTH = 1600;
/** Powyżej tylu stron pytamy, które zaimportować. */
export const ASK_ABOVE = 12;

async function openPdf(file: Blob): Promise<PDFDocumentProxy> {
  // pdf.js ładujemy dopiero przy pierwszym imporcie
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
}

async function renderPage(doc: PDFDocumentProxy, n: number): Promise<PdfPageImage> {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: RENDER_WIDTH / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  page.cleanup();
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), wPt: base.width, hPt: base.height };
}

/** Start importu: otwiera plik; długi PDF → okno wyboru stron, krótki → od razu wszystkie. */
export async function startPdfImport(file: File) {
  if (!useUI.getState().api) return;
  let doc: PDFDocumentProxy;
  try {
    doc = await openPdf(file);
  } catch {
    showToast(`Could not open “${file.name}” – is it a valid, unlocked PDF?`);
    return;
  }
  const name = file.name.replace(/\.pdf$/i, '');
  if (doc.numPages > ASK_ABOVE) {
    useUI.setState({ pdfImport: { name, count: doc.numPages, doc } });
    return;
  }
  await runPdfImport(doc, name, 1, doc.numPages);
}

export async function runPdfImport(doc: PDFDocumentProxy, name: string, from: number, to: number) {
  const api = useUI.getState().api;
  if (!api) return;
  const total = to - from + 1;
  const pages: PdfPageImage[] = [];
  try {
    for (let n = from; n <= to; n++) {
      useUI.setState({ toast: { id: Date.now(), text: `Importing “${name}” – page ${n - from + 1} of ${total}…` } });
      pages.push(await renderPage(doc, n));
    }
    await api.insertPdfPages(pages);
    showToast(`Imported ${total} page${total > 1 ? 's' : ''} from “${name}” – write on them, then Export PDF`);
  } catch {
    showToast(`Import of “${name}” failed.`);
  } finally {
    void doc.loadingTask.destroy();
  }
}

/** Ukryte pole wyboru pliku – otwierane przyciskiem „Import PDF” albo Ctrl+O. */
export function pickPdfFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/pdf,.pdf';
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void startPdfImport(file);
  };
  input.click();
}
