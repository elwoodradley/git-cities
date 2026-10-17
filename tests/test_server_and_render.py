import gzip
import json
import shutil
import threading
import urllib.request
from pathlib import Path

import pytest

from git_cities import renderer, server

TIMELINE = {
    "version": 1,
    "repo": "t",
    "range": [0, 86400],
    "authors": [{"name": "a", "email": "", "commits": 1}],
    "files": ["x.py"],
    "commits": [{"h": "abc", "a": 0, "t": 0, "m": "init", "c": [[0, 3, 0, 3, 1]]}],
}


def test_parse_duration() -> None:
    assert renderer.parse_duration("60s") == 60
    assert renderer.parse_duration("2m") == 120
    assert renderer.parse_duration("1.5") == 1.5
    assert renderer.parse_duration("500ms") == 0.5
    with pytest.raises(renderer.RenderError):
        renderer.parse_duration("soon")


@pytest.fixture
def built_viewer(monkeypatch, tmp_path: Path):
    """Point the server at a stand-in static dir if the real viewer isn't built."""
    if (server.STATIC_DIR / "index.html").exists():
        return server.STATIC_DIR
    (tmp_path / "index.html").write_text("<html>stub</html>")
    monkeypatch.setattr(server, "STATIC_DIR", tmp_path)
    return tmp_path


def test_server_serves_timeline_plain_and_gzipped(built_viewer) -> None:
    httpd = server.make_server(TIMELINE, port=0)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    port = httpd.server_address[1]
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/timeline.json") as r:
            assert r.headers.get("Content-Encoding") is None
            assert json.loads(r.read()) == TIMELINE
        req = urllib.request.Request(f"http://127.0.0.1:{port}/timeline.json", headers={"Accept-Encoding": "gzip"})
        with urllib.request.urlopen(req) as r:
            assert r.headers["Content-Encoding"] == "gzip"
            assert json.loads(gzip.decompress(r.read())) == TIMELINE
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/") as r:
            assert b"html" in r.read().lower()
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_viewer_not_built_message(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(server, "STATIC_DIR", tmp_path)
    with pytest.raises(server.ViewerNotBuilt):
        server.static_dir()


def _browser_available() -> bool:
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            p.chromium.launch().close()
        return True
    except Exception:
        return False


@pytest.mark.skipif(
    not (server.STATIC_DIR / "index.html").exists() or not shutil.which("ffmpeg") or not _browser_available(),
    reason="needs built viewer, ffmpeg and a playwright browser",
)
def test_render_end_to_end_is_deterministic(tmp_path: Path) -> None:
    outs = []
    for k in range(2):
        out = tmp_path / f"r{k}.mp4"
        renderer.render(
            TIMELINE, output=out, date_from=None, date_to=None, resolution="720p", duration=0.5, fps=10,
            theme="neon", crf=20, gpu=True, frames_dir=tmp_path / f"f{k}", log=lambda _m: None,
        )
        assert out.stat().st_size > 1000
        outs.append(out.read_bytes())
    assert outs[0] == outs[1]
    assert len(list((tmp_path / "f0").iterdir())) == 5
