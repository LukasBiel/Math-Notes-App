/** x, y w jednostkach świata; p = nacisk 0..1 */
export type Point = [x: number, y: number, p: number];

export interface Stroke {
  id: string;
  type: 'stroke';
  points: Point[];
  color: string;
  /** grubość w jednostkach świata (kratka = 20) */
  width: number;
  /** czy grubość zależy od nacisku */
  pressure: boolean;
  /** linia prosta: rysowana tylko z pierwszego i ostatniego punktu */
  straight: boolean;
  /** wygładzanie (streamline z perfect-freehand) użyte przy rysowaniu */
  streamline: number;
}

export type Orientation = 'portrait' | 'landscape';

/** Strona A4 do eksportu PDF. Kolejność stron wynika z położenia (wiersze od góry, w wierszu od lewej). */
export interface Frame {
  id: string;
  type: 'frame';
  x: number;
  y: number;
  w: number;
  h: number;
  /** pusta = „Page N” */
  name: string;
}

/** Wklejony obrazek; sam plik leży osobno (tabela images), tu tylko odnośnik. */
export interface ImageEl {
  id: string;
  type: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  imageId: string;
}

export type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse' | 'triangle' | 'angle' | 'axes' | 'numberline';

/**
 * Figura geometryczna. Znaczenie punktów zależy od rodzaju:
 * line/arrow: [początek, koniec]; rect/ellipse/triangle: [róg, róg przeciwny];
 * angle: [wierzchołek, ramię 1, ramię 2]; axes: [róg, róg, początek układu]; numberline: [lewy, prawy, zero].
 */
export interface Shape {
  id: string;
  type: 'shape';
  kind: ShapeKind;
  pts: [number, number][];
  color: string;
  width: number;
  /** trójkąt prostokątny (kąt prosty w lewym dolnym rogu) */
  right?: boolean;
  /** długość jednostki na osiach (świat) */
  unit?: number;
}

export type El = Stroke | Frame | ImageEl | Shape;

/** A4 przy 96 dpi – kratka 20 ≈ 5 mm, jak w zeszycie */
export const A4 = { portrait: [794, 1123], landscape: [1123, 794] } as const;

/** ekran = (świat - {x, y}) * z */
export interface Camera {
  x: number;
  y: number;
  z: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
