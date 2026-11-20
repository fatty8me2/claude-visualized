#!/usr/bin/env python3
"""Why a Kiln hand-off does or doesn't show in Claude Visualized. Read-only.

Lists the last day's Kiln runs (Kiln's events file) and the last day's delegate_task calls (Claude Code transcripts under
~/.claude/projects), and pairs them the way the app does: same brief (one a prefix of the other), the run starting no more
than 15 s before the call and, once the call has returned, before it returned. Prints only times, ids, folders and the first
60 characters of each brief. Run it on the computer where Kiln runs:  python3 scripts/kiln-diagnose.py
"""

import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

DAY = 24 * 3600
NOW = time.time()
BEFORE = 15.0


def kiln_events_path() -> Path:
    o = os.environ.get("KILN_EVENTS_PATH")
    if o:
        return Path(o).expanduser()
    x = os.environ.get("XDG_CONFIG_HOME")
    return (Path(x) if x else Path.home() / ".config") / "kiln" / "events.jsonl"


def norm(s: str) -> str:
    s = re.sub(r"\s+", " ", s or "").strip()
    return s[:-1].rstrip() if s.endswith("…") else s


def same_task(a: str, b: str) -> bool:
    a, b = norm(a), norm(b)
    if len(a) < 8 or len(b) < 8:
        return bool(a) and a == b
    return b.startswith(a) if len(a) <= len(b) else a.startswith(b)


def iso(ts: str) -> float:
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def hm(t: float) -> str:
    return time.strftime("%H:%M:%S", time.localtime(t)) if t else "--:--:--"


def short(s: str, n: int = 60) -> str:
    s = re.sub(r"\s+", " ", s or "").strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def app_version() -> str:
    for p in ("/Applications/Claude Visualized.app", str(Path.home() / "Applications/Claude Visualized.app")):
        plist = Path(p) / "Contents/Info.plist"
        if plist.is_file():
            m = re.search(rb"<key>CFBundleShortVersionString</key>\s*<string>([^<]+)</string>", plist.read_bytes())
            return f"{m.group(1).decode() if m else '?'} ({p})"
    return "not found in /Applications"


def runs():
    path = kiln_events_path()
    out = {}
    for f in (Path(str(path) + ".1"), path):
        try:
            lines = f.read_text("utf-8", "replace").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            tid = e.get("task_id")
            if not isinstance(e, dict) or not tid:
                continue
            ts = float(e.get("ts") or 0)
            r = out.setdefault(tid, {"id": tid, "start": ts, "task": "", "cwd": "", "end": None, "ok": None, "model": ""})
            if e.get("kind") == "task_started":
                r["start"] = min(r["start"], ts) if r["start"] else ts
                r["task"] = e.get("task") or r["task"]
                r["cwd"] = e.get("cwd") or r["cwd"]
                r["model"] = e.get("model") or r["model"]
            elif e.get("kind") == "task_finished":
                r["end"], r["ok"] = ts, e.get("ok")
    return path, [r for r in out.values() if NOW - r["start"] < DAY]


def calls():
    root = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "projects"
    found, ends = {}, {}
    if not root.is_dir():
        return root, []
    for f in root.rglob("*.jsonl"):
        try:
            if NOW - f.stat().st_mtime > DAY:
                continue
            text = f.read_text("utf-8", "replace")
        except OSError:
            continue
        if "delegate_task" not in text:
            continue
        for line in text.splitlines():
            try:
                o = json.loads(line)
            except ValueError:
                continue
            msg = o.get("message") if isinstance(o, dict) else None
            content = msg.get("content") if isinstance(msg, dict) else None
            if not isinstance(content, list):
                continue
            for b in content:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_use" and re.match(r"^mcp__[\w-]*kiln[\w-]*__delegate_task$", b.get("name") or "", re.I):
                    i = b.get("input") or {}
                    found.setdefault(b.get("id"), {
                        "id": b.get("id"), "ts": iso(o.get("timestamp", "")), "task": i.get("task") or "",
                        "cwd": i.get("cwd") or o.get("cwd") or "", "name": b.get("name"),
                        "file": f.name, "sub": bool(o.get("isSidechain")), "session": o.get("sessionId", ""),
                    })
                elif b.get("type") == "tool_result" and b.get("tool_use_id"):
                    ends.setdefault(b["tool_use_id"], iso(o.get("timestamp", "")))
    for c in found.values():
        c["end"] = ends.get(c["id"])
    return root, sorted(found.values(), key=lambda c: c["ts"])


def main():
    print(f"Claude Visualized: {app_version()}")
    epath, rs = runs()
    croot, cs = calls()
    print(f"Kiln events: {epath} ({'found' if epath.exists() else 'MISSING'}), runs in the last day: {len(rs)}")
    print(f"Claude transcripts: {croot}, delegate_task calls in the last day: {len(cs)}")
    taken = set()
    print("\nCALLS (oldest first)")
    for c in cs:
        best, why = None, []
        for r in rs:
            if r["id"] in taken or not r["task"]:
                continue
            dt = r["start"] - c["ts"]
            latest = (max(0.0, c["end"] - c["ts"]) + BEFORE) if c["end"] else 6 * 3600
            st = same_task(c["task"][:300], r["task"])
            if st and -BEFORE <= dt <= latest:
                if best is None or abs(dt) < abs(best[1]):
                    best = (r, dt)
            elif st:
                why.append(f"run {r['id']} has the same brief but started {dt:+.0f}s after the call (allowed {-BEFORE:.0f}..{latest:+.0f}s)")
        flag = "OK " if best else "NO "
        print(f"{flag}{hm(c['ts'])} {c['id'][-8:]} {'subagent' if c['sub'] else 'main'} ends {hm(c['end'] or 0)} {c['name']}")
        print(f"     brief: {short(c['task'])!r}  cwd: {c['cwd']}  file: {c['file']}")
        if best:
            taken.add(best[0]["id"])
            print(f"     -> run {best[0]['id']} started {best[1]:+.0f}s, model {best[0]['model'] or '?'}")
        else:
            for w in why[:3]:
                print(f"     x {w}")
            if not why:
                print("     x no run with this brief in the events file")
    print("\nRUNS NOT MATCHED TO ANY CALL")
    for r in sorted(rs, key=lambda r: r["start"]):
        if r["id"] not in taken:
            print(f"   {hm(r['start'])} run {r['id']} ended {hm(r['end'] or 0)} cwd {r['cwd']}")
            print(f"     brief: {short(r['task'])!r}")


if __name__ == "__main__":
    sys.exit(main())
