import { describe, expect, it } from "vitest";
import { computeLayout, defaultLayoutOptions, squarify, type Rect } from "./layout";
import { fileStats, type Timeline } from "./timeline";

function contains(outer: Rect, inner: Rect, eps = 1e-6): boolean {
  return (
    inner.x >= outer.x - eps &&
    inner.z >= outer.z - eps &&
    inner.x + inner.w <= outer.x + outer.w + eps &&
    inner.z + inner.d <= outer.z + outer.d + eps
  );
}

function overlaps(a: Rect, b: Rect, eps = 1e-6): boolean {
  return a.x + a.w > b.x + eps && b.x + b.w > a.x + eps && a.z + a.d > b.z + eps && b.z + b.d > a.z + eps;
}

describe("squarify", () => {
  it("tiles the rect exactly with areas proportional to weights", () => {
    const rect = { x: -5, z: 2, w: 40, d: 25 };
    const weights = [10, 5, 5, 3, 2, 1, 1, 1];
    const rects = squarify(weights, rect);
    const total = weights.reduce((a, b) => a + b, 0);
    let area = 0;
    rects.forEach((r, i) => {
      expect(contains(rect, r)).toBe(true);
      expect(r.w * r.d).toBeCloseTo((weights[i] / total) * rect.w * rect.d, 6);
      area += r.w * r.d;
      for (let j = 0; j < i; j++) expect(overlaps(r, rects[j])).toBe(false);
    });
    expect(area).toBeCloseTo(rect.w * rect.d, 6);
  });

  it("handles degenerate inputs", () => {
    expect(squarify([], { x: 0, z: 0, w: 1, d: 1 })).toEqual([]);
    const zero = squarify([0, 0], { x: 0, z: 0, w: 1, d: 1 });
    expect(zero.every((r) => r.w === 0 && r.d === 0)).toBe(true);
    const one = squarify([7], { x: 1, z: 1, w: 3, d: 2 });
    expect(one[0]).toEqual({ x: 1, z: 1, w: 3, d: 2 });
  });
});

function timeline(files: string[], commits: Timeline["commits"]): Timeline {
  return { version: 1, repo: "t", range: [commits[0].t, commits[commits.length - 1].t], authors: [{ name: "a", email: "", commits: commits.length }], files, commits };
}

describe("computeLayout", () => {
  it("places every file in a building inside its district, with no overlaps", () => {
    const files = ["README.md", "src/a.ts", "src/b.ts", "src/util/c.ts", "docs/d.md"];
    const t0 = 1_600_000_000;
    const tl = timeline(files, [
      { h: "1", a: 0, t: t0, m: "init", c: files.map((_, i) => [i, 100, 0, 100, 1]) },
      { h: "2", a: 0, t: t0 + 86400 * 400, m: "later", c: [[1, 10, 0, 110, 0]] },
    ]);
    const layout = computeLayout(tl, fileStats(tl));
    expect(layout.buildings.length).toBe(files.length);
    for (let f = 0; f < files.length; f++) {
      const b = layout.buildings[layout.fileBuilding[f]];
      expect(b.files).toContain(f);
      const district = layout.districts.find((d) => d.path === b.dir)!;
      expect(district).toBeDefined();
      expect(contains(district.rect, b.rect)).toBe(true);
      expect(contains(layout.bounds, b.rect)).toBe(true);
    }
    for (let i = 0; i < layout.buildings.length; i++)
      for (let j = 0; j < i; j++) expect(overlaps(layout.buildings[i].rect, layout.buildings[j].rect)).toBe(false);
    // src/util collapses into src? No: src has files of its own, so util stays a child district.
    expect(layout.districts.map((d) => d.path)).toEqual(expect.arrayContaining(["", "src", "src/util", "docs"]));
  });

  it("aggregates tiny files in crowded directories, but never big ones", () => {
    const n = 200;
    const files = Array.from({ length: n }, (_, i) => `pkg/f${i}.py`);
    const t0 = 1_600_000_000;
    const tl = timeline(files, [
      { h: "1", a: 0, t: t0, m: "init", c: files.map((_, i) => [i, i < 20 ? 500 : 5, 0, i < 20 ? 500 : 5, 1]) },
      { h: "2", a: 0, t: t0 + 86400 * 1000, m: "end", c: [[0, 1, 0, 501, 0]] },
    ]);
    const layout = computeLayout(tl, fileStats(tl), { ...defaultLayoutOptions, maxFilesPerDir: 50, chunk: 16 });
    const big = layout.buildings.filter((b) => !b.aggregate);
    const blocks = layout.buildings.filter((b) => b.aggregate);
    expect(big.length).toBe(20);
    expect(blocks.length).toBe(Math.ceil(180 / 16));
    expect(blocks.every((b) => b.files.length <= 16)).toBe(true);
    const covered = new Set(layout.buildings.flatMap((b) => b.files));
    expect(covered.size).toBe(n);
  });

  it("is deterministic", () => {
    const files = ["a", "b/c", "b/d", "e/f/g"];
    const t0 = 1_600_000_000;
    const tl = timeline(files, [{ h: "1", a: 0, t: t0, m: "init", c: files.map((_, i) => [i, 10 * (i + 1), 0, 10 * (i + 1), 1]) }]);
    const a = computeLayout(tl, fileStats(tl));
    const b = computeLayout(tl, fileStats(tl));
    expect(JSON.stringify(a.buildings)).toBe(JSON.stringify(b.buildings));
  });
});
