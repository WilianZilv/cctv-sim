// Free-flying inspection camera: WASD to move, Q/E down/up, Shift to run,
// drag with the left mouse button to look (no pointer lock), wheel to change speed.
import * as THREE from 'three';

export class FreeCam {
  constructor(dom) {
    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 4000);
    this.camera.rotation.order = 'YXZ';
    this.yaw = 0;
    this.pitch = 0;
    this.speed = 6;
    this.keys = new Set();
    this.enabled = false;
    this.dragging = false;
    this.dom = dom;
    const typing = (e) => e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.isContentEditable);
    this.onKeyDown = (e) => { if (this.enabled && !typing(e)) { this.keys.add(e.code); if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault(); } };
    this.onKeyUp = (e) => this.keys.delete(e.code);
    this.onBlur = () => this.keys.clear();
    this.onDown = (e) => { if (this.enabled && e.button === 0) { this.dragging = true; this.lx = e.clientX; this.ly = e.clientY; } };
    this.onUp = () => { this.dragging = false; };
    this.onMove = (e) => {
      if (!this.enabled || !this.dragging) return;
      const dx = e.clientX - this.lx, dy = e.clientY - this.ly;
      this.lx = e.clientX; this.ly = e.clientY;
      this.yaw -= dx * 0.0035;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0035, -1.55, 1.55);
    };
    this.onWheel = (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.speed = THREE.MathUtils.clamp(this.speed * (e.deltaY > 0 ? 0.85 : 1.18), 0.5, 120);
    };
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    dom.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointermove', this.onMove);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
  }

  // start from another camera's pose
  copyFrom(cam) {
    this.camera.position.copy(cam.position);
    const e = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;
  }

  update(dt, aspect) {
    const c = this.camera;
    c.aspect = aspect;
    c.updateProjectionMatrix();
    const k = this.keys;
    const run = k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1;
    const v = this.speed * run * dt;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    if (k.has('KeyW') || k.has('ArrowUp')) c.position.addScaledVector(fwd, v);
    if (k.has('KeyS') || k.has('ArrowDown')) c.position.addScaledVector(fwd, -v);
    if (k.has('KeyD') || k.has('ArrowRight')) c.position.addScaledVector(right, v);
    if (k.has('KeyA') || k.has('ArrowLeft')) c.position.addScaledVector(right, -v);
    if (k.has('KeyE') || k.has('Space')) c.position.y += v;
    if (k.has('KeyQ') || k.has('KeyC')) c.position.y -= v;
    c.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    c.updateMatrixWorld();
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.dom.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointermove', this.onMove);
    this.dom.removeEventListener('wheel', this.onWheel);
  }
}
