import json
import os
import subprocess
from pathlib import Path

import pytest

from git_cities.extract import ADD, DELETE, MODIFY, RENAME, expand_rename, extract, _unquote


def git(repo: Path, *args: str, **env: str) -> str:
    e = {
        **os.environ,
        "GIT_AUTHOR_NAME": env.get("name", "Ada"),
        "GIT_AUTHOR_EMAIL": env.get("email", "ada@example.com"),
        "GIT_COMMITTER_NAME": "C",
        "GIT_COMMITTER_EMAIL": "c@example.com",
        "GIT_AUTHOR_DATE": env.get("date", "2020-01-01T00:00:00+0000"),
        "GIT_COMMITTER_DATE": env.get("date", "2020-01-01T00:00:00+0000"),
    }
    return subprocess.check_output(["git", *args], cwd=repo, env=e, text=True)


def write(repo: Path, rel: str, lines: int) -> None:
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("".join(f"line {i}\n" for i in range(lines)))


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    r = tmp_path / "r"
    r.mkdir()
    git(r, "init", "-q", "-b", "main")
    git(r, "config", "user.name", "C")
    git(r, "config", "user.email", "c@example.com")
    return r


def commit(repo: Path, msg: str, date: str, **who: str) -> None:
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", msg, date=date, **who)


def test_lifecycle(repo: Path) -> None:
    write(repo, "src/a.py", 10)
    write(repo, "README.md", 3)
    commit(repo, "init", "2020-01-01T00:00:00+0000")
    write(repo, "src/a.py", 25)
    commit(repo, "grow a", "2020-01-02T00:00:00+0000", name="Bob", email="bob@example.com")
    write(repo, "src/a.py", 5)
    commit(repo, "shrink a", "2020-01-03T00:00:00+0000")
    git(repo, "mv", "src/a.py", "src/b.py")
    commit(repo, "rename", "2020-01-04T00:00:00+0000")
    (repo / "README.md").unlink()
    commit(repo, "drop readme", "2020-01-05T00:00:00+0000")

    tl = extract(repo)
    assert tl["version"] == 1
    assert tl["repo"] == "r"
    assert [a["name"] for a in tl["authors"]] == ["Ada", "Bob"]
    assert [a["commits"] for a in tl["authors"]] == [4, 1]
    assert len(tl["commits"]) == 5
    f = tl["files"]
    c = tl["commits"]

    assert c[0]["m"] == "init"
    assert c[0]["a"] == 0
    assert sorted(ch[4] for ch in c[0]["c"]) == [ADD, ADD]
    a = f.index("src/a.py")
    assert [ch for ch in c[0]["c"] if ch[0] == a][0] == [a, 10, 0, 10, ADD]

    assert c[1]["a"] == 1
    assert c[1]["c"] == [[a, 15, 0, 25, MODIFY]]
    assert c[2]["c"] == [[a, 0, 20, 5, MODIFY]]

    b = f.index("src/b.py")
    assert c[3]["c"] == [[b, 0, 0, 5, RENAME, a]]

    r = f.index("README.md")
    assert c[4]["c"] == [[r, 0, 3, 0, DELETE]]
    assert tl["range"] == [c[0]["t"], c[4]["t"]]
    assert json.dumps(tl)  # serialisable


def test_binary_and_unicode_paths(repo: Path) -> None:
    (repo / "img.png").write_bytes(bytes(range(256)) * 4)
    write(repo, "dir with space/naïve ☃.txt", 2)
    write(repo, "tab\tname.txt", 1)
    commit(repo, "weird", "2020-01-01T00:00:00+0000")
    tl = extract(repo)
    assert set(tl["files"]) == {"img.png", "dir with space/naïve ☃.txt", "tab\tname.txt"}
    by = {tl["files"][ch[0]]: ch for ch in tl["commits"][0]["c"]}
    assert by["img.png"][1:4] == [0, 0, 0]
    assert by["dir with space/naïve ☃.txt"][1:4] == [2, 0, 2]
    assert by["tab\tname.txt"][1:4] == [1, 0, 1]


def test_readd_after_delete_is_add(repo: Path) -> None:
    write(repo, "x.txt", 4)
    commit(repo, "a", "2020-01-01T00:00:00+0000")
    (repo / "x.txt").unlink()
    commit(repo, "b", "2020-01-02T00:00:00+0000")
    write(repo, "x.txt", 7)
    commit(repo, "c", "2020-01-03T00:00:00+0000")
    tl = extract(repo)
    kinds = [c["c"][0][4] for c in tl["commits"]]
    assert kinds == [ADD, DELETE, ADD]
    assert tl["commits"][2]["c"][0][3] == 7
    assert len(tl["files"]) == 1


def test_timestamps_monotonic(repo: Path) -> None:
    write(repo, "x.txt", 1)
    commit(repo, "later", "2021-06-01T00:00:00+0000")
    write(repo, "x.txt", 2)
    commit(repo, "earlier-dated", "2020-01-01T00:00:00+0000")
    tl = extract(repo)
    ts = [c["t"] for c in tl["commits"]]
    assert ts == sorted(ts)
    assert tl["commits"][1]["c"][0][3] == 2


def test_merge_commits_skipped_but_branch_commits_kept(repo: Path) -> None:
    write(repo, "a.txt", 1)
    commit(repo, "base", "2020-01-01T00:00:00+0000")
    git(repo, "checkout", "-q", "-b", "feat")
    write(repo, "b.txt", 3)
    commit(repo, "feature", "2020-01-02T00:00:00+0000", name="Bob", email="bob@example.com")
    git(repo, "checkout", "-q", "main")
    write(repo, "a.txt", 2)
    commit(repo, "main work", "2020-01-03T00:00:00+0000")
    git(repo, "merge", "-q", "--no-ff", "-m", "merge", "feat", date="2020-01-04T00:00:00+0000")
    tl = extract(repo)
    assert [c["m"] for c in tl["commits"]] == ["base", "feature", "main work"]
    lin = extract(repo, linear=True)
    assert [c["m"] for c in lin["commits"]] == ["base", "main work", "merge"]
    merge = lin["commits"][-1]
    assert lin["files"][merge["c"][0][0]] == "b.txt"
    assert merge["c"][0][3] == 3


def test_since_until(repo: Path) -> None:
    for i, d in enumerate(["2020-01-01", "2020-02-01", "2020-03-01"]):
        write(repo, "x.txt", i + 1)
        commit(repo, d, f"{d}T00:00:00+0000")
    tl = extract(repo, since="2020-01-15", until="2020-02-15")
    assert [c["m"] for c in tl["commits"]] == ["2020-02-01"]


def test_expand_rename() -> None:
    assert expand_rename("a/{b => c}/d.py") == ("a/b/d.py", "a/c/d.py")
    assert expand_rename("old.md => new.md") == ("old.md", "new.md")
    assert expand_rename("src/{ => sub}/x.py") == ("src/x.py", "src/sub/x.py")


def test_unquote() -> None:
    assert _unquote('"a\\tb"') == "a\tb"
    assert _unquote('"\\303\\251"') == "é"
    assert _unquote("plain") == "plain"


def test_not_a_repo(tmp_path: Path) -> None:
    from git_cities.extract import ExtractError

    with pytest.raises(ExtractError):
        extract(tmp_path)
