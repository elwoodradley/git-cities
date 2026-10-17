/** Post-processing: bloom for everything, plus a phosphor CRT pass for the crt theme. */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { Theme } from "./themes";

const crtShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uAmount: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uAmount;
    varying vec2 vUv;
    void main() {
      // Slight barrel distortion.
      vec2 c = vUv * 2.0 - 1.0;
      float r2 = dot(c, c);
      vec2 uv = (c * (1.0 + 0.045 * r2 * uAmount)) * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      // Chromatic bleed: sample green on-pixel, others offset.
      vec2 px = 1.0 / uResolution;
      float g = texture2D(tDiffuse, uv).g;
      float r = texture2D(tDiffuse, uv - vec2(px.x * 1.2, 0.0)).r;
      float b = texture2D(tDiffuse, uv + vec2(px.x * 1.2, 0.0)).b;
      vec3 col = vec3(r, g, b);
      // Phosphor: push everything toward green.
      float lum = dot(col, vec3(0.3, 0.6, 0.1));
      vec3 phosphor = vec3(0.35, 1.0, 0.5) * lum;
      col = mix(col, phosphor, 0.65 * uAmount);
      // Scanlines + subpixel mask.
      float scan = 0.82 + 0.18 * sin(uv.y * uResolution.y * 3.14159);
      float mask = 0.92 + 0.08 * sin(uv.x * uResolution.x * 3.14159 * 0.5);
      col *= mix(1.0, scan * mask, uAmount);
      // Vignette and a slow rolling band.
      float vig = 1.0 - 0.45 * pow(r2, 1.3);
      float band = 1.0 + 0.04 * sin((uv.y - fract(uTime * 0.07)) * 6.2831) * uAmount;
      col *= vig * band;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class Post {
  readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly crt: ShaderPass;
  private readonly output: OutputPass;
  bloomEnabled = true;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number, height: number, theme: Theme) {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(width, height), theme.bloomStrength, theme.bloomRadius, theme.bloomThreshold);
    this.composer.addPass(this.bloom);
    this.output = new OutputPass();
    this.composer.addPass(this.output);
    this.crt = new ShaderPass(crtShader);
    this.composer.addPass(this.crt);
    this.setTheme(theme);
    this.resize(width, height);
  }

  setTheme(theme: Theme): void {
    this.bloom.strength = theme.bloomStrength;
    this.bloom.radius = theme.bloomRadius;
    this.bloom.threshold = theme.bloomThreshold;
    this.bloom.enabled = this.bloomEnabled;
    this.crt.enabled = theme.crt;
  }

  resize(width: number, height: number): void {
    this.composer.setSize(width, height);
    this.bloom.resolution.set(width, height);
    this.crt.uniforms.uResolution.value.set(width, height);
  }

  render(time: number): void {
    this.crt.uniforms.uTime.value = time;
    this.composer.render();
  }
}
