"""Walk a git repository's history and produce a compact timeline.

The timeline is a plain dict (JSON-serialisable) with this shape::

    {
      "version": 1,
      "repo": "name",
      "range": [first_timestamp, last_timestamp],
      "authors": [{"name": str, "email": str, "commits": int}, ...],
      "files": ["path/one", "path/two", ...],
      "commits": [
        {
          "h": "abcdef123456",      # short sha
          "a": 0,                   # index into authors
          "t": 1313347238,          # unix timestamp (author date)
          "m": "subject line",
          "c": [                    # per-file changes
            [file_idx, added, removed, total_after, kind, old_file_idx?],
          ]
        },
        ...
      ]
    }

``kind`` is one of :data:`MODIFY`, :data:`ADD`, :data:`DELETE`, :data:`RENAME`.
For renames the trailing ``old_file_idx`` names the file that went away.
Binary files report ``added == removed == 0``.
"""

from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Callable, Iterator

MODIFY, ADD, DELETE, RENAME = 0, 1, 2, 3

_RECORD_SEP = "\x1e"
_FIELD_SEP = "\x1f"
_FORMAT = f"{_RECORD_SEP}%H{_FIELD_SEP}%aN{_FIELD_SEP}%aE{_FIELD_SEP}%at{_FIELD_SEP}%s"


class ExtractError(RuntimeError):
    pass


@dataclass
class _Change:
    status: str  # A M D R T C ...
    path: str
    old_path: str | None = None
    added: int = 0
    removed: int = 0


@dataclass
class _Commit:
    sha: str
    author: str
    email: str
    time: int
    subject: str
    changes: list[_Change] = field(default_factory=list)


def _unquote(path: str) -> str:
    """Undo git's C-style path quoting ("a\\tb")."""
    if not (len(path) >= 2 and path[0] == '"' and path[-1] == '"'):
        return path
    body = path[1:-1]
    out = bytearray()
    i = 0
    while i < len(body):
        ch = body[i]
        if ch != "\\":
            out.extend(ch.encode("utf-8"))
            i += 1
            continue
        i += 1
        esc = body[i]
        if esc in "01234567":
            out.append(int(body[i : i + 3], 8))
            i += 3
        else:
            out.append({"n": 10, "t": 9, "r": 13, "b": 8, "f": 12, "a": 7, "v": 11}.get(esc, ord(esc)))
            i += 1
    return out.decode("utf-8", errors="replace")


def expand_rename(path: str) -> tuple[str, str]:
    """Turn numstat's ``a/{b => c}/d`` (or ``old => new``) into (old, new)."""
    if "{" in path and "}" in path and " => " in path:
        pre, rest = path.split("{", 1)
        inner, post = rest.rsplit("}", 1)
        old, new = inner.split(" => ", 1)
        return (_collapse(pre + old + post), _collapse(pre + new + post))
    old, new = path.split(" => ", 1)
    return old, new


def _collapse(p: str) -> str:
    while "//" in p:
        p = p.replace("//", "/")
    return p


def _git_log_args(linear: bool, since: str | None, until: str | None) -> list[str]:
    args = [
        "git",
        "-c",
        "core.quotePath=false",
        "-c",
        "diff.renameLimit=5000",
        "log",
        "--reverse",
        "--date-order",
        "-M",
        "--raw",
        "--numstat",
        "--no-color",
        "--no-abbrev",
        f"--format={_FORMAT}",
    ]
    if linear:
        args += ["--first-parent", "-m"]
    else:
        args += ["--no-merges"]
    if since:
        args.append(f"--since={since}")
    if until:
        args.append(f"--until={until}")
    return args


def _parse_log(lines: Iterator[str]) -> Iterator[_Commit]:
    commit: _Commit | None = None
    raw_by_path: dict[str, _Change] = {}
    for line in lines:
        line = line.rstrip("\n")
        if line.startswith(_RECORD_SEP):
            if commit is not None:
                yield commit
            sha, author, email, ts, subject = line[1:].split(_FIELD_SEP, 4)
            commit = _Commit(sha, author, email, int(ts), subject)
            raw_by_path = {}
            continue
        if commit is None or not line:
            continue
        if line[0] == ":":
            # :100644 100644 abc def R065\told\tnew   or   ... M\tpath
            meta, _, paths = line.partition("\t")
            status = meta.split()[-1]
            kind = status[0]
            parts = [_unquote(p) for p in paths.split("\t")]
            if kind in ("R", "C"):
                old, new = parts[0], parts[1]
                ch = _Change("R" if kind == "R" else "A", new, old if kind == "R" else None)
            else:
                ch = _Change(kind, parts[0])
            commit.changes.append(ch)
            raw_by_path[ch.path] = ch
            continue
        # numstat: added\tremoved\tpath
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        a, r, path = parts
        path = _unquote(path)
        if " => " in path:
            _, path = expand_rename(path)
        ch = raw_by_path.get(path)
        if ch is None:
            ch = _Change("M", path)
            commit.changes.append(ch)
            raw_by_path[path] = ch
        if a != "-":
            ch.added = int(a)
            ch.removed = int(r)
    if commit is not None:
        yield commit


def extract(
    repo: str | os.PathLike[str],
    *,
    linear: bool = False,
    since: str | None = None,
    until: str | None = None,
    progress: Callable[[int], None] | None = None,
) -> dict:
    """Extract a timeline dict from the repository at ``repo``."""
    repo = os.fspath(repo)
    if not os.path.isdir(repo):
        raise ExtractError(f"not a directory: {repo}")
    args = _git_log_args(linear, since, until)
    proc = subprocess.Popen(
        args,
        cwd=repo,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1 << 16,
    )
    assert proc.stdout is not None

    file_ids: dict[str, int] = {}
    files: list[str] = []
    totals: list[int] = []
    alive: list[bool] = []
    author_ids: dict[str, int] = {}
    authors: list[dict] = []
    commits: list[dict] = []

    def fid(path: str) -> int:
        i = file_ids.get(path)
        if i is None:
            i = len(files)
            file_ids[path] = i
            files.append(path)
            totals.append(0)
            alive.append(False)
        return i

    for n, c in enumerate(_parse_log(proc.stdout)):
        # People change emails far more often than names; key on the name.
        key = c.author.strip().lower() or c.email.lower()
        ai = author_ids.get(key)
        if ai is None:
            ai = len(authors)
            author_ids[key] = ai
            authors.append({"name": c.author, "email": c.email, "commits": 0})
        authors[ai]["commits"] += 1

        changes: list[list[int]] = []
        for ch in c.changes:
            i = fid(ch.path)
            if ch.status == "D":
                totals[i] = 0
                alive[i] = False
                changes.append([i, ch.added, ch.removed, 0, DELETE])
                continue
            if ch.status == "R" and ch.old_path is not None:
                oi = fid(ch.old_path)
                carried = totals[oi]
                totals[oi] = 0
                alive[oi] = False
                totals[i] = max(0, carried + ch.added - ch.removed)
                alive[i] = True
                changes.append([i, ch.added, ch.removed, totals[i], RENAME, oi])
                continue
            kind = ADD if (ch.status == "A" or not alive[i]) else MODIFY
            totals[i] = max(0, totals[i] + ch.added - ch.removed)
            alive[i] = True
            changes.append([i, ch.added, ch.removed, totals[i], kind])

        commits.append({"h": c.sha[:12], "a": ai, "t": c.time, "m": c.subject, "c": changes})
        if progress and n % 500 == 0:
            progress(n)

    rc = proc.wait()
    if rc != 0:
        err = proc.stderr.read() if proc.stderr else ""
        raise ExtractError(f"git log failed ({rc}): {err.strip()}")

    # Running totals were computed in log order, so we must keep that order; but
    # author dates are not monotonic (clock skew, rebases, cherry-picks). Clamp
    # timestamps so the viewer gets a monotonic time axis.
    prev = 0
    for c in commits:
        if c["t"] < prev:
            c["t"] = prev
        prev = c["t"]
    rng = [commits[0]["t"], commits[-1]["t"]] if commits else [0, 0]
    return {
        "version": 1,
        "repo": os.path.basename(os.path.abspath(repo)).removesuffix(".git") or "repo",
        "range": rng,
        "authors": authors,
        "files": files,
        "commits": commits,
    }


def _stderr_progress(n: int) -> None:
    print(f"\r  {n} commits…", end="", file=sys.stderr, flush=True)
