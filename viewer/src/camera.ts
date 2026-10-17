/**
 * Auto-orbiting camera that frames the active part of the city, with manual
 * orbit/zoom override that hands control back after a few idle seconds.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface CameraOptions {
  /** Radians per second of orbit. */
  orbitSpeed: number;
  /** Seconds of idleness before auto camera resumes. */
  manualTimeout: number;
  minRadius: number;
  maxRadius: number;
}

export class AutoCamera {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls | null;
  readonly focus = new THREE.Vector3();
  private readonly activityCentroid = new THREE.Vector3();
  private readonly activityExtent = { v: 0 };
  private accX = 0;
  private accZ = 0;
  private accW = 0;
  private accR = 0;
  private accD = 0;
  private angle = 0.8;
  private radius: number;
  private elevation = 0.55;
  private manualLeft = 0;
  private blend = 1; // 1 = fully auto
  auto = true;
  private readonly opts: CameraOptions;
  private readonly autoPos = new THREE.Vector3();
  private readonly autoTarget = new THREE.Vector3();

  constructor(aspect: number, domElement: HTMLElement | null, extent: number, opts?: Partial<CameraOptions>) {
    this.opts = {
      orbitSpeed: 0.045,
      manualTimeout: 8,
      minRadius: Math.max(extent * 0.3, 40),
      maxRadius: extent * 1.4,
      ...opts,
    };
    this.camera = new THREE.PerspectiveCamera(42, aspect, 0.5, extent * 8);
    this.radius = extent * 0.9;
    this.activityExtent.v = extent * 0.6;
    this.autoPose(this.autoPos, this.autoTarget);
    this.camera.position.copy(this.autoPos);
    this.camera.lookAt(this.autoTarget);
    if (domElement) {
      this.controls = new OrbitControls(this.camera, domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.maxPolarAngle = Math.PI / 2 - 0.05;
      this.controls.minDistance = 5;
      this.controls.maxDistance = extent * 4;
      this.controls.target.copy(this.autoTarget);
      this.controls.addEventListener("start", () => {
        this.manualLeft = this.opts.manualTimeout;
        this.blend = 0;
      });
    } else this.controls = null;
  }

  /** Register activity at a world position this frame. */
  report(x: number, z: number, weight: number): void {
    this.accX += x * weight;
    this.accZ += z * weight;
    this.accW += weight;
    this.accD += weight * Math.hypot(x - this.activityCentroid.x, z - this.activityCentroid.z);
  }

  private autoPose(pos: THREE.Vector3, target: THREE.Vector3): void {
    target.copy(this.focus);
    const r = this.radius;
    pos.set(
      this.focus.x + Math.cos(this.angle) * r * Math.cos(this.elevation),
      this.focus.y + Math.sin(this.elevation) * r,
      this.focus.z + Math.sin(this.angle) * r * Math.cos(this.elevation),
    );
  }

  update(dt: number, cityExtent: number): void {
    // Fold this frame's activity into slow-moving targets.
    if (this.accW > 0) {
      const cx = this.accX / this.accW, cz = this.accZ / this.accW;
      const kc = 1 - Math.exp(-0.9 * dt);
      this.activityCentroid.x += (cx - this.activityCentroid.x) * kc;
      this.activityCentroid.z += (cz - this.activityCentroid.z) * kc;
      // Spread: mean distance of this frame's activity from the centroid, smoothed.
      const spread = this.accD / this.accW;
      this.accR += (spread - this.accR) * kc;
    }
    this.accX = this.accZ = this.accW = this.accD = 0;
    const wanted = THREE.MathUtils.clamp(cityExtent * 0.3 + this.accR * 3.0, this.opts.minRadius, this.opts.maxRadius);
    const kr = 1 - Math.exp(-0.5 * dt);
    this.radius += (wanted - this.radius) * kr;
    const kf = 1 - Math.exp(-0.7 * dt);
    this.focus.x += (this.activityCentroid.x - this.focus.x) * kf;
    this.focus.z += (this.activityCentroid.z - this.focus.z) * kf;
    this.focus.y = 4;
    this.angle += this.opts.orbitSpeed * dt;
    this.elevation = 0.55 + 0.1 * Math.sin(this.angle * 0.7);
    this.autoPose(this.autoPos, this.autoTarget);

    if (!this.auto && this.controls) {
      this.controls.update();
      return;
    }
    if (this.manualLeft > 0) {
      this.manualLeft -= dt;
      this.controls?.update();
      if (this.manualLeft <= 0) {
        // Resume from where the user left the camera.
        const off = this.camera.position.clone().sub(this.controls!.target);
        this.angle = Math.atan2(off.z, off.x);
        this.radius = off.length();
        this.elevation = Math.asin(THREE.MathUtils.clamp(off.y / this.radius, 0, 0.99));
        this.focus.copy(this.controls!.target);
        this.autoPose(this.autoPos, this.autoTarget);
      }
      return;
    }
    this.blend = Math.min(1, this.blend + dt / 1.5);
    const k = this.blend < 1 ? 1 - Math.exp(-3 * dt) : 1;
    this.camera.position.lerp(this.autoPos, k);
    if (this.controls) {
      this.controls.target.lerp(this.autoTarget, k);
      this.controls.update();
    } else this.camera.lookAt(this.autoTarget);
  }

  /** Jump the auto camera to a pose (used after seeks). */
  snapTo(x: number, z: number): void {
    this.activityCentroid.set(x, 0, z);
    this.focus.set(x, 4, z);
    this.autoPose(this.autoPos, this.autoTarget);
    this.camera.position.copy(this.autoPos);
    this.controls?.target.copy(this.autoTarget);
    this.camera.lookAt(this.autoTarget);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
