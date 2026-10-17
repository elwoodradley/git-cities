"""Headless video export: drive the viewer frame by frame with Playwright and
pipe PNG frames into ffmpeg.

Determinism: the viewer in render mode uses a fixed time step, a seeded RNG
and no wall-clock input, so frame *i* is a pure function of (timeline,
options, i). Encoding with x264 at a fixed preset is deterministic too, so
the same input yields a byte-identical MP4 on the same machine/driver.
"""

from __future__ import annotations

import base64
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable
from urllib.parse import urlencode

from . import server

RESOLUTIONS = {"720p": (1280, 720), "1080p": (1920, 1080), "1440p": (2560, 1440), "4k": (3840, 2160)}

GPU_ARGS = ["--enable-gpu", "--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-webgl"]
SOFTWARE_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]


class RenderError(RuntimeError):
    pass


def parse_duration(s: str) -> float:
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*", s)
    if not m:
        raise RenderError(f"bad duration {s!r}; use e.g. 45s, 2m")
    v = float(m.group(1))
    return v * {"ms": 0.001, "s": 1, "m": 60, "h": 3600, None: 1}[m.group(2)]


def _launch(pw, gpu: bool, log: Callable[[str], None]):
    """Launch chromium, preferring a real GPU; fall back to SwiftShader."""
    probe = """() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl2');
        if (!gl) return null; const d = gl.getExtension('WEBGL_debug_renderer_info');
        return gl.getParameter(d ? d.UNMASKED_RENDERER_WEBGL : gl.RENDERER); }"""
    attempts = []
    if gpu:
        attempts.append(("gpu", dict(channel="chromium", args=GPU_ARGS)))
    attempts.append(("software", dict(args=SOFTWARE_ARGS)))
    last_err: Exception | None = None
    for name, kw in attempts:
        try:
            browser = pw.chromium.launch(**kw)
            page = browser.new_page()
            renderer = page.evaluate(probe)
            page.close()
            if renderer is None or (name == "gpu" and "SwiftShader" in str(renderer)):
                browser.close()
                continue
            log(f"  browser: {name} ({renderer})")
            return browser
        except Exception as e:  # noqa: BLE001 - we try the next launch mode
            last_err = e
    raise RenderError(f"could not launch a WebGL-capable browser: {last_err}\nTry `playwright install chromium`.")


def render(
    tl: dict,
    *,
    output: Path,
    date_from: str | None,
    date_to: str | None,
    resolution: str,
    duration: float,
    fps: int,
    theme: str,
    crf: int,
    gpu: bool,
    frames_dir: Path | None,
    log: Callable[[str], None],
    seed: int = 1337,
    capture: str = "jpeg",
    quality: int = 95,
) -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as e:  # pragma: no cover
        raise RenderError("playwright is not installed") from e
    if not shutil.which("ffmpeg"):
        raise RenderError("ffmpeg not found on PATH")
    try:
        width, height = RESOLUTIONS[resolution]
    except KeyError:
        raise RenderError(f"unknown resolution {resolution}; choose from {', '.join(RESOLUTIONS)}")
    try:
        server.static_dir()
    except server.ViewerNotBuilt as e:
        raise RenderError(str(e))

    frames = max(1, round(duration * fps))
    httpd = server.make_server(tl, port=0)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    params: dict[str, str | int | float] = {
        "render": 1,
        "width": width,
        "height": height,
        "theme": theme,
        "duration": duration,
        "fps": fps,
        "seed": seed,
    }
    if date_from:
        params["from"] = date_from
    if date_to:
        params["to"] = date_to
    url = f"http://127.0.0.1:{httpd.server_address[1]}/?{urlencode(params)}"

    output.parent.mkdir(parents=True, exist_ok=True)
    if frames_dir:
        frames_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "image2pipe", "-framerate", str(fps), "-i", "-",
        "-c:v", "libx264", "-preset", "medium", "-crf", str(crf),
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", str(fps),
        str(output),
    ]
    log(f"rendering {frames} frames at {width}x{height} {fps}fps → {output}")
    t0 = time.monotonic()
    try:
        with sync_playwright() as pw:
            browser = _launch(pw, gpu, log)
            page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(url)
            try:
                page.wait_for_function("() => window.gitCities && (window.gitCities.ready || window.gitCities.error)", timeout=600_000)
            except Exception as e:
                raise RenderError(f"viewer did not become ready: {e}; {errors}")
            err = page.evaluate("() => window.gitCities.error")
            if err:
                raise RenderError(f"viewer failed: {err}")
            enc = subprocess.Popen(ffmpeg, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
            assert enc.stdin is not None
            # Talk CDP directly: Playwright's screenshot() adds per-call bookkeeping we don't need.
            cdp = page.context.new_cdp_session(page)
            shot: dict = {"format": capture, "fromSurface": True, "captureBeyondViewport": False}
            if capture == "jpeg":
                shot["quality"] = quality
            ext = "jpg" if capture == "jpeg" else capture
            last_log = t0
            try:
                for i in range(frames):
                    page.evaluate("i => window.gitCities.frame(i)", i)
                    data = base64.b64decode(cdp.send("Page.captureScreenshot", shot)["data"])
                    enc.stdin.write(data)
                    if frames_dir:
                        (frames_dir / f"frame_{i:06d}.{ext}").write_bytes(data)
                    now = time.monotonic()
                    if now - last_log > 2 or i == frames - 1:
                        rate = (i + 1) / (now - t0)
                        eta = (frames - i - 1) / rate if rate > 0 else 0
                        log(f"  frame {i + 1}/{frames}  {rate:.1f} fps  eta {eta:.0f}s")
                        last_log = now
            finally:
                enc.stdin.close()
                rc = enc.wait()
                if rc != 0:
                    raise RenderError(f"ffmpeg failed ({rc}): {enc.stderr.read().decode(errors='replace') if enc.stderr else ''}")
            if errors:
                log(f"  page errors: {errors[:3]}")
            browser.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
    log(f"done in {time.monotonic() - t0:.0f}s: {output} ({output.stat().st_size / 1e6:.1f} MB)")
