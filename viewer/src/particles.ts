/**
 * Crumble particles. A fixed pool of GPU points; each particle's trajectory
 * is a closed-form function of (birth time, start, velocity), so the CPU only
 * writes attributes when spawning. Spawning uses a seeded RNG → deterministic.
 */
import * as THREE from "three";
import { Rng } from "./rng";

const vert = /* glsl */ `
attribute vec3 aStart;
attribute vec3 aVel;
attribute float aBirth;
attribute float aLife;
attribute vec3 aColor;
attribute float aSize;
uniform float uTime;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float t = uTime - aBirth;
  float life = aLife;
  float k = clamp(t / life, 0.0, 1.0);
  vec3 p = aStart + aVel * t + vec3(0.0, -22.0, 0.0) * t * t * 0.5;
  p.y = max(p.y, 0.0);
  vColor = aColor;
  vAlpha = (t < 0.0 || t > life) ? 0.0 : (1.0 - k) * (1.0 - k);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = aSize * uPixelRatio * (1.0 - 0.6 * k) * (160.0 / max(-mv.z, 1.0));
  gl_Position = projectionMatrix * mv;
  if (vAlpha <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const frag = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  if (d > 0.25) discard;
  float soft = 1.0 - smoothstep(0.1, 0.25, d);
  gl_FragColor = vec4(vColor * 1.8, vAlpha * soft);
}`;

export class Particles {
  readonly points: THREE.Points;
  private readonly start: Float32Array;
  private readonly vel: Float32Array;
  private readonly birth: Float32Array;
  private readonly life: Float32Array;
  private readonly color: Float32Array;
  private readonly size: Float32Array;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private head = 0;
  private dirty = false;
  private rng = new Rng(1337);
  time = 0;

  constructor(readonly capacity = 24000) {
    const n = capacity;
    this.start = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.birth = new Float32Array(n).fill(-1e9);
    this.life = new Float32Array(n).fill(1);
    this.color = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.geo = new THREE.BufferGeometry();
    const attr = (a: Float32Array, s: number) => new THREE.BufferAttribute(a, s).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("position", attr(this.start, 3)); // unused by shader, needed by three
    this.geo.setAttribute("aStart", attr(this.start, 3));
    this.geo.setAttribute("aVel", attr(this.vel, 3));
    this.geo.setAttribute("aBirth", attr(this.birth, 1));
    this.geo.setAttribute("aLife", attr(this.life, 1));
    this.geo.setAttribute("aColor", attr(this.color, 3));
    this.geo.setAttribute("aSize", attr(this.size, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
  }

  reset(seed = 1337): void {
    this.rng = new Rng(seed);
    this.birth.fill(-1e9);
    this.head = 0;
    this.dirty = true;
  }

  /** Burst `count` particles from a box footprint: a building crumbling. */
  crumble(cx: number, cz: number, w: number, d: number, height: number, color: THREE.Color, count: number): void {
    const r = this.rng;
    for (let k = 0; k < count; k++) {
      const i = this.head;
      this.head = (this.head + 1) % this.capacity;
      const y = r.range(0, height);
      const side = r.next() < 0.5 ? -1 : 1;
      const onX = r.next() < 0.5;
      const px = cx + (onX ? side * w * 0.5 : r.range(-w / 2, w / 2));
      const pz = cz + (onX ? r.range(-d / 2, d / 2) : side * d * 0.5);
      this.start[i * 3] = px;
      this.start[i * 3 + 1] = y;
      this.start[i * 3 + 2] = pz;
      const out = 2 + r.next() * 6;
      this.vel[i * 3] = (px - cx) * out * 0.6 + r.range(-2, 2);
      this.vel[i * 3 + 1] = r.range(1, 7);
      this.vel[i * 3 + 2] = (pz - cz) * out * 0.6 + r.range(-2, 2);
      this.birth[i] = this.time + r.range(0, 0.25);
      this.life[i] = r.range(0.8, 1.8);
      this.color[i * 3] = color.r;
      this.color[i * 3 + 1] = color.g;
      this.color[i * 3 + 2] = color.b;
      this.size[i] = r.range(1.5, 4.5);
    }
    this.dirty = true;
  }

  /** A small upward spark burst: a new file appearing. */
  spark(cx: number, cz: number, color: THREE.Color, count: number): void {
    const r = this.rng;
    for (let k = 0; k < count; k++) {
      const i = this.head;
      this.head = (this.head + 1) % this.capacity;
      this.start[i * 3] = cx + r.range(-0.3, 0.3);
      this.start[i * 3 + 1] = 0.2;
      this.start[i * 3 + 2] = cz + r.range(-0.3, 0.3);
      this.vel[i * 3] = r.range(-1.5, 1.5);
      this.vel[i * 3 + 1] = r.range(8, 16);
      this.vel[i * 3 + 2] = r.range(-1.5, 1.5);
      this.birth[i] = this.time;
      this.life[i] = r.range(0.5, 1.0);
      this.color[i * 3] = color.r;
      this.color[i * 3 + 1] = color.g;
      this.color[i * 3 + 2] = color.b;
      this.size[i] = r.range(1.5, 3);
    }
    this.dirty = true;
  }

  update(dt: number, pixelRatio: number): void {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    this.mat.uniforms.uPixelRatio.value = pixelRatio;
    if (this.dirty) {
      for (const name of ["aStart", "aVel", "aBirth", "aLife", "aColor", "aSize"]) {
        (this.geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
      }
      this.dirty = false;
    }
  }
}
