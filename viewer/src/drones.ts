/**
 * Author drones: one glowing light per author that flies to the buildings
 * they touch, with a beam down to the current target. Inactive authors fade
 * out and park.
 */
import * as THREE from "three";
import type { Theme } from "./themes";

const haloVert = /* glsl */ `
attribute float aScale;
attribute vec3 aColor;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vScale;
void main() {
  vColor = aColor;
  vScale = aScale;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = 34.0 * aScale * uPixelRatio * (160.0 / max(-mv.z, 1.0));
  gl_Position = projectionMatrix * mv;
  if (aScale <= 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;
const haloFrag = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vScale;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float a = pow(max(1.0 - d, 0.0), 2.5) * 0.7;
  gl_FragColor = vec4(vColor * 1.2, a * min(vScale * 1.5, 1.0));
}`;

export class Drones {
  readonly group = new THREE.Group();
  readonly pos: Float32Array;
  readonly tgt: Float32Array;
  readonly heat: Float32Array;
  readonly colors: THREE.Color[] = [];
  private readonly cores: THREE.InstancedMesh;
  private readonly halo: THREE.Points;
  private readonly haloScale: Float32Array;
  private readonly haloColor: Float32Array;
  private readonly beams: THREE.LineSegments;
  private readonly beamPos: Float32Array;
  private readonly beamCol: Float32Array;
  private readonly beamTarget: Float32Array;
  private readonly count: number;
  private time = 0;

  constructor(authorCount: number, theme: Theme, extent: number) {
    const n = (this.count = authorCount);
    this.pos = new Float32Array(n * 3);
    this.tgt = new Float32Array(n * 3);
    this.heat = new Float32Array(n);
    this.beamTarget = new Float32Array(n * 3);
    // Park everyone high above the city, spread on a ring.
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = extent * 0.8;
      this.pos[i * 3] = Math.cos(a) * r;
      this.pos[i * 3 + 1] = 60;
      this.pos[i * 3 + 2] = Math.sin(a) * r;
      this.tgt.set(this.pos.subarray(i * 3, i * 3 + 3), i * 3);
    }

    const coreGeo = new THREE.SphereGeometry(0.4, 10, 8);
    this.cores = new THREE.InstancedMesh(coreGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), n);
    this.cores.frustumCulled = false;
    this.group.add(this.cores);

    this.haloScale = new Float32Array(n);
    this.haloColor = new Float32Array(n * 3);
    const hg = new THREE.BufferGeometry();
    hg.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    hg.setAttribute("aScale", new THREE.BufferAttribute(this.haloScale, 1).setUsage(THREE.DynamicDrawUsage));
    hg.setAttribute("aColor", new THREE.BufferAttribute(this.haloColor, 3));
    this.halo = new THREE.Points(
      hg,
      new THREE.ShaderMaterial({
        vertexShader: haloVert,
        fragmentShader: haloFrag,
        uniforms: { uPixelRatio: { value: 1 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.halo.frustumCulled = false;
    this.group.add(this.halo);

    this.beamPos = new Float32Array(n * 6);
    this.beamCol = new Float32Array(n * 6);
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.BufferAttribute(this.beamPos, 3).setUsage(THREE.DynamicDrawUsage));
    bg.setAttribute("color", new THREE.BufferAttribute(this.beamCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.beams = new THREE.LineSegments(
      bg,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.beams.frustumCulled = false;
    this.group.add(this.beams);

    this.setTheme(theme);
  }

  setTheme(theme: Theme): void {
    this.colors.length = 0;
    for (let i = 0; i < this.count; i++) {
      const c = theme.authors[i % theme.authors.length];
      this.colors.push(c);
      this.haloColor[i * 3] = c.r;
      this.haloColor[i * 3 + 1] = c.g;
      this.haloColor[i * 3 + 2] = c.b;
      this.cores.setColorAt(i, c);
    }
    (this.halo.geometry.getAttribute("aColor") as THREE.BufferAttribute).needsUpdate = true;
    if (this.cores.instanceColor) this.cores.instanceColor.needsUpdate = true;
  }

  /** Send author `a` to hover over (x, top, z). */
  visit(a: number, x: number, top: number, z: number, teleport = false): void {
    this.tgt[a * 3] = x;
    this.tgt[a * 3 + 1] = top + 5;
    this.tgt[a * 3 + 2] = z;
    this.beamTarget[a * 3] = x;
    this.beamTarget[a * 3 + 1] = top;
    this.beamTarget[a * 3 + 2] = z;
    this.heat[a] = 1;
    if (teleport) this.pos.set(this.tgt.subarray(a * 3, a * 3 + 3), a * 3);
  }

  reset(): void {
    this.heat.fill(0);
  }

  update(dt: number, heatDecay: number, pixelRatio: number): void {
    this.time += dt;
    const k = 1 - Math.exp(-3.5 * dt);
    const m = new THREE.Matrix4();
    const p = this.pos, t = this.tgt, h = this.heat;
    for (let i = 0; i < this.count; i++) {
      if (h[i] > 0) h[i] = h[i] < 0.003 ? 0 : h[i] * heatDecay;
      const active = h[i] > 0;
      if (active) {
        p[i * 3] += (t[i * 3] - p[i * 3]) * k;
        p[i * 3 + 1] += (t[i * 3 + 1] - p[i * 3 + 1]) * k;
        p[i * 3 + 2] += (t[i * 3 + 2] - p[i * 3 + 2]) * k;
      }
      const bob = active ? Math.sin(this.time * 2.1 + i) * 0.4 : 0;
      const s = active ? 0.35 + 0.65 * Math.sqrt(h[i]) : 0;
      m.makeScale(s, s, s).setPosition(p[i * 3], p[i * 3 + 1] + bob, p[i * 3 + 2]);
      this.cores.setMatrixAt(i, m);
      this.haloScale[i] = s;
      // Beam from drone to the building top, fading with heat.
      const o = i * 6;
      const dx = p[i * 3] - this.beamTarget[i * 3], dz = p[i * 3 + 2] - this.beamTarget[i * 3 + 2];
      const near = 1 - Math.min(1, Math.hypot(dx, dz) / 25);
      if (active && h[i] > 0.05 && near > 0) {
        this.beamPos[o] = p[i * 3];
        this.beamPos[o + 1] = p[i * 3 + 1] + bob;
        this.beamPos[o + 2] = p[i * 3 + 2];
        this.beamPos[o + 3] = this.beamTarget[i * 3];
        this.beamPos[o + 4] = this.beamTarget[i * 3 + 1];
        this.beamPos[o + 5] = this.beamTarget[i * 3 + 2];
        const c = this.colors[i], b = h[i] * near;
        this.beamCol[o] = c.r * b;
        this.beamCol[o + 1] = c.g * b;
        this.beamCol[o + 2] = c.b * b;
        this.beamCol[o + 3] = c.r * b * 0.4;
        this.beamCol[o + 4] = c.g * b * 0.4;
        this.beamCol[o + 5] = c.b * b * 0.4;
      } else {
        this.beamPos.fill(0, o, o + 6);
        this.beamCol.fill(0, o, o + 6);
      }
    }
    this.cores.instanceMatrix.needsUpdate = true;
    (this.halo.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.halo.geometry.getAttribute("aScale") as THREE.BufferAttribute).needsUpdate = true;
    (this.beams.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.beams.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    (this.halo.material as THREE.ShaderMaterial).uniforms.uPixelRatio.value = pixelRatio;
  }
}
