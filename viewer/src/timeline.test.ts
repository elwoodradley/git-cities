import { describe, expect, it } from "vitest";
import { ADD, DELETE, MODIFY, RENAME, Simulation, fileStats, type Timeline, type SimEvent } from "./timeline";

const t0 = 1_600_000_000;
const D = 86400;

const tl: Timeline = {
  version: 1,
  repo: "t",
  range: [t0, t0 + 4 * D],
  authors: [
    { name: "ada", email: "", commits: 3 },
    { name: "bob", email: "", commits: 2 },
  ],
  files: ["a.py", "b.py", "c.py"],
  commits: [
    { h: "1", a: 0, t: t0, m: "add a b", c: [[0, 10, 0, 10, ADD], [1, 20, 0, 20, ADD]] },
    { h: "2", a: 1, t: t0 + D, m: "grow a", c: [[0, 5, 0, 15, MODIFY]] },
    { h: "3", a: 0, t: t0 + 2 * D, m: "rename b→c", c: [[2, 0, 0, 20, RENAME, 1]] },
    { h: "4", a: 1, t: t0 + 3 * D, m: "shrink a", c: [[0, 0, 10, 5, MODIFY]] },
    { h: "5", a: 0, t: t0 + 4 * D, m: "delete c", c: [[2, 0, 20, 0, DELETE]] },
  ],
};

describe("Simulation", () => {
  it("advances through commits and reports events", () => {
    const sim = new Simulation(tl);
    const events: SimEvent[] = [];
    sim.advance(t0 + 1.5 * D, (e) => events.push(e));
    expect(events.map((e) => e.commit.h)).toEqual(["1", "2"]);
    expect(events[0].born).toEqual([0, 1]);
    expect(events[1].grew).toEqual([0]);
    expect(sim.lines[0]).toBe(15);
    expect(sim.aliveCount).toBe(2);
    expect(sim.totalLines).toBe(35);
    expect(sim.authorCommits[0]).toBe(1);
    expect(sim.authorCommits[1]).toBe(1);

    sim.advance(t0 + 2 * D, (e) => events.push(e));
    const ren = events[2];
    expect(ren.moved).toEqual([[1, 2]]);
    expect(ren.born).toEqual([]);
    expect(sim.alive[1]).toBe(0);
    expect(sim.alive[2]).toBe(1);
    expect(sim.lines[2]).toBe(20);
    expect(sim.aliveCount).toBe(2);
    expect(sim.totalLines).toBe(35);

    sim.advance(t0 + 10 * D, (e) => events.push(e));
    expect(events[3].shrank).toEqual([0]);
    expect(events[4].died).toEqual([2]);
    expect(sim.aliveCount).toBe(1);
    expect(sim.totalLines).toBe(5);
    expect(sim.done).toBe(true);
  });

  it("seek reproduces the same state as advancing", () => {
    const a = new Simulation(tl);
    a.advance(t0 + 3 * D);
    const b = new Simulation(tl);
    b.advance(t0 + 10 * D);
    b.seek(t0 + 3 * D);
    expect(Array.from(b.lines)).toEqual(Array.from(a.lines));
    expect(Array.from(b.alive)).toEqual(Array.from(a.alive));
    expect(b.cursor).toBe(a.cursor);
    expect(b.aliveCount).toBe(a.aliveCount);
    expect(b.totalLines).toBe(a.totalLines);
    expect(Array.from(b.authorCommits)).toEqual(Array.from(a.authorCommits));
  });

  it("tolerates a delete of an already-dead file", () => {
    const weird: Timeline = { ...tl, commits: [tl.commits[0], { h: "x", a: 0, t: t0 + D, m: "", c: [[2, 0, 0, 0, DELETE]] }] };
    const sim = new Simulation(weird);
    sim.advance(t0 + 2 * D);
    expect(sim.aliveCount).toBe(2);
    expect(sim.totalLines).toBe(30);
  });
});

describe("fileStats", () => {
  it("computes birth, death, peak and touches", () => {
    const s = fileStats(tl);
    expect(s[0]).toEqual({ born: t0, died: t0 + 4 * D, peak: 15, touches: 3 });
    expect(s[1].born).toBe(t0);
    expect(s[1].died).toBe(t0 + 2 * D); // renamed away
    expect(s[2].born).toBe(t0 + 2 * D);
    expect(s[2].died).toBe(t0 + 4 * D);
    expect(s[2].peak).toBe(20);
  });
});
