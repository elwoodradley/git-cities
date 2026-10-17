import * as THREE from "three";
import { AutoCamera } from "./camera";
import { City, defaultCityOptions } from "./city";
import { Drones } from "./drones";
import { computeLayout, defaultLayoutOptions } from "./layout";
import { Particles } from "./particles";
import { Post } from "./post";
import { getTheme, type Theme } from "./themes";
import { DAY, RENAME, Simulation, fileStats, loadTimeline, type SimEvent, type Timeline } from "./timeline";
import { Ui } from "./ui";

/** Query-string configuration. Everything has a sane default. */
interface Config {
  timeline: string;
  theme: string;
  /** Days of history per real second. */
  speed: number;
  /** Headless render mode: no RAF loop, frames driven via window.strata. */
  render: boolean;
  from: number | null;
  to: number | null;
  duration: number;
  fps: number;
  width: number;
  height: number;
  seed: number;
  autoplay: boolean;
  bloom: boolean;
}

function readConfig(): Config {
  const q = new URLSearchParams(location.search);
  const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
  const date = (k: string) => (q.has(k) ? Date.parse(q.get(k)!) / 1000 : null);
  return {
    timeline: q.get("timeline") ?? "timeline.json",
    theme: q.get("theme") ?? "neon",
    speed: num("speed", 30),
    render: q.get("render") === "1",
    from: date("from"),
    to: date("to"),
    duration: num("duration", 60),
    fps: num("fps", 60),
    width: num("width", 0),
    height: num("height", 0),
    seed: num("seed", 1337),
    autoplay: q.get("autoplay") !== "0",
    bloom: q.get("bloom") !== "0",
  };
}

class App {
  readonly cfg: Config;
  readonly tl: Timeline;
  readonly sim: Simulation;
  readonly city: City;
  readonly particles: Particles;
  readonly drones: Drones;
  readonly cam: AutoCamera;
  readonly post: Post;
  readonly ui: Ui;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  theme: Theme;
  playing: boolean;
  speed: number;
  /** Lines per building (sum over member files), mirrors sim state. */
  private readonly bLines: Float64Array;
  private readonly prevLines: Float64Array;
  private readonly tmpColor = new THREE.Color();
  private lastFrame = 0;
  private clock = 0;
  private endReached = false;

  constructor(cfg: Config, tl: Timeline) {
    this.cfg = cfg;
    this.tl = tl;
    this.theme = getTheme(cfg.theme);
    this.speed = cfg.speed;
    this.playing = cfg.autoplay && !cfg.render;

    const stats = fileStats(tl);
    const layout = computeLayout(tl, stats, defaultLayoutOptions);
    this.sim = new Simulation(tl);
    this.bLines = new Float64Array(layout.buildings.length);
    this.prevLines = new Float64Array(tl.files.length);

    const w = cfg.width || window.innerWidth, h = cfg.height || window.innerHeight;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: cfg.render,
    });
    this.renderer.setPixelRatio(cfg.render ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    document.getElementById("app")!.appendChild(this.renderer.domElement);

    this.city = new City(layout, this.theme, defaultCityOptions);
    this.scene.add(this.city.group);
    this.particles = new Particles();
    this.particles.reset(cfg.seed);
    this.scene.add(this.particles.points);
    this.drones = new Drones(tl.authors.length, this.theme, this.city.extent);
    this.scene.add(this.drones.group);
    this.cam = new AutoCamera(w / h, cfg.render ? null : this.renderer.domElement, this.city.extent);
    this.post = new Post(this.renderer, this.scene, this.cam.camera, w, h, this.theme);
    this.post.bloomEnabled = cfg.bloom;
    this.post.setTheme(this.theme);

    this.ui = new Ui(
      tl,
      {
        onPlayToggle: () => this.setPlaying(!this.playing),
        onSpeed: (s) => (this.speed = s),
        onScrub: (t) => this.seek(t),
        onTheme: (n) => this.setTheme(getTheme(n)),
        onAutoCamera: (on) => (this.cam.auto = on),
      },
      { speed: this.speed, theme: this.theme.name, render: cfg.render },
    );
    this.ui.applyTheme(this.theme);
    this.ui.setPlaying(this.playing);
    // Keep the HUD the same relative size whatever the output resolution.
    if (cfg.render) document.documentElement.style.setProperty("--hud-scale", String(h / 1080));
    this.applyThemeToScene();

    const start = cfg.from ?? tl.range[0];
    this.seek(start);
    this.cam.snapTo(0, 0);

    if (!cfg.render) {
      window.addEventListener("resize", () => this.resize());
      requestAnimationFrame((t) => this.loop(t));
    }
  }

  private applyThemeToScene(): void {
    this.scene.background = this.theme.background;
    this.renderer.setClearColor(this.theme.background);
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.city.setTheme(theme);
    this.drones.setTheme(theme);
    this.post.setTheme(theme);
    this.ui.applyTheme(theme);
    this.applyThemeToScene();
  }

  setPlaying(on: boolean): void {
    if (on && this.endReached) {
      this.seek(this.cfg.from ?? this.tl.range[0]);
    }
    this.playing = on;
    this.ui.setPlaying(on);
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.cam.resize(w / h);
    this.post.resize(w, h);
  }

  /** Jump to time `t` with no animation (scrubbing / render start). */
  seek(t: number): void {
    this.sim.seek(t);
    this.bLines.fill(0);
    for (let f = 0; f < this.tl.files.length; f++) {
      this.prevLines[f] = this.sim.lines[f];
      const b = this.city.layout.fileBuilding[f];
      if (b >= 0) this.bLines[b] += this.sim.lines[f];
    }
    for (let b = 0; b < this.city.count; b++) this.city.setLines(b, this.bLines[b]);
    this.city.snap();
    this.particles.reset(this.cfg.seed);
    this.drones.reset();
    this.ui.clearTicker();
    this.endReached = false;
    this.updateHud();
  }

  private onCommit(ev: SimEvent): void {
    const c = ev.commit;
    const touched = new Set<number>();
    let cx = 0, cz = 0, ct = 0, n = 0;
    for (const ch of c.c) {
      const f = ch[0];
      const ids = ch[4] === RENAME && ch[5] !== undefined ? [f, ch[5]] : [f];
      for (const id of ids) {
        const b = this.city.layout.fileBuilding[id];
        if (b < 0) continue;
        const delta = this.sim.lines[id] - this.prevLines[id];
        this.prevLines[id] = this.sim.lines[id];
        this.bLines[b] += delta;
        touched.add(b);
      }
    }
    for (const f of ev.died) {
      const b = this.city.layout.fileBuilding[f];
      if (b >= 0 && this.bLines[b] <= 0 && this.city.height[b] > 0.3) {
        const bl = this.city.layout.buildings[b].rect;
        this.tmpColor.copy(this.theme.building(this.city.layout.buildings[b].ext, this.city.layout.buildings[b].dir));
        const count = Math.min(60, 10 + Math.round(this.city.height[b] * 1.5));
        this.particles.crumble(this.city.centerX[b], this.city.centerZ[b], bl.w, bl.d, this.city.height[b], this.tmpColor, count);
      }
    }
    for (const f of ev.born) {
      const b = this.city.layout.fileBuilding[f];
      if (b >= 0 && this.city.height[b] < 0.3 && this.particles.time > 0.5) {
        this.tmpColor.copy(this.theme.building(this.city.layout.buildings[b].ext, this.city.layout.buildings[b].dir));
        this.particles.spark(this.city.centerX[b], this.city.centerZ[b], this.tmpColor, 6);
      }
    }
    for (const b of touched) {
      this.city.setLines(b, this.bLines[b]);
      this.city.heat[b] = 1;
      cx += this.city.centerX[b];
      cz += this.city.centerZ[b];
      ct = Math.max(ct, this.city.target[b]);
      n++;
      this.cam.report(this.city.centerX[b], this.city.centerZ[b], 1);
    }
    if (n > 0) this.drones.visit(c.a, cx / n, ct, cz / n, this.drones.heat[c.a] <= 0);
    this.ui.pushCommit(c.h, this.tl.authors[c.a].name, c.m, `#${this.drones.colors[c.a].getHexString()}`);
  }

  /** One simulation + animation step of `dt` real seconds. */
  step(dt: number, targetTime?: number): void {
    const prevSim = this.sim.time;
    if (targetTime !== undefined) {
      this.sim.advance(targetTime, (ev) => this.onCommit(ev));
    } else if (this.playing) {
      const end = this.cfg.to ?? this.tl.range[1];
      const t = Math.min(prevSim + dt * this.speed * DAY, end);
      this.sim.advance(t, (ev) => this.onCommit(ev));
      if (t >= end || this.sim.done) {
        this.endReached = true;
        this.setPlaying(false);
      }
    }
    const simDt = this.sim.time - prevSim;
    // Glow lasts ~20 sim days, but at least 1.5 and at most 6 real seconds.
    const rate = Math.min(Math.max(simDt / (20 * DAY), dt / 6), dt / 1.5);
    const decay = Math.exp(-rate);
    this.clock += dt;
    this.city.update(dt, decay, this.cam.camera.position);
    this.particles.update(dt, this.renderer.getPixelRatio());
    this.drones.update(dt, decay, this.renderer.getPixelRatio());
    this.cam.update(dt, this.city.extent);
    this.updateHud();
  }

  private updateHud(): void {
    this.ui.setTime(this.sim.time);
    this.ui.setStats(this.sim.cursor, this.sim.aliveCount, this.sim.totalLines, this.tl.authors.length);
    this.ui.setLegend(this.drones.heat, this.sim.authorCommits, this.drones.colors, this.clock);
  }

  render(): void {
    this.post.render(this.clock);
  }

  private loop(now: number): void {
    const dt = Math.min(this.lastFrame ? (now - this.lastFrame) / 1000 : 1 / 60, 0.1);
    this.lastFrame = now;
    this.step(dt);
    this.render();
    requestAnimationFrame((t) => this.loop(t));
  }
}

/** Headless render API, used by `strata render` through Playwright. */
interface RenderApi {
  ready: boolean;
  error: string | null;
  frameCount: number;
  /** Render frame `i` (sequential calls expected). Returns when the frame is on the canvas. */
  frame(i: number): void;
}
declare global {
  interface Window {
    strata: RenderApi;
  }
}

async function boot(): Promise<void> {
  const cfg = readConfig();
  const api: RenderApi = { ready: false, error: null, frameCount: 0, frame: () => {} };
  window.strata = api;
  try {
    const tl = await loadTimeline(cfg.timeline);
    const loading = document.getElementById("loading-text");
    if (loading) loading.textContent = `laying out ${tl.files.length.toLocaleString()} files`;
    await new Promise((r) => setTimeout(r, 30));
    if (cfg.render) await document.fonts.ready;
    const app = new App(cfg, tl);
    document.getElementById("loading")?.classList.add("hidden");

    if (cfg.render) {
      const from = cfg.from ?? tl.range[0];
      const to = cfg.to ?? tl.range[1];
      const frames = Math.max(1, Math.round(cfg.duration * cfg.fps));
      api.frameCount = frames;
      let next = 0;
      api.frame = (i: number) => {
        if (i !== next) {
          app.seek(from);
          next = 0;
          while (next < i) api.frame(next);
        }
        const t = from + ((i + 1) / frames) * (to - from);
        app.step(1 / cfg.fps, t);
        app.render();
        next = i + 1;
      };
      // Prime: let the start state settle for a few frames without advancing time.
      for (let k = 0; k < 30; k++) app.step(1 / cfg.fps, from);
    }
    api.ready = true;
  } catch (e) {
    api.error = String(e);
    const el = document.getElementById("loading-text");
    if (el) el.textContent = `error: ${String(e)}`;
    throw e;
  }
}

boot();
