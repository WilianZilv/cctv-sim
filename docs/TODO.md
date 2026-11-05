# Backlog

User requests and things noticed while testing. `[x]` done, `[ ]` open.

## From the user
- [x] Real H.264/H.265 codec (WebCodecs), not a shader imitation
- [x] Global illumination (radiance cascades ported from book-club-radio)
- [x] Generator parameters panel
- [x] Free camera to explore, "install camera here"
- [x] Map picker: click a point, generate there
- [x] Cameras less awful: noise tied to gain, sharper optics, sane bitrates
- [x] Better camera models: mid and good tiers (starlight, true WDR, ColorVu, 4K, varifocal)
- [x] No flicker on static areas (AE dead band, always-on 3D DNR, no timed re-lighting)
- [x] Lighting less fake: sky visibility from height field, SSAO, neutral sky, specular occlusion
- [x] Parallax occlusion mapping + relief self-shadowing from texture height
- [x] Linear pipeline check (no sRGB math in lighting)
- [x] Missing meshes on the user's machine: night shaders exceeded 16 texture units (fixed: ORM read once, one shadowed streetlight)
- [x] Sky: physical atmosphere (Rayleigh + Mie), sun disc, planet shadow, twilight fitted to measured lux, sun-lit clouds, city glow at night, sun-directional haze
- [x] GOP pulse: per-frame QP rate control (I-frames 3 QP finer, P-frame QP holds the GOP bitrate)
- [x] Free camera looks like the camera: same ISP (exposure, tone curve, WB, WDR), no lens/noise/codec
- [x] Artifacts on the ground: black under trees and blocky steps (sky-visibility height field), faceted sidewalks (smooth normals)
- [ ] Geometry imperfections
  - [x] Road camber and undulation
  - [x] Uneven sidewalks: terraced lot steps, fall toward curb
  - [x] Walls, pillars, gates, side walls out of plumb/level
  - [x] Facades lean and bow, windows out of square
  - [x] Poles lean, wires follow
  - [ ] Root heave around trees, sunken/lifted slabs
  - [ ] Roof sag, crooked roof edges
  - [ ] Broken / chipped curbs
- [x] Storm drains
  - [x] Manhole covers in the asphalt (SABESP/SANEPAR/ENEL/COPEL/telecom), sunk or proud, hole + patched ring
  - [x] Curb inlets (boca de lobo): mouth in the curb, slab on the sidewalk, gutter grate
  - [x] Concrete telecom/water/gas lids on sidewalks
- [ ] Vehicles: parked and moving (fleet mix, colors, motorcycles, delivery boxes, buses, trucks)
- [ ] People: walkers, phone, bags, umbrellas, strollers, carts, catadores, cyclists, kids, elderly
- [ ] Animals: stray dogs, cats on walls, pigeons

## Noticed while testing
- [ ] Scene build went from ~10 s to ~16 s (ground height functions search all roads per vertex): add a spatial index
- [ ] At night with low bitrate each I-frame refreshes the noise pattern (real DVRs do this too; check it is not overdone)
- [x] Rain particles never rendered (GLSL reserved word `active`)
- [ ] Props look CG: rubble as a half sphere, trash bags as spheres
- [ ] Concrete crack/stain marks still too strong
- [ ] Old asphalt aggregate too bright and contrasty up close
- [ ] Block wall pores look like sandpaper
- [ ] Clouds look wispy/smoky at low sun; need puffier cumulus shapes
- [ ] Windows: more variety (basculante, frosted glass, curtains, venezianas)
- [ ] Sign box ghost text next to some shop signs
- [ ] Twilight is still a fitted term, not true multiple scattering

## Realism gap (render vs AI-corrected reference, 3 pairs)
- [x] Tone/colour: ISP curve too flat (lifted blacks, soft shoulder), too much haze in clear weather, sky too pale (Mie too strong); real frames have deep blue sky, punchy contrast, saturated colour
- [x] Material calibration (first pass; still to check pastilha and petit-pave seeds up close): large high-contrast features everywhere (alligator cracks on all asphalt, concrete stains, rust blotches on gates, two-tone pastilha checker, white "flowers" on petit-pave, road paint too bright and clean); real surfaces are more uniform with small-scale detail
- [x] Vegetation (first pass: ragged leaf clumps, dark inner core, mip-stable alpha): alpha cards read as noise/speckle; need dense clumps, larger leaves, dark interior, defined silhouette
- [x] Night (bloom and lit windows calibrated; ambient still to review): too much flat ambient; missing wet specular reflections of streetlights; lit windows and lamps bloom far too much in IR
- [x] Far field (first pass: ground to 1.5 km, instanced city grid, tree crowns, hill ring): nothing beyond the 170 m region (no skyline, trees, hills); horizon is an empty haze
- [x] Small clutter (weeds at walls/curbs/vacant lots, gutter soil, wall-foot grime, oil drips, leaf litter, rubble): weeds in cracks and wall bases, dirt along curbs, debris, stains under gates
- [x] Wet night: puddles now a smooth sheen; texture detail washes out under the sheen (keep some normal detail)
- [ ] Day shadows slightly cyan (partial AWB + blue sky fill)
- [x] Colours washed out: palette with strong paint colours (about half the houses), AWB no longer neutralises colourful scenes
- [ ] Trees: canopy seen from below shows sky between cards; branch geometry still a bare Y
- [x] Specular map: cavity (baked height) x AO mask, per-material F0 level, water fills cavities when wet
- [x] Build time 33 s -> 15.5 s (nearest-road grid for the surface functions)
- [ ] Far towers are blank boxes (need window bands / texture)
- [ ] Low sun from the front gives strong sheen on asphalt patch rings and curb lip; check against real photos
- [x] Flat colours in the installed camera: new filmic curve (real blacks, brighter highlights), DWDR off on most units, sun not double-counted in the env map
- [x] Rain: was mostly invisible (back-face culled quads); now streaks carry sky light and glint near lamps/IR LEDs, length from the shutter time, near drops out of focus
- [ ] IR rain may be a bit dense compared with real footage; tune density per weather

## External critique (pasted list)
- [x] Far towers: window grid + lit windows at night (world-space shader, instanced)
- [x] Wires: sag now scales with span^2 (~1 m on a 35 m span)
- [x] Block wall joints deeper (11 mm) and POM visible to 38 m
- [x] Red/white sidewalk tiling: 4-5 m tile period at 2048 px, per-tile wear/replacements
- [x] Asphalt patches: ragged cut lines, tar seam, raised/sunken, two ages
- [x] Sun shadow a bit softer (radius 3); contact AO stronger (smaller radius, pow 1.7)
- [x] Far trees: crossed leaf cards instead of low-poly blobs
- [ ] Mid-distance mapped towers (60-150 m) still bare: give them the window shader too
- [ ] Shop sign box ghost ("STRUÇÃO" + second text) still there

## Layers (weathering on top of the base)
- [x] Removed old soil/grime decals and scattered weeds (low impact)
- [x] Layer 1 dirt map (world/grime.js): sediment at curbs, wall bases, buildings, poles, trees; tyre paths; oil (lane centre, parking, garages); moss/damp; splash zone on every vertical surface from a ground-height map; dirt kills gloss
- [x] Layer 2 weeds: instanced tufts in curb joint, gutter, slab joints, wall bases, around poles/trees, vacant lots; per-lot neglect level
- [x] Layer 3 asphalt marks: tar snakes, skid marks, paint drips
- [x] Bug: curbs missing on long straight stretches (only ring vertices were tested) - sky showed through
- [ ] Curb inlet mouth now hidden behind the restored curb face: cut the curb at inlets
- [ ] Next layers: chipped/broken curb edges, root heave, stains under AC units and windows, rust streaks under metal, trash (cups, bottles, flyers), cigarette butts, bird droppings on wires/poles, posters and stickers on poles, faded/peeling paint layers on walls
- [x] Broken render on painted walls: paint loss -> grey cement render -> brick (tijolinho or baiano), concentrated at the wall foot, on ~1/3 of the walls; repainted patches and faded paint
- [x] Bug: wall height varying (vWallH) was always 0 since the start (USE_UV not defined): rising damp, grime and splash zones now follow real height
- [x] Mould/damp climbing from the ground, stronger on neglected walls
- [x] Broken sidewalks: jagged cracks, holes down to the soil with fragments, lifted/sunken slabs (per-lot neglect)
- [x] Ground decals were back-face culled in one winding (potholes/cracks invisible)
- [ ] Sidewalk hole rim reads as a dark ring; soften
- [ ] Damage amount slider in the panel (currently fixed ~1/3 of walls)
- [x] Sidewalk width per road side (normal 1.5-3 m, wide 3.4-5.2 m, deep 5.5-8.5 m strips)
- [x] Rounded curb nose; small bevel on every box edge (walls, caps, pillars, slabs)
- [x] Floating shop frontage: signs/doors now hang on the actual building edge
- [x] Facade variety: barrado, two-tone, cornice, balcony (4 kinds), unfinished top floor with rebar, external stair, garage cover, antenna/dish/solar heater/clothesline; window types (sliding, vitro, venezianas, maxim-ar) and curtains
- [x] Aged paint (faded and darkened)
- [x] Front yards: garden beds, shrubs, yard trees, pots, bench, dog house, tank; more open fronts (grille, low walls)
- [x] Stochastic hex tiling on ground materials; two-size asphalt aggregate
- [x] ~30 new texture variants (asphalt, concrete, tiles, pavers, plaster, masonry, stone, pastilha, roofs, wood, grass, soil)
- [x] Grass spills over its edges; more sidewalks broken
- [ ] Garbage bags still look like drops (neck too pointy)
- [ ] Close-range tree leaves read as individual cards
