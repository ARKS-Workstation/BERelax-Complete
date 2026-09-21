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

def min_ratio(colour, surfaces):
    """The worst contrast `colour` achieves against any of `surfaces`.

    The worst case is the whole question. A token derived against the ground alone meets its stated ratio on
    the one surface it was measured against and misses it on the card beside it — which is how dark-mode
    `danger` came to measure 4.53:1 on the ground and 3.69:1 on `surface-raised` while this script reported
    PASS, and why F11's acceptance line "every text pair meets its stated ratio" was not what was checked.
    """
    return min(ratio(colour, surface) for surface in surfaces)


def worst_surface(colour, surfaces):
    """Which surface gives `colour` its worst contrast — for the failure message, so it names the pairing."""
    return min(surfaces, key=lambda surface: ratio(colour, surface))


def derive_all(src, surfaces, target, lighten=False):
    """Walk src along its own hue and saturation until it meets `target` against EVERY surface given.

    Terminating, because the walk is monotone in the direction it is asked to go: darkening in a light theme
    raises the ratio against every light surface at once, and lightening in a dark theme does the same. So
    the first lightness that clears the worst surface clears all of them.
    """
    hh = src.lstrip('#'); r,g,b = (int(hh[i:i+2],16) for i in (0,2,4))
    h,l,s = colorsys.rgb_to_hls(r/255,g/255,b/255)
    step = 0.01 if lighten else -0.01
    for i in range(0,90):
        ll = l + step*i
        if not 0 < ll < 1: break
        c = hexof(h,ll,s)
        if min_ratio(c, surfaces) >= target: return c
    return None


def derive_band_all(src, surfaces, lo, hi, lighten=True):
    """`derive_band`, with the band measured against the worst surface instead of the ground.

    The band is how a deliberately quiet token stays quiet: below `lo` it is illegible, above `hi` it is
    louder than the design intends and stops reading as secondary. Measuring it on the worst surface is what
    makes "quiet" mean the same thing on a card as on the page.
    """
    hh = src.lstrip('#'); r,g,b = (int(hh[i:i+2],16) for i in (0,2,4))
    h,l,s = colorsys.rgb_to_hls(r/255,g/255,b/255)
    step = 0.005 if lighten else -0.005
    for i in range(0,200):
        ll = l + step*i
        if not 0 < ll < 1: break
        c = hexof(h,ll,s)
        if lo <= min_ratio(c, surfaces) <= hi: return c
    return None


LIGHT_GROUND = "#FDFAF5"          # prototype ground, kept
DARK_GROUND  = "#141210"          # warm dark, derived

# Every surface a component may put behind something, by theme.
#
# These live here, above the token tables, rather than only inside them, because a token's contrast has to
# be derived against them and a dict cannot reference itself while it is being built. The surface rows below
# read from these, so there is still one spelling of each hex.
LIGHT_SURFACES = {
  "ground":         "#FDFAF5",
  "surface":        "#FFFFFF",
  "surface-raised": "#FFFFFF",
  "ground-sunk":    "#F7F0E5",
  "surface-sand":   "#F2E9DC",
  "surface-clay":   "#E6D8C4",
}

DARK_SURFACES = {
  "ground":         "#141210",
  "surface":        "#1F1C18",
  "surface-raised": "#292520",
  "ground-sunk":    "#0F0D0B",
  "surface-sand":   "#231F1A",
  "surface-clay":   "#2F2A24",
}

# The surfaces text may NOT sit on. docs/08 section 3 gives `surface-clay` as "large shapes, **never text**",
# so it is excluded by that rule and not by convenience: deriving against it would darken half the light
# palette to serve a pairing the design system forbids.
NON_TEXT_SURFACES = ("surface-clay",)


def text_surfaces(surfaces):
    """The surfaces a text token has to be legible on, as a list of hexes, deduplicated.

    `surface` and `surface-raised` are both #FFFFFF in light mode, and measuring the same hex twice only
    slows the walk down.
    """
    return sorted({hex_ for name, hex_ in surfaces.items() if name not in NON_TEXT_SURFACES})


LIGHT_TEXT_SURFACES = text_surfaces(LIGHT_SURFACES)
DARK_TEXT_SURFACES  = text_surfaces(DARK_SURFACES)

# Each token's stated ratio is the WORST it achieves across the surfaces text is allowed on, not its ratio
# against the ground. `min_ratio` records what that change caught.
LIGHT = {
  # role                      value        min ratio (None = surface/decorative only)
  "ground":                   (LIGHT_SURFACES["ground"], None),
  "surface":                  (LIGHT_SURFACES["surface"], None),
  # In light there is nowhere above white, so elevation is carried by --shadow-overlay rather than by
  # lightness; in dark it is the reverse (docs/08 section 2). The token exists in both themes anyway,
  # because a component should not have to know which theme it is in to pick a surface.
  "surface-raised":           (LIGHT_SURFACES["surface-raised"], None),
  "ground-sunk":              (LIGHT_SURFACES["ground-sunk"], None),
  "surface-sand":             (LIGHT_SURFACES["surface-sand"], None),
  "surface-clay":             (LIGHT_SURFACES["surface-clay"], None),
  "ink":                      ("#26241F", 4.5),
  "ink-2":                    ("#6E675D", 4.5),
  "ink-3":                    (derive_band_all("#6E675D", LIGHT_TEXT_SURFACES, 3.0, 3.4), 3.0),
  "accent-gold":              (derive_all("#C08A43", LIGHT_TEXT_SURFACES, 4.5), 4.5),
  "accent-gold-strong":       (derive_all("#C08A43", LIGHT_TEXT_SURFACES, 7.0), 7.0),
  "accent-green":             ("#4E7048", 4.5),
  "accent-teal":              ("#2A6E66", 4.5),
  "decor-gold":               ("#C08A43", None),
  "decor-tan":                ("#C9AE8B", None),
  "hairline":                 ("#E6D8C4", None),
  # `border` keeps its ground-relative 1.5 floor. It states no minimum, so nothing here would check a
  # stricter one, and darkening a separator no rule asks to be darker is a design decision rather than a
  # correctness fix. Its disappearance on a sand section is recorded in docs/OPEN-QUESTIONS.md instead.
  "border":                   (derive("#C9AE8B", LIGHT_GROUND, 1.5), None),
  # `border-strong` and `focus` are not text, and they still take the worst text surface: WCAG 2.2 1.4.11
  # measures non-text contrast against the ADJACENT colour, which for a control's edge and its focus ring is
  # whatever surface the control sits on. A focus ring visible on the page and invisible on a card is the
  # same defect as illegible body text, and harder to notice.
  "border-strong":            (derive_all("#C9AE8B", LIGHT_TEXT_SURFACES, 3.0), 3.0),
  "focus":                    (derive_all("#2A6E66", LIGHT_TEXT_SURFACES, 3.0), 3.0),
  "danger":                   (derive_all("#C0392B", LIGHT_TEXT_SURFACES, 4.5), 4.5),
  "success":                  ("#4E7048", 4.5),
}

DARK = {
  "ground":                   (DARK_SURFACES["ground"], None),
  "ground-sunk":              (DARK_SURFACES["ground-sunk"], None),
  "surface":                  (DARK_SURFACES["surface"], None),
  "surface-raised":           (DARK_SURFACES["surface-raised"], None),
  # Every token the light theme uses needs a dark counterpart, or it keeps its LIGHT value in dark
  # mode — the variable is simply not redefined. That is not a subtle bug: a sand band at #F2E9DC
  # under #F0EBE3 ink measures 1.01:1, and the section is invisible. The self-critique pass found
  # exactly that on its first run, which is what these five rows are.
  "surface-sand":             (DARK_SURFACES["surface-sand"], None),
  "surface-clay":             (DARK_SURFACES["surface-clay"], None),
  "ink":                      ("#F0EBE3", 4.5),
  "ink-2":                    (derive_all("#B5AEA4", DARK_TEXT_SURFACES, 4.5, lighten=True), 4.5),
  "ink-3":                    (derive_band_all("#8B857B", DARK_TEXT_SURFACES, 3.2, 3.8, lighten=False), 3.0),
  "accent-gold":              (derive_all("#C08A43", DARK_TEXT_SURFACES, 4.5, lighten=True), 4.5),
  "accent-gold-strong":       (derive_all("#C08A43", DARK_TEXT_SURFACES, 7.0, lighten=True), 7.0),
  "accent-green":             (derive_all("#4E7048", DARK_TEXT_SURFACES, 4.5, lighten=True), 4.5),
  "accent-teal":              (derive_all("#2A6E66", DARK_TEXT_SURFACES, 4.5, lighten=True), 4.5),
  # The brand gold needs no darkening here: on the dark ground it reaches 6.19:1 unchanged, which is
  # the polarity flip that makes theme-aware tokens worth the trouble.
  "decor-gold":               ("#C08A43", None),
  "decor-tan":                ("#C9AE8B", None),
  "hairline":                 ("#2A2621", None),
  "border":                   ("#3A352E", None),
  "border-strong":            (derive_all("#8B857B", DARK_TEXT_SURFACES, 3.0, lighten=True), 3.0),
  "focus":                    (derive_all("#5FB8AC", DARK_TEXT_SURFACES, 3.0, lighten=True), 3.0),
  "danger":                   (derive_all("#C0392B", DARK_TEXT_SURFACES, 4.5, lighten=True), 4.5),
  "success":                  (derive_all("#4E7048", DARK_TEXT_SURFACES, 4.5, lighten=True), 4.5),
}

def report(name, tokens, ground, surfaces):
    """Every token against the ground AND against the worst surface text is allowed on.

    Both columns, because they answer different questions. The ground ratio is what docs/08 states and what
    `PALETTE_RATIOS` carries; the worst-surface ratio is the one the token actually has to clear. They were
    the same number only for as long as every text token was assumed to sit on the page background — and the
    PASS/FAIL column is now the worst surface, so a token legible on the page and not on a card fails here.
    """
    text = {n: h for n, h in surfaces.items() if n not in NON_TEXT_SURFACES}
    print(f"\n{'='*94}\n{name}  (ground {ground}; worst text surface of {len(text)})\n{'='*94}")
    print(f"{'token':<21}{'hex':<9}{'on ground':>10}{'worst':>8}  {'on':<16}{'requires':<9}result")
    print("-"*94)
    fails = 0
    for role,(val,minr) in tokens.items():
        if val is None:
            print(f"{role:<21}{'DERIVE FAIL':<9}"); fails += 1; continue
        on_ground = ratio(val, ground)
        worst_name = min(text, key=lambda n: ratio(val, text[n]))
        worst = ratio(val, text[worst_name])
        if minr is None:
            print(f"{role:<21}{val:<9}{on_ground:>9.2f}:1{worst:>7.2f}:1  {worst_name:<16}{'surface':<9}—")
        else:
            ok = worst >= minr
            fails += 0 if ok else 1
            print(
                f"{role:<21}{val:<9}{on_ground:>9.2f}:1{worst:>7.2f}:1  {worst_name:<16}{minr:<9.1f}"
                f"{'PASS' if ok else 'FAIL'}"
            )
            # A named line as well as the table row, because a column of aligned numbers is not a failure
            # message: this is what the gate matches on and what a reader greps for.
            if not ok:
                print(
                    f"      [worst-surface-contrast] --color-{role} is {worst:.2f}:1 on "
                    f"--color-{worst_name}, needs {minr}:1 — legible on the page, not on that surface"
                )
    return fails

REPO = pathlib.Path(__file__).resolve().parent.parent
GENERATED = REPO / "packages/ui/src/tokens/palette.generated.ts"
DESIGN_DOC = REPO / "docs/08-frontend-design.md"

FILL_PAIRS = [
    ("gold fill / cream text", lambda: LIGHT["accent-gold"][0], "#FDFAF5"),
    ("green fill / cream text", lambda: LIGHT["accent-green"][0], "#FDFAF5"),
    ("dark-mode gold fill / dark text", lambda: DARK["accent-gold"][0], "#141210"),
]


def resolved(tokens, ground, surfaces):
    """Token -> measurements, with every derivation already run.

    A dict per token rather than a tuple: there are now two ratios that matter and naming them is cheaper
    than remembering which index is which. `on_ground` is what docs/08 has always stated; `worst` is the
    number the token is actually held to, and `worst_on` names the surface so a failure is actionable.
    """
    text = {n: h for n, h in surfaces.items() if n not in NON_TEXT_SURFACES}
    out = {}
    for role, (val, minr) in tokens.items():
        if val is None:
            raise SystemExit(f"derivation failed for {role}: no lightness met the target")
        worst_on = min(text, key=lambda n: ratio(val, text[n]))
        out[role] = {
            "hex": val,
            "on_ground": round(ratio(val, ground), 2),
            "worst": round(ratio(val, text[worst_on]), 2),
            "worst_on": worst_on,
            "min": minr,
        }
    return out


def render_generated(light, dark):
    """The generated TypeScript module. Data only; behaviour lives beside it in palette.ts."""
    def block(name, tokens, ground, doc):
        rows = []
        for role, m in tokens.items():
            need = "surface or decorative only" if m["min"] is None else f"requires {m['min']}:1"
            rows.append(
                f"  /** {m['on_ground']}:1 on the ground, {m['worst']}:1 on {m['worst_on']} — {need}. */\n"
                f"  '{role}': '{m['hex']}',"
            )
        body = "\n".join(rows)
        return (
            f"/**\n * {doc}\n *\n * Ground is `{ground}`.\n */\n"
            f"export const {name} = {{\n{body}\n}} as const\n"
        )

    def table(values):
        rows = []
        for theme, per_token in values.items():
            inner = ",\n".join(f"    '{k}': {v}" for k, v in per_token.items())
            rows.append(f"  {theme}: {{\n{inner},\n  }}")
        return ",\n".join(rows)

    ratio_block = table({
        "light": {k: m["on_ground"] for k, m in light.items()},
        "dark": {k: m["on_ground"] for k, m in dark.items()},
    })
    worst_block = table({
        "light": {k: m["worst"] for k, m in light.items()},
        "dark": {k: m["worst"] for k, m in dark.items()},
    })
    minimum_block = table({
        "light": {k: ("null" if m["min"] is None else m["min"]) for k, m in light.items()},
        "dark": {k: ("null" if m["min"] is None else m["min"]) for k, m in dark.items()},
    })
    # Names, not hexes: a test needs to index the palette by token, and in light mode `surface` and
    # `surface-raised` are the same white, so a list of hexes loses one of them.
    surface_names = [n for n in LIGHT_SURFACES if n not in NON_TEXT_SURFACES]
    text_surface_block = "[" + ", ".join(f"'{n}'" for n in surface_names) + "]"
    non_text_block = "[" + ", ".join(f"'{n}'" for n in NON_TEXT_SURFACES) + "]"

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
        + "\n/**\n"
        " * Measured contrast against the WORST surface text is allowed on — the number each token is held\n"
        " * to.\n"
        " *\n"
        " * `PALETTE_RATIOS` above is the ratio against the page background, which is the one docs/08 has\n"
        " * always printed and the one that reads highest. It is not the one that has to hold: a token is\n"
        " * legible on a card or it is not, and dark-mode `danger` once measured 4.53:1 on the ground and\n"
        " * 3.69:1 on `--color-surface-raised` while the palette gate reported PASS. `surface-clay` is\n"
        " * excluded, because docs/08 section 3 gives it as 'large shapes, never text'.\n"
        " */\n"
        f"export const PALETTE_WORST_SURFACE_RATIOS = {{\n{worst_block},\n}} as const\n"
        + "\n/**\n"
        " * The ratio each token must meet, or `null` for a surface or decoration that states none.\n"
        " *\n"
        " * Emitted rather than restated in TypeScript so a test can recompute every pairing from the hexes\n"
        " * with its own implementation of the WCAG formula and check the answer against the threshold the\n"
        " * derivation actually used. Two implementations agreeing is worth more than one asserting.\n"
        " */\n"
        f"export const PALETTE_MINIMUMS = {{\n{minimum_block},\n}} as const\n"
        + "\n/**\n"
        " * The surface tokens text is allowed to sit on, and the ones it is not.\n"
        " *\n"
        " * `surface-clay` is excluded by docs/08 section 3 — \"large shapes, **never text**\". The exclusion\n"
        " * is load-bearing: several tokens would miss their threshold on clay, and darkening them to serve a\n"
        " * pairing the design system forbids would flatten the palette for nothing.\n"
        " */\n"
        f"export const TEXT_SURFACE_TOKENS = {text_surface_block} as const\n"
        f"\nexport const NON_TEXT_SURFACE_TOKENS = {non_text_block} as const\n"
    )


def check_doc_tables(light, dark):
    """Assert docs/08 states the hex and BOTH ratios this script produces.

    Both, because the table is the document a designer reads before picking a colour, and a table stating
    only the ground ratio advertises headroom that does not exist — `accent-gold` reads 5.29:1 on the page
    and 4.58:1 on a sand section, and the second number is the one the 4.5 threshold is about.

    Fields are read positionally rather than by one big alternating regex. The previous regex had two
    alternatives for "with a ratio" and "with an em dash", and adding a column to it would have meant four.
    """
    if not DESIGN_DOC.exists():
        return [f"{DESIGN_DOC} is missing"]
    text = DESIGN_DOC.read_text(encoding="utf-8")
    problems = []
    token_cell = re.compile(r"^`--([a-z0-9-]+)`$")
    hex_cell = re.compile(r"^`(#[0-9A-Fa-f]{6})`$")
    ratio_cell = re.compile(r"^\*{0,2}([0-9.]+):1\*{0,2}$")

    def stated_ratio(cell, theme, token, column):
        """The number in a ratio cell, or None for an em dash. A malformed cell is a problem, not a skip."""
        if cell == "\u2014":
            return None
        m = ratio_cell.match(cell)
        if m is None:
            problems.append(f"docs/08 {theme} `--{token}` {column} cell is not a ratio or an em dash: {cell!r}")
            return None
        return float(m.group(1))

    section = None
    seen = {"light": set(), "dark": set()}
    for line in text.split("\n"):
        if line.startswith("### Light"):
            section = "light"
        elif line.startswith("### Dark"):
            section = "dark"
        elif line.startswith("## ") and section is not None:
            section = None
        if section is None or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 4:
            continue
        name = token_cell.match(cells[0])
        if name is None:
            continue
        token = name.group(1)
        hex_match = hex_cell.match(cells[1])
        if hex_match is None:
            problems.append(f"docs/08 {section} `--{token}` has no hex in its second column: {cells[1]!r}")
            continue
        tokens = light if section == "light" else dark
        if token not in tokens:
            problems.append(f"docs/08 {section} lists `--{token}`, which the script does not produce")
            continue
        seen[section].add(token)
        actual = tokens[token]
        if hex_match.group(1).upper() != actual["hex"].upper():
            problems.append(
                f"docs/08 {section} `--{token}` states {hex_match.group(1).upper()}, "
                f"script produces {actual['hex']}"
            )
        for column, cell, measured in (
            ("on-ground", cells[2], actual["on_ground"]),
            ("worst-surface", cells[3], actual["worst"]),
        ):
            value = stated_ratio(cell, section, token, column)
            if value is not None and abs(value - measured) > 0.011:
                problems.append(
                    f"docs/08 {section} `--{token}` states {value}:1 {column}, script measures {measured}:1"
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

    failures = report("LIGHT", LIGHT, LIGHT_GROUND, LIGHT_SURFACES) + report(
        "DARK", DARK, DARK_GROUND, DARK_SURFACES
    )

    print(f"\n{'='*74}\nFILL PAIRS\n{'='*74}")
    for label, fill_fn, on in FILL_PAIRS:
        fill = fill_fn()
        r = ratio(fill, on)
        ok = r >= 4.5
        failures += 0 if ok else 1
        print(f"{label:<34}{fill} on {on}  {r:>6.2f}:1  {'PASS' if ok else 'FAIL'}")

    light = resolved(LIGHT, LIGHT_GROUND, LIGHT_SURFACES)
    dark = resolved(DARK, DARK_GROUND, DARK_SURFACES)
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

    print(f"\n{'='*74}\nTHEME PARITY\n{'='*74}")
    missing = sorted(set(light) - set(dark))
    extra = sorted(set(dark) - set(light))
    if missing or extra:
        for token in missing:
            print(f"FAIL  --color-{token} exists in light and not in dark, so it keeps its LIGHT value")
        for token in extra:
            print(f"FAIL  --color-{token} exists in dark and not in light, so it is undefined in light")
        failures += len(missing) + len(extra)
    else:
        print(f"PASS  both themes define the same {len(light)} tokens")

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
