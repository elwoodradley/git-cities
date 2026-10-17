"""Hatch build hook: bundle the compiled viewer into sdists and wheels.

The viewer is TypeScript; users installing from PyPI shouldn't need Node.
When building from a git checkout we run `npm ci && npm run build` in
viewer/ (unless the output is already there and newer than the sources).
When building a wheel from an sdist, the sdist already contains the built
viewer, so no Node is needed.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

STATIC = Path("src/git_cities/static")
VIEWER = Path("viewer")


def _newest_mtime(root: Path) -> float:
    newest = 0.0
    for p in root.rglob("*"):
        if "node_modules" in p.parts or not p.is_file():
            continue
        newest = max(newest, p.stat().st_mtime)
    return newest


class ViewerBuildHook(BuildHookInterface):
    PLUGIN_NAME = "viewer"

    def initialize(self, version: str, build_data: dict) -> None:
        root = Path(self.root)
        static = root / STATIC
        viewer = root / VIEWER
        index = static / "index.html"
        editable = version == "editable"

        if os.environ.get("GIT_CITIES_SKIP_VIEWER_BUILD"):
            return
        if not (viewer / "package.json").exists():
            # Building a wheel from an sdist: the viewer was bundled already.
            if not index.exists() and not editable:
                raise RuntimeError(f"{index} is missing and there is no viewer/ source to build it from")
            return
        if index.exists() and index.stat().st_mtime >= _newest_mtime(viewer / "src") and index.stat().st_mtime >= (viewer / "index.html").stat().st_mtime:
            return

        npm = shutil.which("npm")
        if npm is None:
            msg = "npm not found: cannot build the git-cities viewer (install Node.js >= 20)"
            if editable:
                # Dev installs shouldn't hard-fail; the CLI explains how to build later.
                self.app.display_warning(msg)
                return
            raise RuntimeError(msg)

        self.app.display_info("building git-cities viewer (npm)…")
        if not (viewer / "node_modules").exists():
            subprocess.run([npm, "ci", "--no-audit", "--no-fund"], cwd=viewer, check=True)
        subprocess.run([npm, "run", "build"], cwd=viewer, check=True)
        if not index.exists():
            raise RuntimeError("viewer build finished but produced no index.html")
