# Decisions

A running log of design decisions made while building strata, with the reasoning.

## Naming

- **Kept the working name "strata".** Geological strata are layers of history
  laid down over time, which is exactly what the city is. No better name came up.

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
- **Renames are delete-old + add-new with the line count carried over.** A
  renamed file usually changes directory, hence district, so it has to move
  anyway. The change record carries the old file id so the viewer can animate
  it as a move rather than a crumble.
- **Binary files count as 0 lines.** They exist (a flat slab) but don't grow.
- **Authors are keyed by lower-cased email (`%aE`, so `.mailmap` applies).**
- **Compact array-based JSON.** 50k commits × a few files each is hundreds of
  thousands of change records; arrays instead of objects keep the file and
  the parse small. 120k commits ≈ 10 MB.
- **Timeline format carries a `version` field** so the viewer can refuse or
  migrate old caches later.
