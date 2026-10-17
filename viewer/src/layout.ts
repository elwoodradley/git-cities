/**
 * City layout: a squarified treemap over the directory tree of every file
 * that ever existed. Computed once from the whole timeline so buildings never
 * move; files that don't exist yet are simply flat.
 *
 * Footprint area ∝ sqrt(file lifetime in days + 7): old files get big lots.
 * Directories with too many direct files have their smallest ones merged into
 * one aggregate "block" building.
 */
import type { FileStats, Timeline } from "./timeline";
import { DAY } from "./timeline";

export interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface Building {
  rect: Rect;
  /** Files represented (one, or many for an aggregate block). */
  files: number[];
  /** Directory path ("" for root). */
  dir: string;
  depth: number;
  /** Lower-cased extension of the (first) file, for colouring. */
  ext: string;
  aggregate: boolean;
}

export interface District {
  rect: Rect;
  path: string;
  name: string;
  depth: number;
  fileCount: number;
}

export interface Layout {
  buildings: Building[];
  /** file id → building index */
  fileBuilding: Int32Array;
  districts: District[];
  /** Overall extent (square-ish) */
  bounds: Rect;
}

export interface LayoutOptions {
  /** Max direct files per directory before aggregation kicks in. */
  maxFilesPerDir: number;
  /** Padding around a directory's contents, in world units, per depth. */
  padding: number;
  /** Gap between buildings as a fraction of the lot. */
  gap: number;
}

export const defaultLayoutOptions: LayoutOptions = { maxFilesPerDir: 48, padding: 1.2, gap: 0.18 };

interface Node {
  name: string;
  path: string;
  depth: number;
  dirs: Map<string, Node>;
  files: { id: number; w: number }[];
  weight: number;
  fileCount: number;
}

function fileWeight(s: FileStats): number {
  const days = Math.max(0, (s.died - s.born) / DAY);
  return Math.sqrt(days + 7);
}

function buildTree(tl: Timeline, stats: FileStats[]): Node {
  const root: Node = { name: "", path: "", depth: 0, dirs: new Map(), files: [], weight: 0, fileCount: 0 };
  tl.files.forEach((path, id) => {
    const parts = path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = {
          name: parts[i],
          path: node.path ? `${node.path}/${parts[i]}` : parts[i],
          depth: node.depth + 1,
          dirs: new Map(),
          files: [],
          weight: 0,
          fileCount: 0,
        };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.push({ id, w: fileWeight(stats[id]) });
  });
  return root;
}

/** Items to lay out inside a directory: a sub-dir or a file / aggregate. */
type Item = { w: number; dir?: Node; files?: number[]; ext: string; aggregate: boolean };

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : base.toLowerCase();
}

function collapseDirs(node: Node): void {
  // Merge single-child chains (a/b/c with nothing else) so padding doesn't explode.
  for (const [name, child] of [...node.dirs]) {
    collapseDirs(child);
    if (child.files.length === 0 && child.dirs.size === 1) {
      const [gname, grand] = [...child.dirs][0];
      node.dirs.delete(name);
      grand.name = `${name}/${gname}`;
      grand.depth = node.depth + 1;
      node.dirs.set(grand.name, grand);
    }
  }
}

function computeWeights(node: Node, opts: LayoutOptions): number {
  let w = 0;
  node.fileCount = node.files.length;
  for (const f of node.files) w += f.w;
  for (const d of node.dirs.values()) {
    w += computeWeights(d, opts);
    node.fileCount += d.fileCount;
  }
  // Padding costs area: reserve a border proportional to the perimeter.
  const side = Math.sqrt(w);
  node.weight = w + 4 * side * opts.padding + 4 * opts.padding * opts.padding;
  return node.weight;
}

/** Squarified treemap (Bruls, Huizing, van Wijk). Returns rects in item order. */
export function squarify(weights: number[], rect: Rect): Rect[] {
  const n = weights.length;
  const out: Rect[] = new Array(n);
  if (n === 0) return out;
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    for (let i = 0; i < n; i++) out[i] = { x: rect.x, z: rect.z, w: 0, d: 0 };
    return out;
  }
  const scale = (rect.w * rect.d) / total;
  const order = [...weights.keys()].sort((a, b) => weights[b] - weights[a]);
  let x = rect.x, z = rect.z, w = rect.w, d = rect.d;
  let row: number[] = [];
  let rowArea = 0;

  const worst = (areas: number, min: number, max: number, side: number): number => {
    const s2 = side * side;
    return Math.max((s2 * max) / (areas * areas), (areas * areas) / (s2 * min));
  };

  const layoutRow = () => {
    const horizontal = w >= d; // lay the row along the shorter side
    const side = horizontal ? d : w;
    const thickness = side > 0 ? rowArea / side : 0;
    let off = 0;
    for (const i of row) {
      const a = weights[i] * scale;
      const len = thickness > 0 ? a / thickness : 0;
      out[i] = horizontal
        ? { x, z: z + off, w: thickness, d: len }
        : { x: x + off, z, w: len, d: thickness };
      off += len;
    }
    if (horizontal) {
      x += thickness;
      w -= thickness;
    } else {
      z += thickness;
      d -= thickness;
    }
    row = [];
    rowArea = 0;
  };

  let rowMin = Infinity, rowMax = 0;
  for (const i of order) {
    const a = weights[i] * scale;
    if (a <= 0) {
      out[i] = { x, z, w: 0, d: 0 };
      continue;
    }
    const side = Math.min(w, d);
    if (row.length === 0) {
      row.push(i);
      rowArea = a;
      rowMin = rowMax = a;
      continue;
    }
    const cur = worst(rowArea, rowMin, rowMax, side);
    const next = worst(rowArea + a, Math.min(rowMin, a), Math.max(rowMax, a), side);
    if (next <= cur) {
      row.push(i);
      rowArea += a;
      rowMin = Math.min(rowMin, a);
      rowMax = Math.max(rowMax, a);
    } else {
      layoutRow();
      row.push(i);
      rowArea = a;
      rowMin = rowMax = a;
    }
  }
  if (row.length) layoutRow();
  return out;
}

export function computeLayout(tl: Timeline, stats: FileStats[], opts: LayoutOptions = defaultLayoutOptions): Layout {
  const root = buildTree(tl, stats);
  collapseDirs(root);
  computeWeights(root, opts);

  const buildings: Building[] = [];
  const districts: District[] = [];
  const fileBuilding = new Int32Array(tl.files.length).fill(-1);

  const side = Math.sqrt(root.weight);
  const bounds: Rect = { x: -side / 2, z: -side / 2, w: side, d: side };

  const place = (node: Node, rect: Rect) => {
    districts.push({ rect, path: node.path, name: node.name, depth: node.depth, fileCount: node.fileCount });
    const p = Math.min(opts.padding, rect.w / 4, rect.d / 4);
    const inner: Rect = { x: rect.x + p, z: rect.z + p, w: rect.w - 2 * p, d: rect.d - 2 * p };

    const items: Item[] = [];
    for (const d of node.dirs.values()) items.push({ w: d.weight, dir: d, ext: "", aggregate: false });
    const files = [...node.files].sort((a, b) => b.w - a.w);
    const keep = files.length > opts.maxFilesPerDir ? files.slice(0, opts.maxFilesPerDir - 1) : files;
    for (const f of keep) items.push({ w: f.w, files: [f.id], ext: extOf(tl.files[f.id]), aggregate: false });
    if (keep.length < files.length) {
      const rest = files.slice(keep.length);
      items.push({
        w: rest.reduce((a, f) => a + f.w, 0),
        files: rest.map((f) => f.id),
        ext: extOf(tl.files[rest[0].id]),
        aggregate: true,
      });
    }
    const rects = squarify(items.map((i) => i.w), inner);
    items.forEach((item, i) => {
      const r = rects[i];
      if (item.dir) {
        place(item.dir, r);
        return;
      }
      const g = Math.min(opts.gap * Math.min(r.w, r.d), 0.6);
      const lot: Rect = { x: r.x + g / 2, z: r.z + g / 2, w: Math.max(r.w - g, 0.05), d: Math.max(r.d - g, 0.05) };
      const idx = buildings.length;
      buildings.push({ rect: lot, files: item.files!, dir: node.path, depth: node.depth, ext: item.ext, aggregate: item.aggregate });
      for (const f of item.files!) fileBuilding[f] = idx;
    });
  };
  place(root, bounds);
  return { buildings, fileBuilding, districts, bounds };
}
