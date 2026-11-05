// Time of day, weather and lighting. Units: kilolux / kcd per m2, so the camera's
// auto exposure has to work across the real ~10^6 range between noon and night.
import * as THREE from 'three';
import { createSky, sunTransmittance, skyRadiance } from './sky.js';

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
// atmosphere output -> kcd/m2: clear zenith ~5 kcd/m2 with the sun at 60 degrees
const SKY_SCALE = 5 / lum(skyRadiance([0, 1, 0], [Math.cos(1.047), Math.sin(1.047), 0]));
const SUN_E = 128; // klux at normal incidence above the atmosphere-ish, before transmittance
import { sunPosition, moonPhase } from './sun.js';
import { globalUniforms } from '../tex/matlib.js';
import { createRain } from './rain.js';
import { setFarNight } from '../world/far.js';

export const WEATHERS = {
  clear: { label: 'Céu limpo', cloud: 0.12, overcast: 0, fog: 0.0006, wet: 0, puddles: 0, rain: 0 },
  partly: { label: 'Parcialmente nublado', cloud: 0.5, overcast: 0.05, fog: 0.0006, wet: 0, puddles: 0, rain: 0 },
  overcast: { label: 'Nublado', cloud: 0.95, overcast: 0.85, fog: 0.003, wet: 0, puddles: 0, rain: 0 },
  wet: { label: 'Pós-chuva', cloud: 0.9, overcast: 0.7, fog: 0.004, wet: 0.85, puddles: 0.65, rain: 0 },
  drizzle: { label: 'Garoa', cloud: 1, overcast: 0.95, fog: 0.008, wet: 0.75, puddles: 0.35, rain: 0.35 },
  rain: { label: 'Chuva forte', cloud: 1, overcast: 1, fog: 0.014, wet: 1, puddles: 0.9, rain: 1 },
  fog: { label: 'Neblina', cloud: 1, overcast: 0.8, fog: 0.035, wet: 0.45, puddles: 0.2, rain: 0 },
};

export class Environment {
  constructor(scene, renderer, site, noiseTex) {
    this.scene = scene;
    this.renderer = renderer;
    this.site = site;
    this.sky = createSky(noiseTex);
    scene.add(this.sky);
    this.skyScene = new THREE.Scene();
    this.skyForEnv = createSky(noiseTex);
    this.skyForEnv.material.uniforms.uDisc.value = 0;
    this.skyScene.add(this.skyForEnv);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT = null;

    this.sun = new THREE.DirectionalLight('#ffffff', 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const sc = this.sun.shadow.camera;
    sc.left = -55; sc.right = 55; sc.top = 55; sc.bottom = -55; sc.near = 1; sc.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.radius = 2;
    scene.add(this.sun, this.sun.target);

    this.fill = new THREE.HemisphereLight('#9fb6d8', '#4a4036', 0); // only used at night as moon/sky fill
    scene.add(this.fill);

    scene.fog = new THREE.FogExp2(new THREE.Color(), 0.002);
    this.rain = createRain();
    scene.add(this.rain.mesh);

    this.lights = [];          // { light, base, kind } street/house lamps, toggled at dusk
    this.nightEmissive = [];   // { mat, base, day }
    this.focus = new THREE.Vector3();
    this.lastEnvUpdate = -1e9;
    this.state = { date: new Date(), weather: 'clear', nightF: 0 };
  }

  setFocus(v) {
    this.focus.copy(v);
    this.sun.target.position.copy(v);
  }

  configure(date, weather) {
    this.state.date = date;
    this.state.weather = weather;
    this.update(0, true);
  }

  update(t, force = false) {
    const { date } = this.state;
    const W = WEATHERS[this.state.weather];
    const { site } = this;
    const sp = sunPosition(date, site.lat, site.lon);
    const elDeg = sp.el * 180 / Math.PI;
    const sunDir = new THREE.Vector3(...sp.dir).normalize();
    if (!force && this.sunDirQ && sunDir.angleTo(this.sunDirQ) < 0.0015) sunDir.copy(this.sunDirQ);
    else this.sunDirQ = sunDir.clone();

    // atmosphere: direct sun colour/strength and the blue sky, from the same model the
    // sky shader draws
    const sd = [sunDir.x, sunDir.y, sunDir.z];
    const T = sunTransmittance(sp.el);
    // twilight: single scattering misses the light bounced around in the air; add it back
    // fitted to measured twilight illuminance: ~500 lux at sunset, ~3 lux at -6 deg, ~0.01 lux at -12 deg
    const ms = (elDeg < 0 ? 0.27 * Math.exp(0.85 * elDeg) : 0.27 * Math.exp(-0.35 * elDeg)) * (elDeg > -16 ? 1 : 0);
    const zen = skyRadiance([0, 1, 0], sd).map((v, i) => v * SKY_SCALE + ms * [0.35, 0.45, 0.7][i]);
    const nightF = 1 - smooth(-4, 3, elDeg);
    this.state.nightF = nightF;
    const cloudBlock = 1 - W.overcast * 0.95 - (W.cloud > 0.4 && W.overcast < 0.5 ? 0.15 : 0);
    const sinEl = Math.max(0, Math.sin(sp.el));
    const tl = lum(T);
    // DirectionalLight intensity is illuminance on a surface facing the sun
    const eNormal = SUN_E * tl * Math.max(0.02, cloudBlock) * smooth(-1, 2, elDeg);
    const sunE = eNormal * sinEl; // on the ground
    this.sun.color.setRGB(...T.map(v => (tl > 0 ? v / tl : 1)));
    this.sun.intensity = eNormal;
    this.sun.position.copy(this.focus).addScaledVector(sunDir, 200);
    this.sun.castShadow = sunE > 0.5;
    // overcast softens shadows
    this.sun.shadow.radius = 3 + W.overcast * 6;
    const day = Math.min(1, lum(zen) / 5);
    this.state.day = day;

    // moon / night fill
    const moon = moonPhase(date);
    this.fill.intensity = nightF * (0.00015 + 0.0004 * moon * (1 - W.overcast * 0.7)) * Math.PI;

    // city glow: LED/sodium light scattered back by air, much brighter under clouds and fog
    // mixed LED (white) and sodium (orange) street lighting reflected by the air
    const polluted = new THREE.Color(0.85, 0.78, 0.7).multiplyScalar(2.5e-5 * (1 + W.overcast * 3 + W.fog * 40));
    // haze colour = horizon sky, averaged around the compass, plus the glow at night
    const hl = Math.hypot(sd[0], sd[2]) || 1;
    const hzA = skyRadiance(norm3([sd[0] / hl, 0.05, sd[2] / hl]), sd);
    const hzB = skyRadiance(norm3([-sd[0] / hl, 0.05, -sd[2] / hl]), sd);
    const hz = [0, 1, 2].map(i => (hzA[i] * 0.4 + hzB[i] * 0.6) * SKY_SCALE);
    const overcastGrey = (lum(zen) + tl * eNormal * 0.004) * 0.9;
    const fogCol = new THREE.Color(...hz).lerp(new THREE.Color(overcastGrey, overcastGrey * 1.01, overcastGrey * 1.03), W.overcast)
      .add(polluted.clone().multiplyScalar(2));
    this.scene.fog.color.copy(fogCol);
    this.scene.fog.density = W.fog;
    this.fogMie = { dir: sunDir.clone(), strength: (1 - W.overcast) * 1.5 };

    for (const sk of [this.sky, this.skyForEnv]) {
      const u = sk.material.uniforms;
      u.uSunDir.value.copy(sunDir);
      u.uSunI.value = Math.max(0.02, cloudBlock) * smooth(-1, 2, elDeg);
      u.uSkyScale.value = SKY_SCALE;
      u.uSunCol.value.setRGB(...T);
      u.uSkyAmb.value.setRGB(...zen);
      u.uCloud.value = W.cloud;
      u.uOvercast.value = W.overcast;
      u.uFog.value = Math.min(1, W.fog * 25);
      u.uFogColor.value.copy(fogCol);
      u.uPollution.value.copy(polluted);
      u.uTime.value = t;
      u.uMoon.value = moon * (1 - W.overcast);
      u.uMS.value = ms;
    }
    // horizontal illuminance from the sky dome (lux), for the camera photocell
    this.state.skyLux = Math.PI * lum(zen) * 1000 * 0.6 * (1 - W.overcast * 0.5);

    // weather uniforms shared with all surfaces
    globalUniforms.uSunWorld.value.copy(sunDir);
    globalUniforms.uFogMie.value = this.fogMie.strength * smooth(-2, 4, elDeg);
    globalUniforms.uPomShadow.value = Math.min(1, sunE / 15);
    globalUniforms.uWet.value = W.wet;
    globalUniforms.uPuddles.value = W.puddles;
    globalUniforms.uRainRate.value = W.rain;
    globalUniforms.uTime.value = t;
    this.rain.setRate(W.rain);

    // artificial lights: photocells switch on around sunset
    for (const l of this.lights) {
      const on = nightF > (l.threshold ?? 0.3) ? 1 : 0;
      l.light.visible = on > 0 && !l.disabled;
      l.light.intensity = l.base * on;
      if (l.mat) l.mat.emissiveIntensity = (l.matBase ?? 1) * on;
    }
    setFarNight(nightF);
    for (const e of this.nightEmissive) e.mat.emissiveIntensity = e.base * nightF * 0.02 + (e.day ?? 0) * 0.02;

    // environment map: rebuild on demand (clouds drift slowly)
    const envKey = this.sunDirQ.toArray().map(v => v.toFixed(3)).join() + this.state.weather;
    if (force || (envKey !== this.envKey && t - this.lastEnvUpdate > 4)) {
      this.envKey = envKey;
      this.lastEnvUpdate = t;
      const prev = this.envRT;
      this.envRT = this.pmrem.fromScene(this.skyScene, 0, 0.5, 2000);
      this.scene.environment = this.envRT.texture;
      if (prev) prev.dispose();
    }
    this.state.sunEl = elDeg;
    this.state.sunE = sunE;
  }
}

function norm3(v) { const l = Math.hypot(...v) || 1; return v.map(x => x / l); }
function smooth(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
