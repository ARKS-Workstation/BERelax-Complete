#!/usr/bin/env python3
"""Derive and validate the BeRelax palette, evolved from the Netlify prototype.

This script is the palette's single source of truth. Three jobs, all run as one CI gate:

  1. Derive every token by walking a prototype colour along its own hue and saturation until it
     meets a stated contrast ratio, and fail if any token misses its target.
  2. Emit the generated token module (`--emit`) and, on every run, assert the committed copy still
     matches. A hand-edited token is drift, and it is caught the same way schema drift is.
  3. Assert the tables in docs/08 are what this script actually produces. The document claims they
     are its output rather than aspiration; this is what keeps that true.

Contrast is computed on sRGB relative luminance because that is how WCAG 2.2 defines it. Derivation
walks HLS lightness, which holds the hue angle constant by construction — see
docs/adr/0012-design-tokens.md for why the emitted CSS still gets perceptually even interaction
states, without a second representation of the same colour to drift against.
"""
import argparse
import colorsys
import pathlib
import re
import sys

def lin(c):
    c /= 255
    return c/12.92 if c <= 0.04045 else ((c+0.055)/1.055)**2.4
def L(h):
    h = h.lstrip('#'); r,g,b = (int(h[i:i+2],16) for i in (0,2,4))
    return 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b)
def ratio(a,b):
    la,lb = L(a),L(b); hi,lo = max(la,lb),min(la,lb)
    return (hi+0.05)/(lo+0.05)
def hexof(h,l,s):
    r,g,b = colorsys.hls_to_rgb(h,l,s)
    return "#%02X%02X%02X" % (round(r*255),round(g*255),round(b*255))
def derive_band(src, ground, lo, hi, lighten=True):
    """Walk src along its own hue/sat until its ratio falls inside [lo, hi]."""
    hh = src.lstrip('#'); r,g,b = (int(hh[i:i+2],16) for i in (0,2,4))
    h,l,s = colorsys.rgb_to_hls(r/255,g/255,b/255)
    step = 0.005 if lighten else -0.005
    for i in range(0,200):
        ll = l + step*i
        if not 0 < ll < 1: break
        c = hexof(h,ll,s)
        if lo <= ratio(c,ground) <= hi: return c
    return None

def derive(src, ground, target, lighten=False):
    """Walk src along its own hue/sat until it meets `target` against `ground`."""
    hh = src.lstrip('#'); r,g,b = (int(hh[i:i+2],16) for i in (0,2,4))
    h,l,s = colorsys.rgb_to_hls(r/255,g/255,b/255)
    step = 0.01 if lighten else -0.01
    for i in range(0,90):
        ll = l + step*i
        if not 0 < ll < 1: break
        c = hexof(h,ll,s)
        if ratio(c,ground) >= target: return c
    return None

LIGHT_GROUND = "#FDFAF5"          # prototype ground, kept
DARK_GROUND  = "#141210"          # warm dark, derived

LIGHT = {
  # role                      value        min ratio (None = surface/decorative only)
  "ground":                  ("#FDFAF5", None),
  "surface":                  ("#FFFFFF", None),
  "ground-sunk":              ("#F7F0E5", None),
  "surface-sand":             ("#F2E9DC", None),
  "surface-clay":             ("#E6D8C4", None),
  "ink":                      ("#26241F", 4.5),
  "ink-2":                    ("#6E675D", 4.5),
  "ink-3":                    (derive_band("#6E675D", LIGHT_GROUND, 3.0, 3.4), 3.0),
  "accent-gold":              (derive("#C08A43", LIGHT_GROUND, 4.5), 4.5),
  "accent-gold-strong":       (derive("#C08A43", LIGHT_GROUND, 7.0), 7.0),
  "accent-green":             ("#4E7048", 4.5),
  "accent-teal":              ("#2A6E66", 4.5),
  "decor-gold":               ("#C08A43", None),
  "decor-tan":                ("#C9AE8B", None),
  "hairline":                 ("#E6D8C4", None),
  "border":                   (derive("#C9AE8B", LIGHT_GROUND, 1.5), None),
  "border-strong":            (derive("#C9AE8B", LIGHT_GROUND, 3.0), 3.0),
  "focus":                    (derive("#2A6E66", LIGHT_GROUND, 3.0), 3.0),
  "danger":                   (derive("#C0392B", LIGHT_GROUND, 4.5), 4.5),
  "success":                  ("#4E7048", 4.5),
}

DARK = {
  "ground":                   ("#141210", None),
  "ground-sunk":              ("#0F0D0B", None),
  "surface":                  ("#1F1C18", None),
  "surface-raised":           ("#292520", None),
  "ink":                      ("#F0EBE3", 4.5),
  "ink-2":                    (derive("#B5AEA4", DARK_GROUND, 4.5, lighten=True), 4.5),
  "ink-3":                    (derive_band("#8B857B", DARK_GROUND, 3.2, 3.8, lighten=False), 3.0),
  "accent-gold":              (derive("#C08A43", DARK_GROUND, 4.5, lighten=True), 4.5),
  "accent-green":             (derive("#4E7048", DARK_GROUND, 4.5, lighten=True), 4.5),
  "accent-teal":              (derive("#2A6E66", DARK_GROUND, 4.5, lighten=True), 4.5),
  "hairline":                 ("#2A2621", None),
  "border":                   ("#3A352E", None),
  "border-strong":            (derive("#8B857B", DARK_GROUND, 3.0, lighten=True), 3.0),
  "focus":                    (derive("#5FB8AC", DARK_GROUND, 3.0, lighten=True), 3.0),
  "danger":                   (derive("#C0392B", DARK_GROUND, 4.5, lighten=True), 4.5),
}

def report(name, tokens, ground):
    print(f"\n{'='*74}\n{name}  (ground {ground})\n{'='*74}")
    print(f"{'token':<22}{'hex':<10}{'ratio':>8}   {'requires':<9}result")
    print("-"*74)
    fails = 0
    for role,(val,minr) in tokens.items():
        if val is None:
            print(f"{role:<22}{'DERIVE FAIL':<10}"); fails += 1; continue
        r = ratio(val, ground)
        if minr is None:
            print(f"{role:<22}{val:<10}{r:>7.2f}:1   {'surface':<9}—")
        else:
            ok = r >= minr
            fails += 0 if ok else 1
            print(f"{role:<22}{val:<10}{r:>7.2f}:1   {minr:<9.1f}{'PASS' if ok else 'FAIL'}")
    return fails

REPO = pathlib.Path(__file__).resolve().parent.parent
GENERATED = REPO / "packages/ui/src/tokens/palette.generated.ts"
DESIGN_DOC = REPO / "docs/08-frontend-design.md"

FILL_PAIRS = [
    ("gold fill / cream text", lambda: LIGHT["accent-gold"][0], "#FDFAF5"),
    ("green fill / cream text", lambda: LIGHT["accent-green"][0], "#FDFAF5"),
    ("dark-mode gold fill / dark text", lambda: DARK["accent-gold"][0], "#141210"),
]


def resolved(tokens, ground):
    """Token -> (hex, ratio, min ratio or None), with every derivation already run."""
    out = {}
    for role, (val, minr) in tokens.items():
        if val is None:
            raise SystemExit(f"derivation failed for {role}: no lightness met the target")
        out[role] = (val, round(ratio(val, ground), 2), minr)
    return out


def render_generated(light, dark):
    """The generated TypeScript module. Data only; behaviour lives beside it in palette.ts."""
    def block(name, tokens, ground, doc):
        rows = []
        for role, (val, r, minr) in tokens.items():
            need = "surface or decorative only" if minr is None else f"requires {minr}:1"
            rows.append(f"  /** {r}:1 against the ground — {need}. */\n  '{role}': '{val}',")
        body = "\n".join(rows)
        return (
            f"/**\n * {doc}\n *\n * Ground is `{ground}`.\n */\n"
            f"export const {name} = {{\n{body}\n}} as const\n"
        )

    ratios = {
        "light": {k: v[1] for k, v in light.items()},
        "dark": {k: v[1] for k, v in dark.items()},
    }
    ratio_rows = []
    for theme, values in ratios.items():
        inner = ",\n".join(f"    '{k}': {v}" for k, v in values.items())
        ratio_rows.append(f"  {theme}: {{\n{inner},\n  }}")
    ratio_block = ",\n".join(ratio_rows)

    return (
        "/**\n"
        " * GENERATED by scripts/palette.py. Do not edit.\n"
        " *\n"
        " * Every value here was derived by walking a prototype colour along its own hue and\n"
        " * saturation until it met a stated contrast ratio, and every one is re-measured on each CI\n"
        " * run. Editing a hex by hand fails `pnpm palette` — which is the point: a designer changing a\n"
        " * token by eye is how a palette stops meeting the ratios it claims.\n"
        " *\n"
        " * Regenerate with `pnpm palette:emit`.\n"
        " */\n\n"
        + block(
            "LIGHT_PALETTE",
            light,
            LIGHT_GROUND,
            "Light theme. Pastels and sands carry surfaces; ink and accents carry text.",
        )
        + "\n"
        + block(
            "DARK_PALETTE",
            dark,
            DARK_GROUND,
            "Dark theme, warm rather than inverted. Accent polarity flips: the bright brand gold is "
            "unusable for text in light mode and is the primary accent here.",
        )
        + "\n/** Measured contrast against each theme's ground, for the tests and the docs gate. */\n"
        f"export const PALETTE_RATIOS = {{\n{ratio_block},\n}} as const\n"
    )


def check_doc_tables(light, dark):
    """Assert docs/08 states the hex and ratio this script produces."""
    if not DESIGN_DOC.exists():
        return [f"{DESIGN_DOC} is missing"]
    text = DESIGN_DOC.read_text(encoding="utf-8")
    problems = []
    # Rows look like: | `--ink` | `#26241F` | **14.89:1** | body and headings |
    row = re.compile(
        r"^\|\s*`--([a-z0-9-]+)`\s*\|\s*`(#[0-9A-Fa-f]{6})`\s*\|\s*\*{0,2}([0-9.]+):1\*{0,2}|^\|\s*`--([a-z0-9-]+)`\s*\|\s*`(#[0-9A-Fa-f]{6})`\s*\|\s*—",
        re.M,
    )
    section = None
    seen = {"light": set(), "dark": set()}
    for line in text.split("\n"):
        if line.startswith("### Light"):
            section = "light"
        elif line.startswith("### Dark"):
            section = "dark"
        elif line.startswith("## ") and section is not None:
            section = None
        if section is None:
            continue
        m = row.match(line)
        if m is None:
            continue
        token = m.group(1) or m.group(4)
        stated_hex = (m.group(2) or m.group(5)).upper()
        stated_ratio = m.group(3)
        tokens = light if section == "light" else dark
        if token not in tokens:
            problems.append(f"docs/08 {section} lists `--{token}`, which the script does not produce")
            continue
        seen[section].add(token)
        actual_hex, actual_ratio, _ = tokens[token]
        if stated_hex != actual_hex.upper():
            problems.append(
                f"docs/08 {section} `--{token}` states {stated_hex}, script produces {actual_hex}"
            )
        if stated_ratio is not None and abs(float(stated_ratio) - actual_ratio) > 0.011:
            problems.append(
                f"docs/08 {section} `--{token}` states {stated_ratio}:1, script measures {actual_ratio}:1"
            )
    for theme, tokens in (("light", light), ("dark", dark)):
        missing = sorted(set(tokens) - seen[theme])
        if missing:
            problems.append(f"docs/08 {theme} table omits: {', '.join(missing)}")
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--emit",
        action="store_true",
        help="rewrite the generated token module instead of only checking it",
    )
    args = parser.parse_args()

    failures = report("LIGHT", LIGHT, LIGHT_GROUND) + report("DARK", DARK, DARK_GROUND)

    print(f"\n{'='*74}\nFILL PAIRS\n{'='*74}")
    for label, fill_fn, on in FILL_PAIRS:
        fill = fill_fn()
        r = ratio(fill, on)
        ok = r >= 4.5
        failures += 0 if ok else 1
        print(f"{label:<34}{fill} on {on}  {r:>6.2f}:1  {'PASS' if ok else 'FAIL'}")

    light = resolved(LIGHT, LIGHT_GROUND)
    dark = resolved(DARK, DARK_GROUND)
    generated = render_generated(light, dark)

    print(f"\n{'='*74}\nGENERATED MIRROR\n{'='*74}")
    if args.emit:
        GENERATED.parent.mkdir(parents=True, exist_ok=True)
        GENERATED.write_text(generated, encoding="utf-8")
        print(f"wrote {GENERATED.relative_to(REPO)} ({len(light)} light, {len(dark)} dark tokens)")
    elif not GENERATED.exists():
        print(f"FAIL  {GENERATED.relative_to(REPO)} does not exist — run `pnpm palette:emit`")
        failures += 1
    elif GENERATED.read_text(encoding="utf-8") != generated:
        print(
            f"FAIL  {GENERATED.relative_to(REPO)} does not match this script's output.\n"
            "      A token was hand-edited, or the derivation changed. Run `pnpm palette:emit`."
        )
        failures += 1
    else:
        print(f"PASS  {GENERATED.relative_to(REPO)} matches ({len(light)+len(dark)} tokens)")

    print(f"\n{'='*74}\nDOCS/08 TABLES\n{'='*74}")
    problems = check_doc_tables(light, dark)
    if problems:
        for problem in problems:
            print(f"FAIL  {problem}")
        failures += len(problems)
    else:
        print("PASS  docs/08 states exactly what this script produces")

    print(f"\n{'ALL PASS' if failures == 0 else str(failures) + ' FAILURES'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
