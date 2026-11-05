// Moving things: traffic (src/traffic) and pedestrians (src/peds), both built
// with the world and stepped here every frame.
export class Simulation {
  constructor(ctx, scene, seed, camera) { this.ctx = ctx; }
  update(dt, t, env) {
    if (!(dt > 0)) return;
    this.ctx.traffic?.update(dt, t, env);
    this.ctx.peds?.update(dt, t, env);
  }
  dispose() {
    this.ctx.traffic?.dispose?.();
    this.ctx.peds?.dispose?.();
  }
}
