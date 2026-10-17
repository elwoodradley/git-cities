/**
 * The city itself: one instanced mesh for every building (file / aggregate
 * block), district plinths, glowing district outlines, ground grid and
 * flat-painted directory labels.
 */
import * as THREE from "three";
import type { Layout, Rect } from "./layout";
import type { Theme } from "./themes";
import { hash01 } from "./rng";

export interface CityOptions {
  /** World units of height per sqrt(line). */
  heightScale: number;
  /** Heights above this get compressed. */
  softCap: number;
  /** Rate (1/s) at which heights ease toward their target. */
  easeRate: number;
}

export const defaultCityOptions: CityOptions = { heightScale: 0.55, softCap: 60, easeRate: 5 };

export function linesToHeight(lines: number, o: CityOptions): number {
  const h = o.heightScale * Math.sqrt(lines);
  return h > o.softCap ? o.softCap + (h - o.softCap) * 0.25 : h;
}

const vert = /* glsl */ `
attribute float aHeight;
attribute vec3 aColor;
attribute float aHeat;
attribute float aSeed;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
varying float vHeat;
varying float vSeed;
varying float vHeight;
void main() {
  vec3 p = position;
  p.y *= aHeight;
  vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix * instanceMatrix) * normal);
  vColor = aColor;
  vHeat = aHeat;
  vSeed = aSeed;
  vHeight = aHeight;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const frag = /* glsl */ `
precision highp float;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uAmbient;
uniform vec3 uHeatColor;
uniform vec3 uFog;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uCamera;
uniform float uWindowScale;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
varying float vHeat;
varying float vSeed;
varying float vHeight;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  if (vHeight <= 0.001) discard;
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uCamera - vWorld);
  float dist = distance(uCamera, vWorld);
  float ndl = max(dot(n, uKeyDir), 0.0);
  float top = step(0.5, n.y);

  // Base facade: dark tinted, lit by key + ambient.
  vec3 base = vColor * (0.03 + 0.07 * ndl) + uAmbient * 0.10;
  base += top * vColor * 0.12;

  // Windows on the sides, as a grid in world space; detail fades with distance (LOD).
  float side = 1.0 - top;
  float detail = 1.0 - smoothstep(120.0, 420.0, dist);
  float u = (abs(n.x) > 0.5 ? vWorld.z : vWorld.x) * uWindowScale;
  float w = vWorld.y * uWindowScale * 1.6;
  vec2 cell = floor(vec2(u, w));
  vec2 f = fract(vec2(u, w));
  float inWin = step(0.2, f.x) * step(f.x, 0.8) * step(0.25, f.y) * step(f.y, 0.75);
  float h = hash(cell + vSeed * 97.0);
  float litProb = 0.28 + 0.65 * vHeat;
  float lit = step(h, litProb);
  float flick = 0.75 + 0.25 * hash(cell * 3.1 + vSeed);
  vec3 windows = vColor * inWin * lit * flick * (0.3 + 0.3 * vHeat);
  vec3 windowsFar = vColor * 0.3 * 0.3 * litProb * (0.3 + 0.3 * vHeat);
  vec3 win = side * mix(windowsFar, windows, detail);

  // Rim / edge glow so silhouettes read against the dark.
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 edge = vColor * rim * (0.2 + 0.5 * vHeat);

  // Heat: a recently touched building glows in its own colour, whitening at the peak.
  float h2 = vHeat * vHeat;
  vec3 heat = vColor * h2 * 0.6 + uHeatColor * h2 * h2 * 0.1;
  heat += top * vColor * vHeat * 0.3;

  vec3 col = base + win + edge + heat;
  float fog = smoothstep(uFogNear, uFogFar, dist);
  col = mix(col, uFog, fog);
  gl_FragColor = vec4(col, 1.0);
}`;

const groundVert = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const groundFrag = /* glsl */ `
precision highp float;
uniform vec3 uGround;
uniform vec3 uGrid;
uniform vec3 uFog;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uCamera;
uniform float uExtent;
varying vec3 vWorld;
void main() {
  float dist = distance(uCamera, vWorld);
  vec2 g = abs(fract(vWorld.xz / 10.0 - 0.5) - 0.5) / fwidth(vWorld.xz / 10.0);
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  vec2 g2 = abs(fract(vWorld.xz / 50.0 - 0.5) - 0.5) / fwidth(vWorld.xz / 50.0);
  float line2 = 1.0 - min(min(g2.x, g2.y), 1.0);
  float r = length(vWorld.xz) / uExtent;
  float fade = 1.0 - smoothstep(0.6, 1.6, r);
  vec3 col = uGround + uGrid * (line * 0.5 + line2 * 0.9) * fade;
  float fog = smoothstep(uFogNear, uFogFar, dist);
  col = mix(col, uFog, fog);
  gl_FragColor = vec4(col, 1.0);
}`;

export class City {
  readonly group = new THREE.Group();
  readonly layout: Layout;
  readonly opts: CityOptions;
  readonly count: number;
  readonly mesh: THREE.InstancedMesh;
  /** World-space centre of each building (x, z) and lot size. */
  readonly centerX: Float32Array;
  readonly centerZ: Float32Array;
  readonly lotSize: Float32Array;
  readonly target: Float32Array;
  readonly height: Float32Array;
  readonly heat: Float32Array;
  private readonly heightAttr: THREE.InstancedBufferAttribute;
  private readonly heatAttr: THREE.InstancedBufferAttribute;
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private readonly groundMat: THREE.ShaderMaterial;
  private readonly plinths: THREE.InstancedMesh;
  private readonly outlines: THREE.LineSegments;
  private readonly labels: THREE.Group;
  private readonly labelMats: THREE.MeshBasicMaterial[] = [];
  readonly extent: number;
  private theme!: Theme;

  constructor(layout: Layout, theme: Theme, opts: CityOptions = defaultCityOptions) {
    this.layout = layout;
    this.opts = opts;
    const n = (this.count = layout.buildings.length);
    this.extent = Math.max(layout.bounds.w, layout.bounds.d);
    this.centerX = new Float32Array(n);
    this.centerZ = new Float32Array(n);
    this.lotSize = new Float32Array(n);
    this.target = new Float32Array(n);
    this.height = new Float32Array(n);
    this.heat = new Float32Array(n);

    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.heightAttr = new THREE.InstancedBufferAttribute(this.height, 1).setUsage(THREE.DynamicDrawUsage);
    this.heatAttr = new THREE.InstancedBufferAttribute(this.heat, 1).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    const seeds = new Float32Array(n);
    geo.setAttribute("aHeight", this.heightAttr);
    geo.setAttribute("aHeat", this.heatAttr);
    geo.setAttribute("aColor", this.colorAttr);
    geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uKeyDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
        uKeyColor: { value: new THREE.Color() },
        uAmbient: { value: new THREE.Color() },
        uHeatColor: { value: new THREE.Color() },
        uFog: { value: new THREE.Color() },
        uFogNear: { value: this.extent * 1.2 },
        uFogFar: { value: this.extent * 3.5 },
        uCamera: { value: new THREE.Vector3() },
        uWindowScale: { value: 1.1 },
      },
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, n);
    this.mesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    layout.buildings.forEach((b, i) => {
      const r = b.rect;
      this.centerX[i] = r.x + r.w / 2;
      this.centerZ[i] = r.z + r.d / 2;
      this.lotSize[i] = Math.min(r.w, r.d);
      m.makeScale(r.w, 1, r.d).setPosition(this.centerX[i], 0, this.centerZ[i]);
      this.mesh.setMatrixAt(i, m);
      seeds[i] = hash01(b.dir + "/" + b.files[0]);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.mesh);

    // Ground
    this.groundMat = new THREE.ShaderMaterial({
      vertexShader: groundVert,
      fragmentShader: groundFrag,
      uniforms: {
        uGround: { value: new THREE.Color() },
        uGrid: { value: new THREE.Color() },
        uFog: { value: new THREE.Color() },
        uFogNear: { value: this.extent * 1.2 },
        uFogFar: { value: this.extent * 3.5 },
        uCamera: { value: new THREE.Vector3() },
        uExtent: { value: this.extent },
      },
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(this.extent * 12, this.extent * 12), this.groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    this.group.add(ground);

    // District plinths: stacked slabs, slightly raised per depth.
    const districts = layout.districts.filter((d) => d.depth > 0);
    const plinthGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.plinths = new THREE.InstancedMesh(plinthGeo, new THREE.MeshBasicMaterial({ color: theme.district }), districts.length);
    this.plinths.frustumCulled = false;
    districts.forEach((d, i) => {
      const r = d.rect;
      const y = 0.06 * d.depth;
      m.makeScale(r.w, y + 0.02, r.d).setPosition(r.x + r.w / 2, -0.02, r.z + r.d / 2);
      this.plinths.setMatrixAt(i, m);
    });
    this.plinths.instanceMatrix.needsUpdate = true;
    this.group.add(this.plinths);

    // Glowing district outlines.
    const pts: number[] = [];
    for (const d of districts) {
      const r = d.rect;
      const y = 0.06 * d.depth + 0.02;
      const c = [
        [r.x, r.z],
        [r.x + r.w, r.z],
        [r.x + r.w, r.z + r.d],
        [r.x, r.z + r.d],
      ];
      for (let i = 0; i < 4; i++) {
        const a = c[i], b = c[(i + 1) % 4];
        pts.push(a[0], y, a[1], b[0], y, b[1]);
      }
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    this.outlines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: theme.grid, transparent: true, opacity: 0.8 }));
    this.outlines.frustumCulled = false;
    this.group.add(this.outlines);

    // Labels painted on the ground for the biggest districts.
    this.labels = new THREE.Group();
    const labelled = districts
      .filter((d) => d.depth <= 2 && d.fileCount >= 2)
      .sort((a, b) => b.rect.w * b.rect.d - a.rect.w * a.rect.d)
      .slice(0, 60);
    for (const d of labelled) this.labels.add(this.makeLabel(d.name, d.rect, d.depth));
    this.group.add(this.labels);

    this.setTheme(theme);
  }

  private makeLabel(text: string, r: Rect, depth: number): THREE.Mesh {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const font = "600 48px 'Inter', 'Segoe UI', system-ui, sans-serif";
    ctx.font = font;
    const tw = Math.ceil(ctx.measureText(text).width) + 24;
    canvas.width = Math.max(tw, 2);
    canvas.height = 64;
    ctx.font = font;
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 12, 34);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = 8;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.85 });
    this.labelMats.push(mat);
    const aspect = canvas.width / canvas.height;
    const h = Math.min(Math.max(Math.min(r.w, r.d) * 0.09, 0.5), 4) * (depth === 1 ? 1.4 : 1);
    const w = Math.min(h * aspect, r.w * 0.9);
    const hh = w / aspect;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, hh), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(r.x + 0.3 + w / 2, 0.06 * depth + 0.03, r.z + r.d - 0.3 - hh / 2);
    return mesh;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    const u = this.material.uniforms;
    u.uKeyColor.value.copy(theme.key);
    u.uAmbient.value.copy(theme.ambient);
    u.uHeatColor.value.copy(theme.heat);
    u.uFog.value.copy(theme.fog);
    const g = this.groundMat.uniforms;
    g.uGround.value.copy(theme.ground);
    g.uGrid.value.copy(theme.grid);
    g.uFog.value.copy(theme.fog);
    const colors = this.colorAttr.array as Float32Array;
    this.layout.buildings.forEach((b, i) => {
      const c = theme.building(b.ext, b.dir);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    });
    this.colorAttr.needsUpdate = true;
    (this.plinths.material as THREE.MeshBasicMaterial).color.copy(theme.district);
    (this.outlines.material as THREE.LineBasicMaterial).color.copy(theme.grid);
    for (const m of this.labelMats) m.color.copy(theme.ui.fg === "#b8ffc4" ? theme.heat : theme.key);
  }

  get currentTheme(): Theme {
    return this.theme;
  }

  /** Set the target height of building `i` from its total line count. */
  setLines(i: number, lines: number): void {
    this.target[i] = lines > 0 ? Math.max(linesToHeight(lines, this.opts), 0.25) : 0;
  }

  /** Snap all heights to their targets (after a seek). */
  snap(): void {
    this.height.set(this.target);
    this.heat.fill(0);
    this.heightAttr.needsUpdate = true;
    this.heatAttr.needsUpdate = true;
  }

  /**
   * Advance animations. `dt` is real seconds; `heatDecay` is the multiplicative
   * decay for this step, computed by the caller from sim and real time.
   */
  update(dt: number, heatDecay: number, camera: THREE.Vector3): void {
    const k = 1 - Math.exp(-this.opts.easeRate * dt);
    const h = this.height, t = this.target, heat = this.heat;
    for (let i = 0; i < this.count; i++) {
      const d = t[i] - h[i];
      if (d !== 0) {
        h[i] = Math.abs(d) < 0.002 ? t[i] : h[i] + d * k;
      }
      if (heat[i] > 0) heat[i] = heat[i] < 0.004 ? 0 : heat[i] * heatDecay;
    }
    this.heightAttr.needsUpdate = true;
    this.heatAttr.needsUpdate = true;
    this.material.uniforms.uCamera.value.copy(camera);
    this.groundMat.uniforms.uCamera.value.copy(camera);
  }

  topOf(i: number): THREE.Vector3 {
    return new THREE.Vector3(this.centerX[i], this.height[i], this.centerZ[i]);
  }
}
