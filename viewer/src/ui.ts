/** DOM overlay: date, stats, author legend, commit ticker and the control bar. */
import type { Theme } from "./themes";
import type { Timeline } from "./timeline";
import { formatDate, formatMonth } from "./timeline";

export interface UiCallbacks {
  onPlayToggle(): void;
  onSpeed(daysPerSec: number): void;
  onScrub(t: number): void;
  onTheme(name: string): void;
  onAutoCamera(on: boolean): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Slider (0..1000) ↔ days per second, log scale from 0.1 to 3000. */
export function sliderToSpeed(v: number): number {
  return 0.1 * Math.pow(30000, v / 1000);
}
export function speedToSlider(s: number): number {
  return (Math.log(s / 0.1) / Math.log(30000)) * 1000;
}

export function fmtSpeed(s: number): string {
  if (s >= 365) return `${(s / 365).toFixed(s >= 3650 ? 0 : 1)} y/s`;
  if (s >= 10) return `${s.toFixed(0)} d/s`;
  if (s >= 1) return `${s.toFixed(1)} d/s`;
  return `${(s * 24).toFixed(1)} h/s`;
}

export class Ui {
  private readonly tl: Timeline;
  private readonly legendRows: { el: HTMLElement; dot: HTMLElement; count: HTMLElement; author: number }[] = [];
  private tickerLines: HTMLElement[] = [];
  private lastLegend = -1;
  private scrubbing = false;

  constructor(tl: Timeline, cb: UiCallbacks, initial: { speed: number; theme: string; render: boolean }) {
    this.tl = tl;
    $("repo").textContent = tl.repo;
    $("range-from").textContent = formatDate(tl.range[0]);
    $("range-to").textContent = formatDate(tl.range[1]);
    if (initial.render) document.body.classList.add("render");

    const play = $<HTMLButtonElement>("play");
    play.onclick = () => cb.onPlayToggle();
    const speed = $<HTMLInputElement>("speed");
    speed.value = String(speedToSlider(initial.speed));
    $("speed-label").textContent = fmtSpeed(initial.speed);
    speed.oninput = () => {
      const s = sliderToSpeed(Number(speed.value));
      $("speed-label").textContent = fmtSpeed(s);
      cb.onSpeed(s);
    };
    const scrub = $<HTMLInputElement>("scrub");
    scrub.oninput = () => {
      this.scrubbing = true;
      const k = Number(scrub.value) / 10000;
      cb.onScrub(tl.range[0] + k * (tl.range[1] - tl.range[0]));
    };
    scrub.onchange = () => (this.scrubbing = false);
    const theme = $<HTMLSelectElement>("theme");
    theme.value = initial.theme;
    theme.onchange = () => cb.onTheme(theme.value);
    const autoCam = $<HTMLButtonElement>("auto-cam");
    autoCam.onclick = () => {
      autoCam.classList.toggle("toggled");
      cb.onAutoCamera(autoCam.classList.contains("toggled"));
    };

    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return;
      if (e.code === "Space") {
        e.preventDefault();
        cb.onPlayToggle();
      } else if (e.code === "KeyC") autoCam.click();
      else if (e.code === "ArrowRight" || e.code === "ArrowLeft") {
        const span = tl.range[1] - tl.range[0];
        const cur = Number(scrub.value) / 10000;
        const k = Math.min(1, Math.max(0, cur + (e.code === "ArrowRight" ? 0.01 : -0.01)));
        scrub.value = String(k * 10000);
        cb.onScrub(tl.range[0] + k * span);
      } else if (e.code === "ArrowUp" || e.code === "ArrowDown") {
        speed.value = String(Math.min(1000, Math.max(0, Number(speed.value) + (e.code === "ArrowUp" ? 50 : -50))));
        speed.dispatchEvent(new Event("input"));
      }
    });

    // Legend rows are created once for the top authors by lifetime commits;
    // their order/brightness is updated as activity moves.
    const legend = $("legend");
    const top = [...tl.authors.keys()].sort((a, b) => tl.authors[b].commits - tl.authors[a].commits).slice(0, 14);
    for (const a of top) {
      const el = document.createElement("div");
      el.className = "author";
      const name = document.createElement("span");
      name.textContent = tl.authors[a].name;
      const count = document.createElement("small");
      const dot = document.createElement("i");
      el.append(name, count, dot);
      legend.appendChild(el);
      this.legendRows.push({ el, dot, count, author: a });
    }
    const ticker = $("ticker");
    for (let i = 0; i < 5; i++) {
      const line = document.createElement("div");
      line.className = "line";
      ticker.appendChild(line);
      this.tickerLines.push(line);
    }
  }

  setLoading(fraction: number | null, text?: string): void {
    const el = $("loading");
    if (fraction === null) el.classList.add("hidden");
    else {
      $("loading-bar").style.width = `${Math.round(fraction * 100)}%`;
      if (text) $("loading-text").textContent = text;
    }
  }

  applyTheme(theme: Theme): void {
    const r = document.documentElement.style;
    r.setProperty("--fg", theme.ui.fg);
    r.setProperty("--dim", theme.ui.dim);
    r.setProperty("--accent", theme.ui.accent);
    r.setProperty("--panel", theme.ui.panel);
    document.body.style.background = `#${theme.background.getHexString()}`;
  }

  setPlaying(on: boolean): void {
    $("play").textContent = on ? "❚❚" : "▶";
  }

  setTime(t: number): void {
    $("date").textContent = formatDate(t);
    $("month").textContent = formatMonth(t);
    if (!this.scrubbing) {
      const k = (t - this.tl.range[0]) / Math.max(1, this.tl.range[1] - this.tl.range[0]);
      $<HTMLInputElement>("scrub").value = String(Math.round(k * 10000));
    }
  }

  setStats(commits: number, files: number, lines: number, authors: number): void {
    $("stats").innerHTML =
      `<span><b>${commits.toLocaleString()}</b> commits</span>` +
      `<span><b>${files.toLocaleString()}</b> files</span>` +
      `<span><b>${lines.toLocaleString()}</b> lines</span>` +
      `<span><b>${authors.toLocaleString()}</b> authors</span>`;
  }

  /** Update legend from per-author heat (0..1) and commit counts so far. */
  setLegend(heat: Float32Array, commits: Uint32Array, colors: { getHexString(): string }[], now: number): void {
    if (now - this.lastLegend < 0.2) return;
    this.lastLegend = now;
    for (const row of this.legendRows) {
      const h = heat[row.author];
      row.el.classList.toggle("active", h > 0.05);
      row.el.style.color = `#${colors[row.author].getHexString()}`;
      row.el.style.opacity = String(h > 0.05 ? 0.55 + 0.45 * h : commits[row.author] > 0 ? 0.35 : 0.12);
      row.count.textContent = commits[row.author] ? String(commits[row.author]) : "";
    }
  }

  pushCommit(sha: string, author: string, message: string, color: string): void {
    const last = this.tickerLines.pop()!;
    last.innerHTML = `<span class="sha">${sha.slice(0, 7)}</span> <span class="who" style="color:${color}">${escapeHtml(author)}</span> ${escapeHtml(message)}`;
    this.tickerLines.unshift(last);
    const ticker = $("ticker");
    ticker.prepend(last);
  }

  clearTicker(): void {
    for (const l of this.tickerLines) l.textContent = "";
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
