"""`strata` command line interface."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import click

from . import extract as _extract


def _log(msg: str) -> None:
    click.echo(msg, err=True)


def _progress(n: int) -> None:
    print(f"\r  {n} commits…", end="", file=sys.stderr, flush=True)


def extract_timeline(repo: Path, *, linear: bool, since: str | None, until: str | None) -> dict:
    t0 = time.monotonic()
    _log(f"extracting history of {repo}")
    tl = _extract.extract(repo, linear=linear, since=since, until=until, progress=_progress)
    print("\r", end="", file=sys.stderr)
    _log(
        f"  {len(tl['commits'])} commits, {len(tl['files'])} files, "
        f"{len(tl['authors'])} authors in {time.monotonic() - t0:.1f}s"
    )
    return tl


def write_timeline(tl: dict, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        json.dump(tl, f, separators=(",", ":"), ensure_ascii=False)
    _log(f"  wrote {out} ({out.stat().st_size / 1e6:.1f} MB)")


repo_arg = click.argument("repo", type=click.Path(exists=True, file_okay=False, path_type=Path))
history_opts = [
    click.option("--linear", is_flag=True, help="Follow first-parent history only (merges shown as squashes)."),
    click.option("--since", help="Only commits after this date (git syntax)."),
    click.option("--until", help="Only commits before this date (git syntax)."),
]


def _apply(opts):
    def deco(f):
        for o in reversed(opts):
            f = o(f)
        return f

    return deco


@click.group()
@click.version_option(package_name="strata")
def main() -> None:
    """Turn a git repository's history into an animated 3D city."""


@main.command()
@repo_arg
@click.option("-o", "--output", type=click.Path(path_type=Path), default=None, help="Output JSON (default: stdout).")
@_apply(history_opts)
def extract(repo: Path, output: Path | None, linear: bool, since: str | None, until: str | None) -> None:
    """Extract a timeline JSON from REPO."""
    try:
        tl = extract_timeline(repo, linear=linear, since=since, until=until)
    except _extract.ExtractError as e:
        raise click.ClickException(str(e))
    if output is None:
        json.dump(tl, sys.stdout, separators=(",", ":"), ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        write_timeline(tl, output)


@main.command()
@repo_arg
@click.option("--port", default=8765, show_default=True)
@click.option("--no-open", is_flag=True, help="Don't open a browser.")
@click.option("--theme", default=None, help="Initial theme (neon, crt, ember).")
@_apply(history_opts)
def serve(repo: Path, port: int, no_open: bool, theme: str | None, linear: bool, since: str | None, until: str | None) -> None:
    """Extract REPO and open the live viewer."""
    from . import server

    try:
        tl = extract_timeline(repo, linear=linear, since=since, until=until)
    except _extract.ExtractError as e:
        raise click.ClickException(str(e))
    params = {"theme": theme} if theme else {}
    server.serve(tl, port=port, open_browser=not no_open, params=params)


@main.command()
@repo_arg
@click.option("-o", "--output", type=click.Path(path_type=Path), required=True, help="Output .mp4 path.")
@click.option("--from", "date_from", help="Start of the rendered window (date).")
@click.option("--to", "date_to", help="End of the rendered window (date).")
@click.option("--resolution", type=click.Choice(["720p", "1080p", "1440p", "4k"]), default="1080p", show_default=True)
@click.option("--duration", default="60s", show_default=True, help="Video length, e.g. 45s or 2m.")
@click.option("--fps", default=60, show_default=True)
@click.option("--theme", default="neon", show_default=True)
@click.option("--crf", default=18, show_default=True, help="x264 quality (lower is better).")
@click.option("--gpu/--no-gpu", default=True, help="Let the headless browser use the GPU (falls back to software).")
@click.option("--capture", type=click.Choice(["jpeg", "png"]), default="jpeg", show_default=True, help="Frame capture format: jpeg is ~6x faster, png is lossless.")
@click.option("--quality", default=95, show_default=True, help="JPEG capture quality.")
@click.option("--frames-dir", type=click.Path(path_type=Path), default=None, help="Also keep the captured frames here.")
@_apply(history_opts)
def render(repo: Path, output: Path, date_from: str | None, date_to: str | None, resolution: str, duration: str, fps: int, theme: str, crf: int, gpu: bool, capture: str, quality: int, frames_dir: Path | None, linear: bool, since: str | None, until: str | None) -> None:
    """Render REPO's history to an MP4 (headless, deterministic)."""
    from . import renderer

    try:
        tl = extract_timeline(repo, linear=linear, since=since, until=until)
    except _extract.ExtractError as e:
        raise click.ClickException(str(e))
    try:
        renderer.render(
            tl,
            output=output,
            date_from=date_from,
            date_to=date_to,
            resolution=resolution,
            duration=renderer.parse_duration(duration),
            fps=fps,
            theme=theme,
            crf=crf,
            gpu=gpu,
            frames_dir=frames_dir,
            capture=capture,
            quality=quality,
            log=_log,
        )
    except renderer.RenderError as e:
        raise click.ClickException(str(e))


if __name__ == "__main__":
    main()
