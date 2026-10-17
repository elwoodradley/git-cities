# Decisions

A running log of design decisions made while building git-cities, with the reasoning.

## Naming

- **Renamed from the working name "strata" to "git-cities".** Both `strata` and
  `git-strata` are taken on PyPI; `git-cities` was free on PyPI and GitHub and
  says what it does. As a bonus, git runs any `git-<name>` executable on PATH as
  a subcommand, so `git cities serve .` works once installed.

## Extractor

- **Single `git log --raw --numstat` pass.** `--name-status` and `--numstat`
  cannot be combined (the former suppresses the latter), but `--raw` and
  `--numstat` can. `--raw` gives add/delete/rename status and the old→new
  rename paths; `--numstat` gives the line deltas. One process, streamed.
- **Merge commits are skipped by default (`--no-merges`).** Their changes are
  already represented by the commits they merge. Running per-file line totals
  are then an approximation on non-linear history (the same hunk can be
  counted twice on a branch and its cherry-pick), so totals are clamped at 0.
  `--linear` switches to `--first-parent -m`, which is exact but shows merges
  as single squashed events with the merger as the author.
- **Author dates, clamped to be monotonic.** Author date is what people expect
  on a timeline, but it's not monotonic (rebases, clock skew). The log is
  consumed in `--date-order` and any timestamp that goes backwards is clamped
  to the previous one so the viewer always has a monotonic axis.
- **Authors are keyed by lower-cased name, not email.** People change emails
  far more often than names (CPython showed the same core developer twice
  under two addresses); name collisions between different people are rarer
  than that. `%aN`/`%aE` are used so `.mailmap` still applies first.
- **Renames are delete-old + add-new with the line count carried over.** A
  renamed file usually changes directory, hence district, so it has to move
  anyway. The change record carries the old file id so the viewer can treat
  it as a move rather than a crumble.
- **Binary files count as 0 lines.** They exist (a flat slab) but don't grow.
- **Compact array-based JSON.** 50k commits × a few files each is hundreds of
  thousands of change records; arrays instead of objects keep the file and
  the parse small. CPython (121k commits, 28k files) is 24 MB, served gzipped
  (~5 MB) and parsed in well under a second.
- **Timeline format carries a `version` field** so the viewer can refuse or
  migrate old caches later.

## Layout

- **One static treemap over every file that ever existed.** Re-laying out as
  files appear would make buildings jump around; a stable layout means a
  building is always in the same place, and empty lots simply mean "not born
  yet" (or "demolished"). The cost is a sparse-looking early city for repos
  whose file set grew a lot — accepted.
- **Footprint area ∝ √(lifetime days + 7).** "Footprint = age" taken
  literally would give a 15-year-old file thousands of times the area of a
  new one; the square root keeps a ~16× spread between a week-old file and a
  ten-year-old one, which still reads as old = big lot.
- **Height = 0.55·√lines, soft-capped at 40.** Linear height made 10k-line
  files into absurd spikes; log flattened everything. Square root keeps a
  500-line file at ~12 units and a 20k-line file visibly dominant without
  swallowing the camera. Above the cap height grows as √(excess).
- **Single-child directory chains are collapsed** (`a/b/c` with nothing else in
  `a` or `b`) so padding doesn't eat all the area in deep Java-style trees.
- **Aggregation only merges genuinely tiny files, and only in crowded
  directories.** The first attempt aggregated the *smallest-weight* tail of
  every directory with >48 files. On `git.git` (hundreds of large, old `.c`
  files in the root) that produced enormous slabs that dominated the skyline.
  Now a file is only eligible if it peaked below 40 lines or lived under 30
  days, and blocks hold at most 16 files of the same extension. With instancing
  the viewer doesn't need aggregation for speed; it's purely to keep noise down.

## Rendering

- **Custom ShaderMaterial on one InstancedMesh** rather than per-building
  meshes or MeshStandardMaterial. Per-instance attributes carry height, colour
  and heat; height is applied in the vertex shader so animating 28k buildings
  is a single Float32Array upload per frame. Window grids, rim light, heat
  glow and distance-based LOD (windows fade to an average beyond ~120 units)
  are all in the fragment shader.
- **Neutral tone mapping instead of ACES.** ACES desaturated hot neon
  buildings to white; Neutral keeps hue at high intensity, which is the whole
  point of a neon palette. Peak surface brightness is kept around 1.0 so only
  emitters cross the bloom threshold.
- **Heat decays on a hybrid clock.** Glow lasts ~20 simulated days, but at
  least 1.5 and at most 6 real seconds, so a touched building is visible at
  3000 days/s and doesn't linger for a minute at 1 day/s.
- **Drones are instanced spheres + additive point-sprite halos + a beam to the
  target that only draws when the drone is within ~25 units.** Beams drawn
  during the flight across the whole city turned busy repos into a cat's
  cradle.
- **Particles are a fixed GPU pool with closed-form trajectories.** The CPU
  only writes attributes when spawning; the vertex shader evaluates position
  from birth time, so 24k particles cost nothing per frame.
- **Auto camera frames the activity's mean distance from its centroid,** not
  the frame-to-frame centroid movement (the first version zoomed in whenever
  activity was uniformly spread, because the centroid stopped moving).
- **Directory labels are painted flat on the plinth** rather than as
  billboards: they read as street-level signage, scale with the district, and
  never occlude buildings.
- **Three themes, one code path.** A theme is a palette plus bloom settings
  plus a flag for the CRT post pass (barrel distortion, phosphor tint,
  scanlines, subpixel mask, vignette, rolling band).

## Export

- **Playwright drives the real viewer** (`?render=1`) instead of a separate
  offline renderer, so the video is exactly what the live view shows. The page
  exposes `window.gitCities.frame(i)`; each call advances the simulation by one
  fixed step and renders synchronously.
- **Determinism:** fixed `1/fps` step, seeded mulberry32 RNG for every effect,
  no `Date.now()`/`performance.now()` inputs in render mode, `document.fonts.ready`
  awaited before the first frame, and `preserveDrawingBuffer` so capture reads
  the finished frame. Verified byte-identical MP4s across runs.
- **Frames are captured as JPEG (q95) through CDP by default.** Measured on a
  1080p frame: viewer step 24 ms, PNG capture 235 ms, JPEG capture 36 ms; at
  4K PNG is 650 ms vs JPEG 68 ms. The MP4 is lossy anyway. `--capture png`
  gives a lossless path for people who want it.
- **GPU first, SwiftShader fallback.** Headless Chromium with
  `--enable-gpu --use-angle=gl-egl` renders on the real GPU (6–10× faster than
  SwiftShader); if that isn't a real device the renderer falls back silently.
- **HUD scales with output height** (`zoom: height/1080`) so a 4K export has
  the same composition as 1080p rather than tiny text.

## Testing against real repositories

Cloned bare and extracted/played end to end:

| repo | commits (no merges) | files ever | extract | notes |
| --- | --- | --- | --- | --- |
| tj/commander.js | 1.2k | 392 | 0.4 s | small |
| expressjs/express | 5.7k | 903 | 0.6 s | medium |
| git/git | 61k | 7.4k | 20 s | exposed the aggregation problem |
| python/cpython | 121k | 28k | 63 s | 4k authors; found duplicate-author issue; 60 fps |
