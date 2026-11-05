// Procedural surface definitions. Each returns albedo (linear), height (meters),
// roughness, ao, metalness and an alpha channel. For tintable materials alpha is a
// paint mask (1 = paint, gets multiplied by the instance colour); for cutouts it is opacity.
export const MATERIALS_GLSL = /* glsl */ `
uniform float uTile;     // tile size in meters
uniform vec4 uP;         // material parameters
uniform vec3 uC1;        // optional colours (linear)
uniform vec3 uC2;

struct Surf { vec3 alb; float h; float rough; float ao; float metal; float a; };
Surf S0() { Surf s; s.alb = vec3(0.5); s.h = 0.0; s.rough = 0.8; s.ao = 1.0; s.metal = 0.0; s.a = 1.0; return s; }

vec2 PER(float size) { return vec2(max(1.0, floor(uTile / size + 0.5))); }

// ---------------------------------------------------------------- asphalt
#if MAT == 0
Surf asphalt(vec2 uv) {
  Surf s = S0();
  float wear = uP.x;          // 0 new .. 1 old oxidized
  float cracks = uP.y;
  float darkness = uP.z;
  // coarse (12-19 mm) and fine (6-9 mm) aggregate; their share drifts across the tile
  float mixC = smoothstep(0.35, 0.65, fbm(uv * PER(0.7) + 2.3, PER(0.7), 3));
  vec2 perF = PER(0.0075), perC = PER(0.016);
  vec2 idF, tcF, idC, tcC;
  vec4 vF = voronoi(uv * perF, perF, 0.95, idF, tcF);
  vec4 vC = voronoi(uv * perC, perC, 0.9, idC, tcC);
  float useC = step(0.55 - 0.35 * mixC, hash12(idC + 9.7)) * step(vC.x, 0.42);
  vec4 v = useC > 0.5 ? vC * vec4(0.55, 0.55, 0.55, 1.0) : vF;
  vec2 id = useC > 0.5 ? idC + 500.0 : idF;
  float sizeVar = (0.45 + 1.1 * hash12(id + 3.1)) * (useC > 0.5 ? 1.25 : 1.0);
  float dome = sat(1.0 - v.x * 1.25 / sizeVar);
  float stoneH = dome * sizeVar;
  // binder level: rises in fresh asphalt, falls with ravelling
  float binder = mix(0.62, 0.28, wear) + 0.18 * (fbm(uv * PER(0.05), PER(0.05), 3) - 0.5);
  float exposed = smoothstep(binder - 0.04, binder + 0.08, stoneH);
  // fine sand + micro grain
  vec2 per2 = PER(0.0028);
  vec2 id2, tc2;
  vec4 v2 = voronoi(uv * per2, per2, 1.0, id2, tc2);
  float sand = sat(1.0 - v2.x * 1.4) * (0.4 + 0.6 * hash12(id2));
  float grain = hash12(floor(uv * 2048.0 * 2.0));

  vec3 binderNew = vec3(0.028, 0.028, 0.03);
  vec3 binderOld = vec3(0.085, 0.083, 0.08);
  vec3 bc = mix(binderNew, binderOld, wear) * (0.85 + 0.3 * sand) * (1.0 - darkness * 0.45);
  float hs = hash12(id + 11.0);
  vec3 stoneCol = hs < 0.55 ? vec3(0.16, 0.16, 0.155) : hs < 0.8 ? vec3(0.23, 0.205, 0.19) : hs < 0.93 ? vec3(0.30, 0.27, 0.25) : vec3(0.09, 0.09, 0.095);
  stoneCol *= 0.65 + 0.3 * hash12(id + 5.0);
  // fresh asphalt keeps stones coated in binder
  stoneCol = mix(stoneCol, bc * 1.4, (1.0 - wear) * 0.65);
  s.alb = mix(bc, stoneCol, exposed);
  s.alb *= 0.9 + 0.2 * grain;
  // macro tone variation
  float macro = fbm(uv * PER(0.6), PER(0.6), 4);
  s.alb *= 0.9 + 0.2 * macro;
  // pits / voids
  float pit = smoothstep(0.75, 0.95, fbm(uv * PER(0.012), PER(0.012), 2)) * (0.4 + wear);
  s.alb *= 1.0 - 0.6 * pit;

  s.h = (mix(binder, stoneH, exposed) * 0.004) - pit * 0.003 + sand * 0.0006;

  // alligator cracking
  if (cracks > 0.0) {
    vec2 pc = PER(0.32);
    vec2 cid, ctc;
    vec2 warp = vec2(fbm(uv * PER(0.4), PER(0.4), 3), fbm(uv * PER(0.4) + 7.0, PER(0.4), 3)) - 0.5;
    vec4 c = voronoi(uv * pc + warp * 0.6, pc, 0.9, cid, ctc);
    float mask = smoothstep(0.68 - cracks * 0.12, 0.74 - cracks * 0.12, fbm(uv * PER(2.0), PER(2.0), 4));
    float width = 0.012 + 0.02 * fbm(uv * PER(0.1), PER(0.1), 2);
    float cr = (1.0 - smoothstep(width * 0.3, width, c.z)) * mask;
    // longitudinal crack lines too
    float lin = 1.0 - smoothstep(0.0, 0.004, abs(fbm(uv * PER(2.0) * vec2(1.0, 0.25), PER(2.0) * vec2(1.0, 0.25), 3) - 0.5) * 0.05 / max(0.001, 1.0 / uTile));
    cr = max(cr, lin * mask * 0.0);
    s.alb = mix(s.alb, vec3(0.012), cr * 0.9);
    s.h -= cr * 0.006;
    s.ao *= 1.0 - cr * 0.5;
    // slightly lighter, dusty rims next to cracks
    s.alb *= 1.0 + 0.25 * mask * (1.0 - cr) * smoothstep(width * 3.0, width, c.z);
  }
  s.rough = mix(0.93, 0.7, exposed * wear) + 0.04 * grain;
  s.ao *= mix(0.65, 1.0, sat(stoneH + 0.3));
  return s;
}

#endif
#if MAT == 1
Surf concrete(vec2 uv) {
  Surf s = S0();
  float age = uP.x;
  float slab = uP.y;   // joint spacing in meters (0 = none)
  float tone = uP.z;
  vec2 P = uv * uTile;
  float f1 = fbm(uv * PER(0.35), PER(0.35), 5);
  float f2 = fbm(uv * PER(0.04), PER(0.04), 3);
  float grain = hash12(floor(uv * 2048.0));
  // broom finish striations
  float broom = gnoise(vec2(uv.x * PER(0.12).x, uv.y * PER(0.0025).y), vec2(PER(0.12).x, PER(0.0025).y));
  vec3 base = mix(vec3(0.21, 0.205, 0.195), vec3(0.31, 0.30, 0.285), tone);
  s.alb = base * (0.82 + 0.3 * f1) * (0.92 + 0.12 * f2) * (0.95 + 0.1 * grain);
  s.alb *= 1.0 - 0.06 * (broom - 0.5) * (1.0 - age * 0.5);
  s.h = 0.0006 * broom + 0.0008 * f2 + 0.0003 * grain;
  // aggregate showing through on worn concrete
  vec2 pa = PER(0.007);
  vec2 aid, atc;
  vec4 ag = voronoi(uv * pa, pa, 1.0, aid, atc);
  float agg = smoothstep(0.35, 0.15, ag.x) * step(0.55, hash12(aid)) * age;
  s.alb = mix(s.alb, s.alb * vec3(0.8, 0.78, 0.75) + 0.04 * hash12(aid + 2.0), agg);
  s.h += agg * 0.0015;
  // grime blotches
  float stain = smoothstep(0.45, 0.8, fbm(uv * PER(1.2) + 3.7, PER(1.2), 4));
  s.alb *= 1.0 - stain * 0.14 * (0.4 + age);
  // expansion joints
  if (slab > 0.0) {
    vec2 ps = PER(slab);
    vec2 q = fract(uv * ps) - 0.5;
    float e = boxEdge(q * slab, vec2(slab * 0.5));
    float j = 1.0 - smoothstep(0.003, 0.008, e);
    s.alb = mix(s.alb, s.alb * 0.35, j);
    s.h -= j * 0.008;
    s.ao *= 1.0 - 0.6 * j;
    // dirt collects near joints
    s.alb *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.05, e)) * age;
    // per-slab tone
    vec2 sid = floor(uv * ps);
    s.alb *= 0.9 + 0.2 * hash12(mod(sid, ps));
  }
  // cracks
  float cr = rfbm(uv * PER(0.9), PER(0.9), 5);
  float crack = smoothstep(0.93 - age * 0.04, 0.975, cr) * smoothstep(0.4, 0.6, fbm(uv * PER(2.0) + 9.0, PER(2.0), 3));
  s.alb = mix(s.alb, s.alb * 0.45, crack * 0.7);
  s.h -= crack * 0.004;
  // chewing gum and small dark spots
  vec2 pg = PER(0.05);
  vec2 gc = fract(uv * pg) - 0.5;
  vec2 gid = floor(uv * pg);
  float gr = hash12(mod(gid, pg) + 21.0);
  float gum = step(0.996 - age * 0.004, gr) * (1.0 - smoothstep(0.08, 0.16, length(gc + (hash22(gid) - 0.5) * 0.5)));
  s.alb = mix(s.alb, vec3(0.06, 0.06, 0.065), gum);
  s.h += gum * 0.001;
  s.rough = 0.88 + 0.08 * grain - gum * 0.3;
  return s;
}

#endif
#if MAT == 2
float pattern(vec2 P, float kind) {
  float T = uTile;
  float w = 6.2831853 / T;
  if (kind < 0.5) return 0.0;
  if (kind < 1.5) { // waves
    float y = P.y + sin(P.x * w * 2.0) * T * 0.08;
    return step(0.62, fract(y / T * 3.0));
  }
  if (kind < 2.5) { // diamonds
    vec2 q = abs(fract(P / T * 2.0) - 0.5);
    float d = q.x + q.y;
    return step(0.36, d) * step(d, 0.44) + step(d, 0.1);
  }
  // pinhao-like circles
  vec2 q = fract(P / T * 2.0) - 0.5;
  float r = length(q);
  float ang = atan(q.y, q.x);
  float petal = 0.25 + 0.06 * cos(ang * 8.0);
  return step(abs(r - petal), 0.035) + step(r, 0.06);
}

Surf petitpave(vec2 uv) {
  Surf s = S0();
  vec2 per = PER(0.055);
  vec2 id, tc;
  vec4 v = voronoi(uv * per, per, 0.8, id, tc);
  vec2 center = (id + 0.5) / per * uTile;
  float white = pattern(center, uP.x);
  // stray stones of the other colour
  if (hash12(id + 4.0) < 0.025) white = 1.0 - white;
  float gap = 1.0 - smoothstep(0.03, 0.09, v.z);
  float missing = step(0.993 - uP.y * 0.02, hash12(id + 9.0));
  vec3 basalt = vec3(0.05, 0.05, 0.052) * (0.6 + 1.4 * hash12(id));
  vec3 lime = vec3(0.4, 0.39, 0.36) * (0.75 + 0.3 * hash12(id + 1.0));
  vec3 stone = mix(basalt, lime, white);
  // polished and dirty
  float f = fbm(uv * PER(0.5), PER(0.5), 4);
  stone *= 0.8 + 0.4 * f;
  stone = mix(stone, stone * vec3(0.85, 0.82, 0.76), 0.35 * uP.y);
  vec3 sand = vec3(0.2, 0.18, 0.15) * (0.7 + 0.5 * fbm(uv * PER(0.03), PER(0.03), 2));
  s.alb = mix(stone, sand, gap);
  float dome = sat(v.z * 6.0);
  s.h = dome * 0.006 - gap * 0.008 + 0.002 * hash12(id);
  if (missing > 0.5) { s.alb = sand * 0.7; s.h = -0.02; }
  s.rough = mix(mix(0.55, 0.75, white), 0.95, gap);
  s.ao = mix(1.0, 0.5, gap);
  return s;
}

#endif
#if MAT == 3
Surf tiles(vec2 uv) {
  Surf s = S0();
  float size = uP.x;
  float kind = uP.y;   // 0 red ceramic, 1 ladrilho hidraulico, 2 caquinho
  float age = uP.z;
  if (kind > 1.5) {
    vec2 per = PER(size);
    vec2 id, tc;
    vec4 v = voronoi(uv * per, per, 1.0, id, tc);
    float gap = 1.0 - smoothstep(0.035, 0.07, v.z);
    float h = hash12(id);
    vec3 c = h < 0.86 ? vec3(0.36, 0.07, 0.045) : h < 0.91 ? vec3(0.5, 0.38, 0.06) : h < 0.96 ? vec3(0.03, 0.03, 0.03) : vec3(0.55, 0.55, 0.53);
    c *= 0.8 + 0.35 * hash12(id + 2.0);
    vec3 cement = vec3(0.32, 0.31, 0.29) * (0.8 + 0.3 * fbm(uv * PER(0.05), PER(0.05), 2));
    float fade = fbm(uv * PER(0.7), PER(0.7), 4);
    c = mix(c, c * 0.6 + 0.1, age * fade * 0.6);
    s.alb = mix(c, cement, gap);
    s.h = (1.0 - gap) * 0.003 + sat(v.z * 3.0) * 0.0015;
    s.rough = mix(0.35 + age * 0.35 + 0.1 * fade, 0.92, gap);
    s.ao = mix(1.0, 0.65, gap);
    return s;
  }
  vec2 per = PER(size);
  vec2 cell = floor(uv * per);
  vec2 q = fract(uv * per) - 0.5;
  float e = boxEdge(q * size, vec2(size * 0.5));
  float grout = 1.0 - smoothstep(0.002, 0.0045, e);
  float th = hash12(mod(cell, per));
  vec3 c;
  if (kind < 0.5) {
    c = mix(vec3(0.36, 0.085, 0.05), vec3(0.47, 0.14, 0.08), th);
    if (hash12(mod(cell, per) + 3.0) < 0.06) c = vec3(0.33, 0.32, 0.3); // cement repair
  } else {
    // ladrilho: four-fold motif, palettes chosen by uP.w
    vec2 a = abs(q) * 2.0;
    float r = length(q) * 2.0;
    float ang = atan(q.y, q.x);
    float petal = step(r, 0.55 + 0.18 * cos(ang * 4.0));
    float ring = step(abs(length(a - 1.0) - 0.45), 0.08);
    float dot0 = step(r, 0.14);
    float pal = uP.w;
    vec3 bg = pal < 0.5 ? vec3(0.55, 0.52, 0.46) : pal < 1.5 ? vec3(0.62, 0.55, 0.38) : vec3(0.5, 0.5, 0.5);
    vec3 m1 = pal < 0.5 ? vec3(0.35, 0.06, 0.04) : pal < 1.5 ? vec3(0.03, 0.03, 0.03) : vec3(0.06, 0.12, 0.25);
    vec3 m2 = pal < 0.5 ? vec3(0.03, 0.03, 0.03) : pal < 1.5 ? vec3(0.38, 0.08, 0.04) : vec3(0.55, 0.42, 0.08);
    c = bg;
    c = mix(c, m1, petal);
    c = mix(c, m2, max(ring, dot0));
    c *= 0.9 + 0.15 * th;
  }
  float fade = fbm(uv * PER(0.6), PER(0.6), 4);
  c = mix(c, c * 0.55 + vec3(0.09, 0.085, 0.08), age * fade);
  // individual tiles: wear, stains and the odd replacement in plain cement
  c *= 0.85 + 0.25 * hash12(mod(cell, per) + 17.0);
  c = mix(c, c * 0.6 + 0.08, step(0.93, hash12(mod(cell, per) + 23.0)) * 0.7);
  if (hash12(mod(cell, per) + 31.0) > 0.97) c = vec3(0.3, 0.29, 0.27);
  float chip = step(0.9, hash12(mod(cell, per) + 8.0)) * (1.0 - smoothstep(0.0, 0.03, min(size * 0.5 - abs(q.x * size), size * 0.5 - abs(q.y * size)) + 0.02 * gnoise(uv * PER(0.01), PER(0.01))));
  vec3 grc = vec3(0.3, 0.29, 0.27) * (0.8 + 0.4 * fbm(uv * PER(0.05), PER(0.05), 2));
  s.alb = mix(c, grc, max(grout, chip));
  s.h = (1.0 - max(grout, chip)) * 0.003 + (th - 0.5) * 0.001;
  s.rough = mix(kind < 0.5 ? 0.45 + 0.3 * age : 0.6, 0.92, max(grout, chip)) + 0.1 * fade * age;
  s.ao = mix(1.0, 0.6, grout);
  return s;
}

#endif
#if MAT == 4
Surf paver(vec2 uv) {
  Surf s = S0();
  vec2 sz = vec2(0.2, 0.1);
  vec2 per = vec2(floor(uTile / sz.x + 0.5), floor(uTile / sz.y + 0.5));
  vec2 g = uv * per;
  float row = floor(g.y);
  float herring = uP.y;
  g.x += mod(row, 2.0) * 0.5;
  vec2 cell = floor(g);
  vec2 q = (fract(g) - 0.5) * sz;
  float e = boxEdge(q, sz * 0.5);
  float joint = 1.0 - smoothstep(0.002, 0.004, e);
  float bevel = smoothstep(0.002, 0.008, e);
  vec2 cid = mod(cell, per);
  float th = hash12(cid);
  vec3 c = mix(vec3(0.19, 0.185, 0.175), vec3(0.28, 0.27, 0.25), th);
  if (uP.x > 0.5) c = mix(vec3(0.30, 0.10, 0.07), vec3(0.42, 0.17, 0.11), th);
  float f = fbm(uv * PER(0.5), PER(0.5), 4);
  c *= 0.75 + 0.45 * f;
  c *= 0.9 + 0.12 * hash12(floor(uv * 2048.0));
  float moss = joint * smoothstep(0.4, 0.7, fbm(uv * PER(0.2) + 5.0, PER(0.2), 4));
  vec3 jc = mix(vec3(0.16, 0.14, 0.11), vec3(0.08, 0.11, 0.04), moss);
  s.alb = mix(c, jc, joint);
  float sink = (hash12(cid + 3.0) - 0.5) * 0.004;
  s.h = bevel * 0.004 + sink + 0.0005 * gnoise(uv * PER(0.01), PER(0.01));
  s.rough = mix(0.86, 0.95, joint);
  s.ao = mix(0.55, 1.0, bevel);
  return s;
}

#endif
#if MAT == 5
Surf grass(vec2 uv) {
  Surf s = S0();
  float dry = uP.x;
  float bare = uP.y;
  vec2 pb = PER(0.008);
  float blades = gnoise(vec2(uv.x * pb.x, uv.y * pb.y * 0.35), vec2(pb.x, pb.y * 0.35));
  float b2 = gnoise(uv * PER(0.004), PER(0.004));
  float f = fbm(uv * PER(0.4), PER(0.4), 5);
  vec3 g1 = mix(vec3(0.045, 0.075, 0.02), vec3(0.14, 0.15, 0.06), dry);
  vec3 g2 = mix(vec3(0.085, 0.13, 0.035), vec3(0.22, 0.21, 0.1), dry);
  vec3 c = mix(g1, g2, blades * 0.7 + b2 * 0.3);
  c *= 0.75 + 0.5 * f;
  float soilM = smoothstep(0.6 - bare * 0.4, 0.75 - bare * 0.4, fbm(uv * PER(0.9) + 2.0, PER(0.9), 5));
  vec3 soil = vec3(0.16, 0.11, 0.075) * (0.7 + 0.5 * fbm(uv * PER(0.03), PER(0.03), 3));
  s.alb = mix(c, soil, soilM);
  s.h = (blades * 0.01 + b2 * 0.005) * (1.0 - soilM);
  s.rough = 0.95;
  s.ao = mix(0.6, 1.0, blades);
  return s;
}

#endif
#if MAT == 6
Surf soil(vec2 uv) {
  Surf s = S0();
  vec2 per = PER(0.012);
  vec2 id, tc;
  vec4 v = voronoi(uv * per, per, 1.0, id, tc);
  float peb = step(0.7, hash12(id)) * smoothstep(0.4, 0.2, v.x);
  float f = fbm(uv * PER(0.3), PER(0.3), 6);
  vec3 c = mix(vec3(0.17, 0.10, 0.06), vec3(0.32, 0.20, 0.12), f);
  if (uP.x > 0.5) c = mix(vec3(0.33, 0.13, 0.06), vec3(0.45, 0.2, 0.1), f); // red terra roxa
  c = mix(c, vec3(0.3, 0.28, 0.25) * (0.7 + 0.6 * hash12(id)), peb);
  s.alb = c;
  s.h = f * 0.01 + peb * 0.004;
  s.rough = 0.97;
  return s;
}

#endif
#if MAT == 7
Surf plaster(vec2 uv) {
  Surf s = S0();
  float kind = uP.x;
  float age = uP.y;
  float h;
  if (kind < 0.5) {
    h = fbm(uv * PER(0.012), PER(0.012), 3) * 0.6 + 0.4 * hash12(floor(uv * 1024.0));
    h *= 0.0012;
  } else if (kind < 1.5) {
    // grafiato: vertical scratched grooves
    vec2 pp = vec2(PER(0.006).x, PER(0.25).y);
    float g = gnoise(vec2(uv.x * pp.x, uv.y * pp.y), pp);
    float g2 = gnoise(vec2(uv.x * pp.x * 2.0, uv.y * pp.y * 1.5) + 3.0, pp * vec2(2.0, 1.5));
    h = (smoothstep(0.35, 0.65, g) * 0.7 + g2 * 0.3) * 0.0025;
  } else {
    h = fbm(uv * PER(0.08), PER(0.08), 4) * 0.0006;
  }
  float f = fbm(uv * PER(0.7), PER(0.7), 5);
  vec3 c = vec3(0.78, 0.775, 0.76) * (0.93 + 0.1 * f);
  // paint flaking reveals grey render
  float flake = smoothstep(0.9, 0.92, fbm(uv * PER(0.25) + 11.0, PER(0.25), 6)) * age;
  vec3 render = vec3(0.38, 0.37, 0.35) * (0.8 + 0.3 * fbm(uv * PER(0.02), PER(0.02), 2));
  // hairline cracks
  float cr = smoothstep(0.955, 0.985, rfbm(uv * PER(1.3), PER(1.3), 5)) * smoothstep(0.45, 0.6, fbm(uv * PER(3.0) + 4.0, PER(3.0), 2));
  s.alb = mix(c, render, flake);
  s.alb = mix(s.alb, vec3(0.08), cr * 0.7);
  s.h = h - flake * 0.0015 - cr * 0.001;
  s.a = 1.0 - max(flake, cr);   // paint mask
  s.rough = 0.88;
  s.ao = 1.0 - cr * 0.5;
  return s;
}

#endif
#if MAT == 8
Surf masonry(vec2 uv) {
  Surf s = S0();
  float kind = uP.x; // 0 tijolinho, 1 tijolo baiano raw, 2 concrete block
  vec2 sz = kind < 0.5 ? vec2(0.24, 0.065) : kind < 1.5 ? vec2(0.30, 0.20) : vec2(0.40, 0.20);
  float mort = kind < 0.5 ? 0.008 : kind < 1.5 ? 0.014 : 0.01;
  vec2 per = vec2(floor(uTile / sz.x + 0.5), floor(uTile / sz.y + 0.5));
  vec2 g = uv * per;
  float row = floor(g.y);
  g.x += mod(row, 2.0) * 0.5;
  vec2 cell = floor(g);
  vec2 cid = mod(cell, per);
  vec2 q = (fract(g) - 0.5) * sz;
  float wob = (gnoise(uv * PER(0.05), PER(0.05)) - 0.5) * mort * (kind > 0.5 && kind < 1.5 ? 1.6 : 0.4);
  float e = boxEdge(q, sz * 0.5) + wob;
  float m = 1.0 - smoothstep(mort * 0.5, mort * 0.5 + 0.002, e);
  float th = hash12(cid);
  float f = fbm(uv * PER(0.05), PER(0.05), 4);
  vec3 c;
  if (kind < 0.5) c = mix(vec3(0.42, 0.15, 0.07), vec3(0.55, 0.24, 0.12), th) * (0.75 + 0.4 * f);
  else if (kind < 1.5) c = mix(vec3(0.50, 0.22, 0.10), vec3(0.62, 0.32, 0.16), th) * (0.75 + 0.45 * f);
  else c = mix(vec3(0.19, 0.19, 0.18), vec3(0.28, 0.275, 0.26), th) * (0.75 + 0.45 * f);
  if (kind < 0.5 && hash12(cid + 4.0) < 0.12) c *= 0.55; // burnt bricks
  // porosity
  vec2 pp = PER(0.004);
  float pore = step(0.86, hash12(floor(uv * pp))) * (kind > 1.5 ? 1.0 : 0.4);
  c *= 1.0 - pore * 0.4;
  vec3 mc = kind > 0.5 && kind < 1.5 ? vec3(0.24, 0.235, 0.22) : vec3(0.36, 0.35, 0.33);
  mc *= 0.8 + 0.3 * f;
  s.alb = mix(c, mc, m);
  float bulge = kind > 0.5 && kind < 1.5 ? 0.004 * (1.0 - m) * smoothstep(0.0, 0.012, e) : 0.0;
  s.h = (1.0 - m) * (kind > 0.5 && kind < 1.5 ? -0.002 : 0.011) + bulge + m * (kind > 0.5 && kind < 1.5 ? 0.006 * f : 0.0) - pore * 0.001;
  s.rough = 0.9;
  s.ao = mix(1.0, 0.55, m * (kind < 0.5 ? 1.0 : 0.4));
  return s;
}

#endif
#if MAT == 9
Surf stone(vec2 uv) {
  Surf s = S0();
  float kind = uP.x; // 0 canjiquinha strips, 1 irregular slabs (sao tome)
  float f = fbm(uv * PER(0.08), PER(0.08), 4);
  if (kind < 0.5) {
    vec2 per = vec2(1.0, floor(uTile / 0.045 + 0.5));
    float row = floor(uv.y * per.y);
    float rh = hash12(vec2(row, 1.0));
    float len = 0.12 + 0.2 * rh;
    float nx = floor(uTile / len + 0.5);
    float x = uv.x * nx + hash12(vec2(row, 2.0)) * 7.0;
    float piece = floor(x);
    vec2 pid = vec2(mod(piece, nx), row);
    float fx = fract(x), fy = fract(uv.y * per.y);
    float edge = min(min(fx, 1.0 - fx) * len, min(fy, 1.0 - fy) * 0.045);
    float gap = 1.0 - smoothstep(0.001, 0.004, edge);
    float th = hash12(pid);
    vec3 c = th < 0.4 ? vec3(0.5, 0.42, 0.28) : th < 0.7 ? vec3(0.42, 0.40, 0.36) : th < 0.88 ? vec3(0.45, 0.30, 0.20) : vec3(0.25, 0.24, 0.22);
    c *= 0.75 + 0.45 * f;
    s.alb = mix(c, vec3(0.05), gap);
    s.h = (1.0 - gap) * (0.01 + 0.025 * hash12(pid + 3.0)) + f * 0.003;
    s.ao = mix(0.35, 1.0, sat(s.h * 40.0));
  } else {
    vec2 per = PER(0.32);
    vec2 id, tc;
    vec4 v = voronoi(uv * per, per, 0.9, id, tc);
    float gap = 1.0 - smoothstep(0.01, 0.035, v.z);
    float th = hash12(id);
    vec3 c = mix(vec3(0.62, 0.52, 0.36), vec3(0.55, 0.38, 0.28), th) * (0.8 + 0.35 * f);
    s.alb = mix(c, vec3(0.4, 0.39, 0.37), gap);
    s.h = (1.0 - gap) * (0.004 + 0.004 * th) + f * 0.002;
    s.ao = mix(0.6, 1.0, 1.0 - gap);
  }
  s.rough = 0.85;
  return s;
}

#endif
#if MAT == 10
Surf pastilha(vec2 uv) {
  Surf s = S0();
  float size = uP.x;
  vec2 per = PER(size);
  vec2 cell = mod(floor(uv * per), per);
  vec2 q = (fract(uv * per) - 0.5) * size;
  float e = boxEdge(q, vec2(size * 0.5));
  float grout = 1.0 - smoothstep(0.0012, 0.0025, e);
  float th = hash12(cell);
  vec3 c = mix(uC1, uC2, th * th * 0.35) * (0.93 + 0.12 * hash12(cell + 2.0));
  float f = fbm(uv * PER(0.6), PER(0.6), 4);
  c *= 0.85 + 0.25 * f;
  s.alb = mix(c, vec3(0.5, 0.49, 0.46) * (0.7 + 0.3 * f), grout);
  s.h = (1.0 - grout) * 0.002 * smoothstep(0.0, 0.003, e);
  s.rough = mix(0.22, 0.9, grout);
  return s;
}

#endif
#if MAT == 11
Surf concreteRaw(vec2 uv) {
  Surf s = S0();
  float f = fbm(uv * PER(0.3), PER(0.3), 5);
  float f2 = fbm(uv * PER(0.03), PER(0.03), 3);
  vec2 pb = PER(0.01);
  vec2 id, tc;
  vec4 v = voronoi(uv * pb, pb, 1.0, id, tc);
  float bug = step(0.93, hash12(id)) * smoothstep(0.35, 0.2, v.x);
  vec3 c = vec3(0.27, 0.265, 0.25) * (0.8 + 0.35 * f) * (0.92 + 0.12 * f2);
  // vertical rain streaks
  float streak = smoothstep(0.55, 0.8, gnoise(vec2(uv.x * PER(0.05).x, uv.y * PER(1.5).y), vec2(PER(0.05).x, PER(1.5).y)));
  c *= 1.0 - streak * 0.25;
  c = mix(c, vec3(0.1), bug * 0.7);
  s.alb = c;
  s.h = f2 * 0.0015 - bug * 0.003;
  s.rough = 0.9;
  return s;
}

#endif
#if MAT == 12
Surf roofCeramic(vec2 uv) {
  Surf s = S0();
  vec2 per = vec2(floor(uTile / 0.17 + 0.5), floor(uTile / 0.36 + 0.5));
  vec2 g = uv * per;
  float row = floor(g.y);
  float fy = fract(g.y);
  float fx = fract(g.x + mod(row, 2.0) * 0.0);
  vec2 cid = mod(vec2(floor(g.x), row), per);
  float wave = abs(sin(fx * 3.14159));
  float lip = smoothstep(0.85, 1.0, fy);
  float th = hash12(cid);
  vec3 c = mix(vec3(0.42, 0.16, 0.08), vec3(0.55, 0.25, 0.12), th);
  float f = fbm(uv * PER(0.8), PER(0.8), 5);
  float mold = smoothstep(0.4 - uP.x * 0.3, 0.7 - uP.x * 0.3, f);
  c = mix(c, vec3(0.05, 0.045, 0.04), mold * 0.85);
  float lichen = step(0.82, fbm(uv * PER(0.05) + 3.0, PER(0.05), 3)) * uP.x;
  c = mix(c, vec3(0.55, 0.5, 0.35), lichen * 0.6);
  c *= 0.85 + 0.3 * wave;
  s.alb = c;
  s.h = wave * 0.035 + fy * 0.012 - lip * 0.0 ;
  s.ao = mix(0.45, 1.0, wave) * mix(1.0, 0.5, smoothstep(0.0, 0.08, fy) * (1.0 - smoothstep(0.0, 0.12, fy)));
  s.rough = 0.8;
  return s;
}

#endif
#if MAT == 13
Surf fibro(vec2 uv) {
  Surf s = S0();
  vec2 per = vec2(floor(uTile / 0.177 + 0.5), 1.0);
  float x = uv.x * per.x;
  float wave = 0.5 + 0.5 * sin(x * 6.2831853);
  float f = fbm(uv * PER(0.5), PER(0.5), 5);
  float streak = gnoise(vec2(uv.x * PER(0.04).x, uv.y * PER(0.8).y), vec2(PER(0.04).x, PER(0.8).y));
  vec3 c = vec3(0.30, 0.30, 0.285) * (0.8 + 0.3 * f);
  float dirt = smoothstep(0.35, 0.8, f * 0.6 + streak * 0.6 * (1.0 - wave * 0.5));
  c = mix(c, vec3(0.08, 0.08, 0.075), dirt * (0.4 + uP.x * 0.6));
  float lichen = step(0.8, fbm(uv * PER(0.04) + 9.0, PER(0.04), 3)) * uP.x;
  c = mix(c, vec3(0.6, 0.6, 0.55), lichen * 0.5);
  s.alb = c;
  s.h = wave * 0.025;
  s.rough = 0.85;
  s.ao = mix(0.6, 1.0, wave);
  return s;
}

#endif
#if MAT == 14
Surf metalPainted(vec2 uv) {
  Surf s = S0();
  float kind = uP.x; // 0 vertical ribs, 1 flat sheet panels, 2 horizontal slats, 3 roll-up door, 4 perforated
  float rust = uP.y;
  float h = 0.0;
  if (kind < 0.5) { float x = fract(uv.x * PER(0.1).x); h = smoothstep(0.0, 0.08, x) * smoothstep(0.5, 0.42, x) * 0.008; }
  else if (kind < 1.5) { vec2 q = fract(uv * PER(0.5)) - 0.5; h = smoothstep(0.38, 0.42, max(abs(q.x), abs(q.y))) * 0.004; }
  else if (kind < 2.5) { float y = fract(uv.y * PER(0.12).y); h = (smoothstep(0.0, 0.15, y) - smoothstep(0.85, 1.0, y)) * 0.01; }
  else if (kind < 3.5) { float y = fract(uv.y * PER(0.078).y); h = (0.5 + 0.5 * sin(y * 6.2831853)) * 0.012; }
  else { vec2 q = fract(uv * PER(0.02)) - 0.5; float hole = step(length(q), 0.22); h = -hole * 0.01; s.a = 1.0; }
  float f = fbm(uv * PER(0.6), PER(0.6), 5);
  // rust: lower parts and edges get more (uv.y = height when mapped on gates)
  float rm = smoothstep(0.8 - rust * 0.05, 0.84 - rust * 0.05, fbm(uv * PER(0.08) + 5.0, PER(0.08), 6));
  float streak = smoothstep(0.78, 0.95, gnoise(vec2(uv.x * PER(0.03).x, uv.y * PER(0.6).y), vec2(PER(0.03).x, PER(0.6).y))) * rust;
  vec3 rustC = mix(vec3(0.18, 0.06, 0.02), vec3(0.35, 0.14, 0.05), f);
  float scratch = smoothstep(0.985, 1.0, gnoise(vec2(uv.x * PER(0.3).x, uv.y * PER(0.003).y), vec2(PER(0.3).x, PER(0.003).y)));
  float paintMask = 1.0 - max(rm, streak * 0.8);
  s.alb = mix(rustC, vec3(0.7, 0.7, 0.69) * (0.9 + 0.12 * f), paintMask);
  s.alb = mix(s.alb, vec3(0.35, 0.35, 0.36), scratch * 0.6);
  s.a = paintMask * (1.0 - scratch);
  s.h = h - rm * 0.0005;
  s.rough = mix(0.85, 0.42 + 0.2 * f, paintMask);
  if (kind > 2.5 && kind < 3.5 && uP.z > 0.5) { // galvanized, unpainted
    s.alb = mix(rustC, vec3(0.55, 0.56, 0.57) * (0.8 + 0.3 * f), 1.0 - rm * 0.5);
    s.metal = 0.7 * (1.0 - rm);
    s.rough = 0.5 + 0.2 * f;
    s.a = 0.0;
  }
  s.ao = 1.0;
  return s;
}

#endif
#if MAT == 15
Surf wood(vec2 uv) {
  Surf s = S0();
  vec2 per = vec2(floor(uTile / 0.12 + 0.5), 1.0);
  float plank = floor(uv.x * per.x);
  float fx = fract(uv.x * per.x);
  float th = hash12(vec2(plank, 0.0));
  float grain = gnoise(vec2(uv.x * PER(0.004).x, uv.y * PER(0.4).y + th * 13.0), vec2(PER(0.004).x, PER(0.4).y));
  float rings = sin((uv.x * per.x + grain * 0.8) * 40.0) * 0.5 + 0.5;
  vec3 c = mix(vec3(0.20, 0.10, 0.05), vec3(0.36, 0.2, 0.1), th) * (0.8 + 0.3 * rings);
  float gap = 1.0 - smoothstep(0.0, 0.03, min(fx, 1.0 - fx));
  s.alb = mix(c, vec3(0.03), gap);
  s.h = (1.0 - gap) * 0.003 + rings * 0.0004;
  s.rough = 0.7;
  return s;
}

#endif
#if MAT == 16
Surf bark(vec2 uv) {
  Surf s = S0();
  vec2 pp = vec2(PER(0.04).x, PER(0.25).y);
  vec2 id, tc;
  vec4 v = voronoi(uv * pp, pp, 0.9, id, tc);
  float fiss = 1.0 - smoothstep(0.02, 0.18, v.z);
  float f = fbm(uv * PER(0.2), PER(0.2), 5);
  vec3 c = mix(vec3(0.14, 0.11, 0.08), vec3(0.3, 0.27, 0.23), f);
  float lichen = smoothstep(0.65, 0.8, fbm(uv * PER(0.1) + 4.0, PER(0.1), 4));
  c = mix(c, vec3(0.38, 0.4, 0.3), lichen * 0.6);
  s.alb = mix(c, vec3(0.03, 0.025, 0.02), fiss * 0.8);
  s.h = (1.0 - fiss) * 0.012 + f * 0.004;
  s.ao = mix(0.4, 1.0, 1.0 - fiss);
  s.rough = 0.92;
  return s;
}

#endif
#if MAT == 17
Surf foliage(vec2 uv) {
  Surf s = S0();
  if (uP.x > 2.5) {
    // grass / weed tuft: blades rising from the bottom centre, bending outward
    float a = 0.0; vec3 col = vec3(0.0); float hh = 0.0;
    for (int i = 0; i < 28; i++) {
      vec3 h = hash32(vec2(float(i), 3.7));
      float x0 = 0.5 + (h.x - 0.5) * 0.35;
      float lean = (h.y - 0.5) * 0.9;
      float len = 0.45 + 0.5 * h.z;
      float t = uv.y / len;
      if (t > 1.0) continue;
      float x = x0 + lean * t * t * len;
      float w = 0.018 * (1.0 - t) + 0.002;
      float d = abs(uv.x - x);
      float b = 1.0 - smoothstep(w * 0.6, w, d);
      if (b > 0.0) {
        vec3 c = mix(uC1, uC2, hash12(vec2(float(i), 9.0))) * (0.55 + 0.6 * t);
        col = mix(col, c, b); a = max(a, b); hh = max(hh, t);
      }
    }
    s.alb = col; s.a = a; s.h = hh * 0.003; s.rough = 0.7; s.ao = 0.5 + 0.5 * hh;
    return s;
  }
  // card covers a clump; leaves scattered in a soft blob
  vec2 c = uv - 0.5;
  float blob = 1.0 - smoothstep(0.36, 0.48, length(c * vec2(1.0, 1.1)) + 0.16 * (fbm(uv * 5.0, vec2(5.0), 3) - 0.5));
  float leafA = 0.0;
  vec3 col = vec3(0.0);
  float hgt = 0.0;
  float kind = uP.x; // 0 broad leaves, 1 small leaves (sibipiruna), 2 needle-ish
  float scale = kind < 0.5 ? 9.0 : kind < 1.5 ? 15.0 : 22.0;
  for (int layer = 0; layer < 5; layer++) {
    vec2 g = uv * scale + float(layer) * 17.3;
    vec2 cell = floor(g);
    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 cc = cell + vec2(i, j);
      vec3 h = hash32(cc + float(layer) * 31.0);
      vec2 p = g - (cc + h.xy);
      float ang = h.z * 6.2831853;
      float ca = cos(ang), sa = sin(ang);
      p = mat2(ca, -sa, sa, ca) * p;
      vec2 sz = kind < 0.5 ? vec2(0.75, 0.38) : kind < 1.5 ? vec2(0.7, 0.3) : vec2(0.8, 0.1);
      float d = length(p / sz);
      float leaf = 1.0 - smoothstep(0.85, 1.0, d);
      vec2 lcen = (cc + h.xy) / scale - 0.5 - float(layer) * 17.3 / scale;
      float bc = 1.0 - smoothstep(0.12, 0.47, length(lcen * vec2(1.0, 1.1)) + 0.2 * (hash12(cc + 9.1) - 0.5));
      if (leaf > 0.0 && hash12(cc + float(layer) * 5.7) < bc * 1.15) {
        // later layers sit on top and catch more light; deeper ones are shaded
        float shade = 0.4 + 0.6 * float(layer) / 4.0;
        vec3 lc = mix(uC1, uC2, hash12(cc + 3.3)) * shade * (0.8 + 0.4 * (1.0 - d));
        float vein = 1.0 - smoothstep(0.0, 0.05, abs(p.y)) ;
        lc *= 1.0 - vein * 0.25;
        col = mix(col, lc, leaf);
        leafA = max(leafA, leaf);
        hgt = max(hgt, (1.0 - d) * 0.5 + float(layer) * 0.15);
      }
    }
  }
  // the clump centre darkens: light does not reach inside the foliage
  s.alb = col * mix(0.65, 1.0, smoothstep(0.0, 0.42, length(c)));
  s.a = leafA;
  s.h = hgt * 0.004;
  s.rough = 0.6;
  s.ao = 0.6 + 0.4 * hgt;
  return s;
}

#endif
#if MAT == 18
Surf utilNoise(vec2 uv) {
  Surf s = S0();
  s.alb = vec3(fbm(uv * 4.0, vec2(4.0), 6), fbm(uv * 16.0 + 3.0, vec2(16.0), 5), fbm(uv * 64.0 + 7.0, vec2(64.0), 3));
  vec2 id, tc;
  vec4 v = voronoi(uv * 12.0, vec2(12.0), 1.0, id, tc);
  s.a = v.x;
  return s;
}

#endif
Surf surfaceAt(vec2 uv) {
#if MAT == 0
  return asphalt(uv);
#endif
#if MAT == 1
  return concrete(uv);
#endif
#if MAT == 2
  return petitpave(uv);
#endif
#if MAT == 3
  return tiles(uv);
#endif
#if MAT == 4
  return paver(uv);
#endif
#if MAT == 5
  return grass(uv);
#endif
#if MAT == 6
  return soil(uv);
#endif
#if MAT == 7
  return plaster(uv);
#endif
#if MAT == 8
  return masonry(uv);
#endif
#if MAT == 9
  return stone(uv);
#endif
#if MAT == 10
  return pastilha(uv);
#endif
#if MAT == 11
  return concreteRaw(uv);
#endif
#if MAT == 12
  return roofCeramic(uv);
#endif
#if MAT == 13
  return fibro(uv);
#endif
#if MAT == 14
  return metalPainted(uv);
#endif
#if MAT == 15
  return wood(uv);
#endif
#if MAT == 16
  return bark(uv);
#endif
#if MAT == 17
  return foliage(uv);
#endif
#if MAT == 18
  return utilNoise(uv);
#endif
}
`;
