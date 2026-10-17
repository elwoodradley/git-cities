/** Timeline format produced by `strata extract`, and the simulation that plays it. */

export const MODIFY = 0, ADD = 1, DELETE = 2, RENAME = 3;

export type Change = [file: number, added: number, removed: number, total: number, kind: number, old?: number];

export interface Commit {
  h: string;
  a: number;
  t: number;
  m: string;
  c: Change[];
}

export interface Author {
  name: string;
  email: string;
  commits: number;
}

export interface Timeline {
  version: number;
  repo: string;
  range: [number, number];
  authors: Author[];
  files: string[];
  commits: Commit[];
}

export async function loadTimeline(url: string): Promise<Timeline> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status}`);
  const tl = (await res.json()) as Timeline;
  if (tl.version !== 1) throw new Error(`unsupported timeline version ${tl.version}`);
  return tl;
}

/** Per-file facts derived from the whole timeline (used for layout). */
export interface FileStats {
  /** First time the file appeared. */
  born: number;
  /** Last time it was alive (or the timeline end if still alive). */
  died: number;
  /** Largest line count it ever had. */
  peak: number;
  /** Number of commits touching it. */
  touches: number;
}

export function fileStats(tl: Timeline): FileStats[] {
  const end = tl.range[1];
  const stats: FileStats[] = tl.files.map(() => ({ born: -1, died: end, peak: 0, touches: 0 }));
  for (const c of tl.commits) {
    for (const ch of c.c) {
      const s = stats[ch[0]];
      if (s.born < 0) s.born = c.t;
      s.touches++;
      if (ch[3] > s.peak) s.peak = ch[3];
      if (ch[4] === DELETE) s.died = c.t;
      else s.died = end;
      if (ch[4] === RENAME && ch[5] !== undefined) {
        const o = stats[ch[5]];
        if (o.born < 0) o.born = c.t;
        o.died = c.t;
      }
    }
  }
  for (const s of stats) if (s.born < 0) s.born = end;
  return stats;
}

/** An event emitted while stepping the simulation, consumed by the renderer. */
export interface SimEvent {
  commit: Commit;
  /** World-space effects are the renderer's business; we just report what changed. */
  grew: number[];
  shrank: number[];
  born: number[];
  died: number[];
  moved: [from: number, to: number][];
}

/**
 * The simulation: a cursor over the commits with per-file state.
 * All state is a pure function of (timeline, time), which makes scrubbing
 * and deterministic offline rendering straightforward.
 */
export class Simulation {
  readonly tl: Timeline;
  readonly lines: Float64Array;
  readonly alive: Uint8Array;
  /** Last time each file was touched, or -Infinity. */
  readonly touched: Float64Array;
  readonly authorLast: Float64Array;
  readonly authorCommits: Uint32Array;
  cursor = 0;
  time: number;
  aliveCount = 0;
  totalLines = 0;

  constructor(tl: Timeline) {
    this.tl = tl;
    this.lines = new Float64Array(tl.files.length);
    this.alive = new Uint8Array(tl.files.length);
    this.touched = new Float64Array(tl.files.length).fill(-Infinity);
    this.authorLast = new Float64Array(tl.authors.length).fill(-Infinity);
    this.authorCommits = new Uint32Array(tl.authors.length);
    this.time = tl.range[0];
  }

  /** Apply one commit, returning what changed. */
  private apply(c: Commit, ev?: SimEvent): void {
    this.authorLast[c.a] = c.t;
    this.authorCommits[c.a]++;
    for (const ch of c.c) {
      const f = ch[0];
      const before = this.lines[f];
      const wasAlive = this.alive[f];
      this.touched[f] = c.t;
      if (ch[4] === DELETE) {
        if (wasAlive) {
          this.aliveCount--;
          this.totalLines -= before;
          ev?.died.push(f);
        }
        this.alive[f] = 0;
        this.lines[f] = 0;
        continue;
      }
      if (ch[4] === RENAME && ch[5] !== undefined) {
        const o = ch[5];
        if (this.alive[o]) {
          this.aliveCount--;
          this.totalLines -= this.lines[o];
          this.alive[o] = 0;
          this.lines[o] = 0;
          this.touched[o] = c.t;
          ev?.moved.push([o, f]);
        }
      }
      if (!wasAlive) {
        this.aliveCount++;
        this.alive[f] = 1;
        if (ch[4] !== RENAME) ev?.born.push(f);
      }
      this.lines[f] = ch[3];
      this.totalLines += ch[3] - before;
      if (ev && wasAlive) {
        if (ch[3] > before) ev.grew.push(f);
        else if (ch[3] < before) ev.shrank.push(f);
      }
    }
  }

  /** Advance to `t`, calling `onCommit` for each commit crossed. */
  advance(t: number, onCommit?: (ev: SimEvent) => void): void {
    const commits = this.tl.commits;
    while (this.cursor < commits.length && commits[this.cursor].t <= t) {
      const c = commits[this.cursor++];
      if (onCommit) {
        const ev: SimEvent = { commit: c, grew: [], shrank: [], born: [], died: [], moved: [] };
        this.apply(c, ev);
        onCommit(ev);
      } else this.apply(c);
    }
    this.time = t;
  }

  /** Jump to `t` from scratch, without emitting events. */
  seek(t: number): void {
    this.lines.fill(0);
    this.alive.fill(0);
    this.touched.fill(-Infinity);
    this.authorLast.fill(-Infinity);
    this.authorCommits.fill(0);
    this.cursor = 0;
    this.aliveCount = 0;
    this.totalLines = 0;
    this.advance(t);
  }

  get done(): boolean {
    return this.cursor >= this.tl.commits.length;
  }
}

export const DAY = 86400;

export function formatDate(t: number): string {
  const d = new Date(t * 1000);
  return d.toISOString().slice(0, 10);
}

export function formatMonth(t: number): string {
  const d = new Date(t * 1000);
  return d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}
