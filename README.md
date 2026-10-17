# strata

Turn a git repository's full history into an animated 3D city — live in the
browser, or exported to a deterministic 1080p/4K 60 fps video.

- **Directories are districts**, laid out with a squarified treemap.
- **Files are buildings.** Height = line count, footprint = how long the file
  has lived. Buildings rise as files grow, shrink when trimmed, and crumble into
  particles when deleted.
- **Authors are drones** — coloured lights that fly to the buildings they touch.
- Recently touched buildings **glow, then cool**.
- A camera that slowly **orbits and auto-frames** the active part of the city,
  with manual orbit/zoom override.
- Dark, bloom-lit **neon** look; **crt** (phosphor green with scanlines) and
  **ember** themes.
- Handles **100k+ commits and 25k+ files** at 60 fps (one instanced draw call
  for every building, shader-level LOD, tiny files aggregated into blocks).

Two parts: a Python CLI (`strata`) that extracts history with `git log` into a
compact JSON timeline, and a TypeScript + Three.js viewer that plays it.

## Install

Requirements: Python ≥ 3.11, [uv](https://docs.astral.sh/uv/), git, Node ≥ 20
(to build the viewer), and for video export `ffmpeg` on `PATH`.

```sh
git clone https://github.com/<you>/strata && cd strata
uv sync                                  # Python env + CLI
(cd viewer && npm install && npm run build)   # builds the viewer into src/strata/static
uv run playwright install chromium       # only needed for `strata render`
```

Use `uv run strata …` from the checkout, or `uv tool install .` after building
the viewer to get a global `strata` command.

## Usage

```sh
strata extract <repo> -o timeline.json   # history → JSON
strata serve   <repo>                    # extract + open the live viewer
strata render  <repo> -o out.mp4 [--from 2015-01-01 --to 2016-01-01] \
               [--resolution 4k] [--duration 60s] [--fps 60] [--theme crt]
```

`<repo>` can be a working copy or a bare clone. Extraction speed is bound by
`git log`: about 60 s for CPython's 120k commits, well under a second for most
projects.

### Live viewer

| Control | Action |
| --- | --- |
| drag / scroll | orbit / zoom (auto camera resumes after 8 s idle) |
| `space` | play / pause |
| `← →` | scrub ±1 % of the timeline |
| `↑ ↓` | speed up / slow down |
| `c` | toggle the auto camera |

The viewer is also configurable through URL query parameters, which
`strata serve` passes through when given (`--theme`), or which you can edit
in the address bar:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `theme` | `neon` | `neon`, `crt` or `ember` |
| `speed` | `30` | days of history per real second |
| `from`, `to` | repo range | ISO dates bounding playback |
| `autoplay` | `1` | `0` starts paused |
| `bloom` | `1` | `0` disables the bloom pass |
| `seed` | `1337` | RNG seed for particle effects |
| `timeline` | `timeline.json` | URL of the timeline to load |

### Rendering video

```sh
strata render <repo> -o history.mp4 --resolution 1080p --duration 90s
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--from`, `--to` | whole history | window of history to animate |
| `--resolution` | `1080p` | `720p`, `1080p`, `1440p`, `4k` |
| `--duration` | `60s` | video length (`45s`, `2m`) |
| `--fps` | `60` | frame rate |
| `--theme` | `neon` | `neon`, `crt`, `ember` |
| `--crf` | `18` | x264 quality (lower = better/bigger) |
| `--capture` | `jpeg` | frame capture: `jpeg` is ~6× faster; `png` is lossless |
| `--quality` | `95` | JPEG capture quality |
| `--frames-dir` | — | also keep the individual frames here |
| `--gpu/--no-gpu` | `--gpu` | use the GPU through headless Chromium; falls back to SwiftShader |

Rendering is deterministic: a fixed time step, a seeded RNG and no wall-clock
input mean the same repository and options produce byte-identical frames (and,
with the same ffmpeg build, a byte-identical MP4). On an Intel Arc laptop GPU
it runs at ~20 fps at 1080p and ~8 fps at 4K, so a 60 s video takes 3–8 min.

### History options (all commands)

| Option | Meaning |
| --- | --- |
| `--linear` | follow first-parent history only; merges appear as single squashed events |
| `--since`, `--until` | limit extraction to a date range (git syntax) |

By default merge commits are skipped (their content arrives through the
commits they merge), so per-file line totals are an approximation on heavily
branched histories; `--linear` is exact but attributes merged work to the
merger.

## Timeline format

`strata extract` writes one JSON object:

```jsonc
{
  "version": 1,
  "repo": "express",
  "range": [1246042578, 1791563078],          // first/last commit time
  "authors": [{"name": "…", "email": "…", "commits": 12}],
  "files": ["lib/express.js", "…"],            // index = file id
  "commits": [
    {"h": "17fabc457eff", "a": 0, "t": 1246665975, "m": "Fixed redirect()",
     "c": [[2, 2, 4, 596, 0]]}                  // [file, +lines, -lines, total, kind, old?]
  ]
}
```

`kind` is 0 modify, 1 add, 2 delete, 3 rename (then `old` is the previous file
id). Any tool can produce this format and load it in the viewer with
`?timeline=<url>`.

## Tuning the look

The visual constants live in the viewer source and are deliberately few:

| Where | Knob | Default |
| --- | --- | --- |
| `viewer/src/city.ts` `defaultCityOptions` | `heightScale` (world units per √line), `softCap`, `easeRate` | 0.55, 40, 5 |
| `viewer/src/layout.ts` `defaultLayoutOptions` | `maxFilesPerDir`, `chunk`, `tinyLines`, `tinyDays`, `padding`, `gap` | 64, 16, 40, 30, 1.2, 0.18 |
| `viewer/src/themes.ts` | palettes, bloom strength/radius/threshold, per-extension colours | — |
| `viewer/src/camera.ts` | orbit speed, manual timeout, radius bounds | 0.045 rad/s, 8 s |

Rebuild with `npm run build` after changing them.

## Development

```sh
uv run pytest                         # extractor, server and (if a browser is installed) render tests
cd viewer && npm run dev              # Vite dev server; put a timeline at viewer/public/timeline.json
cd viewer && npm test                 # layout / simulation unit tests
cd viewer && npm run typecheck
```

Design decisions and their reasoning are logged in [DECISIONS.md](DECISIONS.md).

## License

MIT.
