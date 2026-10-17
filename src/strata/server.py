"""Tiny static server for the viewer: serves the built viewer plus the timeline."""

from __future__ import annotations

import gzip
import json
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode

STATIC_DIR = Path(__file__).parent / "static"


class ViewerNotBuilt(RuntimeError):
    pass


def static_dir() -> Path:
    if not (STATIC_DIR / "index.html").exists():
        raise ViewerNotBuilt(
            "the viewer has not been built: run `npm install && npm run build` in viewer/ "
            "(or install strata from a release wheel)"
        )
    return STATIC_DIR


class _Handler(SimpleHTTPRequestHandler):
    timeline_raw: bytes = b""
    timeline_gz: bytes = b""

    def __init__(self, *args, directory: str, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def log_message(self, *_args) -> None:  # quiet
        pass

    def do_GET(self) -> None:
        if self.path.split("?")[0] == "/timeline.json":
            gz = "gzip" in self.headers.get("Accept-Encoding", "")
            body = self.timeline_gz if gz else self.timeline_raw
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            if gz:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def make_server(timeline: dict, port: int = 0, host: str = "127.0.0.1") -> ThreadingHTTPServer:
    raw = json.dumps(timeline, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    handler = type("Handler", (_Handler,), {"timeline_raw": raw, "timeline_gz": gzip.compress(raw, 1)})
    return ThreadingHTTPServer((host, port), partial(handler, directory=str(static_dir())))


def serve(timeline: dict, *, port: int, open_browser: bool, params: dict | None = None) -> None:
    httpd = make_server(timeline, port=port)
    url = f"http://127.0.0.1:{httpd.server_address[1]}/"
    if params:
        url += "?" + urlencode(params)
    print(f"viewer at {url}  (ctrl-c to stop)")
    if open_browser:
        threading.Timer(0.3, webbrowser.open, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
