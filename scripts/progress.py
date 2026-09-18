#!/usr/bin/env python3
"""Regenerate docs/PROGRESS.md from build/manifest.yaml. The manifest is the source of truth."""
import yaml, pathlib, sys

m = yaml.safe_load(open("build/manifest.yaml"))
units = sorted(m["units"], key=lambda u: u["order"])
by_id = {u["id"]: u for u in units}
ICON = {"done": "[x]", "in_progress": "[~]", "todo": "[ ]", "blocked": "[!]"}

def ready(u):
    return u["status"] == "todo" and all(by_id[d]["status"] == "done" for d in u.get("depends_on", []))

done = [u for u in units if u["status"] == "done"]
nxt = [u for u in units if ready(u)][:3]

L = ["# Build Progress", "",
     "Generated from `build/manifest.yaml` by `scripts/progress.py`. **Do not edit by hand.**", "",
     f"**{len(done)} / {len(units)} units complete.**", ""]

if nxt:
    L += ["## Next up", ""]
    for u in nxt:
        flag = "  — **needs owner input:** " + ", ".join(u["blocked_on_owner"]) if u.get("blocked_on_owner") else ""
        L += [f"1. **{u['id']} — {u['title']}**{flag}"]
    L += [""]

L += ["## All units", "", "| | Order | ID | Unit | Depends on | Milestone | Owner input |",
      "|---|---|---|---|---|---|---|"]
for u in units:
    L.append("| {} | {} | `{}` | {} | {} | {} | {} |".format(
        ICON.get(u["status"], "?"), u["order"], u["id"],
        u["title"] + (" *(expand)*" if u.get("expand") else ""),
        ", ".join(f"`{d}`" for d in u.get("depends_on", [])) or "—",
        u.get("milestone", "—"),
        ", ".join(u.get("blocked_on_owner", [])) or "—"))

L += ["", "## Legend", "",
      "`[x]` done  ·  `[~]` in progress  ·  `[ ]` todo  ·  `[!]` blocked", "",
      "*(expand)* = group-level unit; decompose into session-sized units before working it.",
      "",
      "A unit is `done` only when every acceptance check in the manifest passes in CI —",
      "never on assertion. See [12-autonomous-delivery.md](12-autonomous-delivery.md) §6.", ""]

pathlib.Path("docs/PROGRESS.md").write_text("\n".join(L))
print(f"wrote docs/PROGRESS.md — {len(done)}/{len(units)} done, {len(nxt)} ready")
