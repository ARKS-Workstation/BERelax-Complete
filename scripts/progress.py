#!/usr/bin/env python3
"""Regenerate docs/PROGRESS.md from build/manifest.yaml. The manifest is the source of truth.

Run with no arguments to rewrite the ledger; run with --check to assert the committed ledger is what
this script would write today. The check is in `pnpm verify`, because a progress document that
disagrees with the manifest is worse than no progress document: it is the one artifact a reader
trusts to tell them where the build actually is.

It also refuses a DANGLING DEFERRAL — see `check_deferrals`. That check lives here rather than in its
own script because this is already the one thing that walks every unit and knows every status, and a
second manifest reader is a second answer to "which units exist".
"""
import re
import yaml, pathlib, sys

m = yaml.safe_load(open("build/manifest.yaml"))
units = sorted(m["units"], key=lambda u: u["order"])
by_id = {u["id"]: u for u in units}
ICON = {"done": "[x]", "in_progress": "[~]", "todo": "[ ]", "blocked": "[!]"}

def ready(u):
    return u["status"] == "todo" and all(by_id[d]["status"] == "done" for d in u.get("depends_on", []))

done = [u for u in units if u["status"] == "done"]
nxt = [u for u in units if ready(u)][:3]

# `meta.units_total` is a second count of the same list, and a second count is a future disagreement.
# It read 206 against 207 units for long enough that nobody knew which number was wrong — caught by an
# agent reading the two side by side, not by any gate. Asserted here because this is the script that
# already walks every unit, and the failure it prevents is a planning figure quoted from stale metadata.
declared = m.get("meta", {}).get("units_total")
if declared is not None and declared != len(units):
    print(
        f"FAIL  build/manifest.yaml meta.units_total says {declared} but the file holds {len(units)} "
        "units — correct the metadata, do not adjust it to match a stale plan"
    )
    raise SystemExit(1)

# ------------------------------------------------------------------------------------------------
# Dangling deferrals (W-SYS-11)
# ------------------------------------------------------------------------------------------------
#
# Deferring live work to a unit that cannot do it has now happened FOUR times in this build, and each
# time the work simply stopped existing without anybody deciding that:
#
#   1. M-TILL-09 pointed a live money bug at M-TILL-12, which was already `done`.
#   2. C-CRM-08 deferred the admin session to W-SYS-01, which is `done` and never owned one.
#   3. Twenty-one more references said "there is no admin session until W-SYS-01" in the same words,
#      across nine units — the whole admin estate, deferred to finished work. That is why W-SYS-11
#      exists, and re-pointing those references is that unit's one-off.
#   4. A reference naming a unit id that did not exist yet at all, written the morning W-SYS-12 was
#      allocated.
#
# The re-pointing is the one-off; THIS is the fix. A unit that is `done` will never pick anything up,
# and a unit id that names nothing never could, so a deferral to either is work with no owner — and
# nothing else in the build would ever say so.
#
# ## What it measures, stated exactly, because the claim must not be wider than the measurement
#
# It reads **`build/manifest.yaml` only**. It finds a DEFERRAL PHRASE from the closed list below
# followed by a unit-id-shaped token, and refuses two things:
#
#   * a token that is **not a unit id in this manifest** — always, with no escape;
#   * a token naming a unit whose status is **`done`** — unless the same string carries the marker
#     `DEFERRAL SATISFIED`.
#
# It does NOT scan source comments, ADRs or docs/. Several routes carry "until W-SYS-01" in a header
# comment, and those are real instances of the same defect — but a check that claimed to find every
# dangling deferral in the repository while reading one file would be exactly the defect this build
# keeps finding, so the message says which file it read. Widening it to source comments is a
# worthwhile follow-up and is recorded as a NOTE on W-SYS-11 rather than implied here.
#
# ## Why `DEFERRAL SATISFIED` exists rather than the check simply forbidding a done target
#
# A deferral to a unit that has SINCE completed is ambiguous by construction: "deferred to B-AVAIL-04"
# reads identically whether B-AVAIL-04 did the work or never heard of it, and the manifest carries no
# date to tell them apart. Forbidding the shape outright would have demanded that two dozen accurate
# historical notes be reworded; permitting it silently is what let the 21 accumulate.
#
# So the marker is the smallest thing that removes the ambiguity, and its value is not in the word: it
# is that writing it requires LOOKING at the target's status. That is the step nobody took four times.
# The marker asserts only what this script can verify — that the named unit is `done` — and never that
# the work happened.

ID_SHAPE = r"(?:[A-Z]-[A-Z]{2,5}-\d{2}|[A-Z]\d{2}|[A-Z]-[A-Z]\d)"
"""Every id shape the manifest actually uses: A-FIRST-01, F07 and B-M1. Derived from the id set, not
guessed — `scripts/test-gates.mjs` block 117 asserts this pattern matches every declared id, so a new
id shape cannot slip past the scan by being unrecognised."""

DEFERRAL_PHRASES = (
    r"deferred\s+to",
    r"deferred\s+until",
    r"defers\s+to",
    r"defer\s+to",
    r"until",
)
"""The closed list, printed in the failure so a reader can see what was searched for.

`until` is here because it is the form the 21 took — "there is no admin session until W-SYS-01" — and
it is the form with the soundest rule behind it: a sentence saying X does not exist UNTIL some unit is
a claim that the unit will bring X, so if that unit is already `done` the sentence is false whichever
way it is read. Either X arrived and the note is stale, or it did not and never will from there."""

SATISFIED_MARKER = "DEFERRAL SATISFIED"

SATISFIED_WINDOW = 100
"""How far after the named unit the marker may appear.

Scoped to the individual deferral rather than the whole string, and that is not fussiness: a NOTE
carrying two deferrals — one satisfied, one dangling — would be skipped entirely by a whole-string
test, so the marker on the harmless one would hide the other. Several notes defer twice."""

_DEFERRAL = re.compile(
    rf"\b(?:{'|'.join(DEFERRAL_PHRASES)})\s+(?P<target>{ID_SHAPE})\b"
)


def _strings(node):
    """Every string in a unit, so a deferral cannot hide in a field this did not think to read."""
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for value in node.values():
            yield from _strings(value)
    elif isinstance(node, list):
        for value in node:
            yield from _strings(value)


def check_deferrals(all_units):
    """Returns a list of problem strings. Empty is the only acceptable answer."""
    known = {u["id"]: u["status"] for u in all_units}
    problems = []
    for unit in all_units:
        for text in _strings(unit):
            for match in _DEFERRAL.finditer(text):
                target = match.group("target")
                if SATISFIED_MARKER in text[match.end() : match.end() + SATISFIED_WINDOW]:
                    continue
                # A unit may of course defer to itself in prose about its own scope; that is not a
                # deferral to another owner and cannot be dangling.
                if target == unit["id"]:
                    continue
                at = max(0, match.start() - 70)
                excerpt = " ".join(text[at : match.end() + 30].split())
                if target not in known:
                    problems.append(
                        f"{unit['id']}: defers to {target}, which is NOT a unit in this manifest. "
                        f"A deferral to an id that names nothing is work with no owner.\n      …{excerpt}…"
                    )
                elif known[target] == "done":
                    problems.append(
                        f"{unit['id']}: defers to {target}, whose status is `done`. A finished unit "
                        f"will never pick this up.\n      …{excerpt}…\n      If {target} already DID "
                        f"this, add the marker `{SATISFIED_MARKER}` to that NOTE to say so. If it did "
                        f"not, re-point the deferral at a unit that is still `todo`."
                    )
    return problems


deferral_problems = check_deferrals(units)
if deferral_problems:
    print(
        f"FAIL  {len(deferral_problems)} dangling deferral(s) in build/manifest.yaml — a deferral "
        "naming a `done` unit, or an id that does not exist.\n"
        "      Searched build/manifest.yaml ONLY (not source comments or docs/), for the phrases: "
        + ", ".join(p.replace(r"\s+", " ") for p in DEFERRAL_PHRASES)
    )
    for problem in deferral_problems:
        print(f"      - {problem}")
    raise SystemExit(1)

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

content = "\n".join(L)
target = pathlib.Path("docs/PROGRESS.md")

if "--check" in sys.argv:
    current = target.read_text() if target.exists() else None
    if current == content:
        print(f"PASS  docs/PROGRESS.md matches the manifest — {len(done)}/{len(units)} done")
        raise SystemExit(0)
    reason = "does not exist" if current is None else "is stale or hand-edited"
    print(f"FAIL  docs/PROGRESS.md {reason} — run `pnpm progress`")
    raise SystemExit(1)

target.write_text(content)
print(f"wrote docs/PROGRESS.md — {len(done)}/{len(units)} done, {len(nxt)} ready")

# What is left for the OWNER, printed on every emit. B-M1's acceptance line asks that "the run output
# names what remains blocked on the owner", and the `## Next up` section above cannot do it: it lists
# the units that are READY, so once every unit is `done` it is empty and the run says nothing at all
# about the thirty-odd external items that still hold the release. Those items do not stop being
# outstanding when the last unit lands — they are the whole content of the go/no-go check's first
# requirement (`pnpm go-no-go`, H-MIG-11) — so the ledger prints them with the units that named each
# one, from `blocked_on_owner` and nowhere else.
owner_items = {}
for u in units:
    for item in u.get("blocked_on_owner", []) or []:
        owner_items.setdefault(item, []).append(u["id"])
if owner_items:
    print(
        f"\nBlocked on the owner: {len(owner_items)} external item(s), named by "
        f"{sum(len(v) for v in owner_items.values())} unit(s). Every one of them is unmet until the "
        "owner clears it, and `pnpm go-no-go` refuses a release while any is (docs/11 §5 step 24)."
    )
    for item, named_by in sorted(owner_items.items()):
        print(f"  {item}  — {', '.join(sorted(named_by))}")
else:
    print("\nNothing is blocked on the owner, which no state of this manifest has ever reported.")
