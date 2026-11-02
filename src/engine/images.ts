/** Dłuższy bok wklejonego obrazka (px) – większe są zmniejszane. */
const MAX_SIDE = 2000;
/** Powyżej tej wielkości (znaki data URL) PNG zamieniamy na JPEG. */
const PNG_LIMIT = 1_500_000;

/** Zmniejsza i kompresuje obrazek, żeby notatka i synchronizacja nie puchły. */
export async function prepareImage(file: Blob): Promise<{ dataUrl: string; w: number; h: number }> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k);
  const h = Math.round(bmp.height * k);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#fff'; // PDF i JPEG nie lubią przezroczystości
  c.fillRect(0, 0, w, h);
  c.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  let dataUrl = canvas.toDataURL('image/png');
  if (dataUrl.length > PNG_LIMIT) dataUrl = canvas.toDataURL('image/jpeg', 0.88);
  return { dataUrl, w, h };
}
