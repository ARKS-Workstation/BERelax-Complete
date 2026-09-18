#!/usr/bin/env python3
"""Derive and validate the BeRelax palette, evolved from the Netlify prototype.
Prints a table of every token with its measured contrast ratio. Run in CI as a gate."""
import colorsys

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

f = report("LIGHT", LIGHT, LIGHT_GROUND) + report("DARK", DARK, DARK_GROUND)
# accent fills must also pass against their own on-fill text
print(f"\n{'='*74}\nFILL PAIRS\n{'='*74}")
for label, fill, on in [
    ("gold fill / cream text", LIGHT["accent-gold"][0], "#FDFAF5"),
    ("green fill / cream text", LIGHT["accent-green"][0], "#FDFAF5"),
    ("dark-mode gold fill / dark text", DARK["accent-gold"][0], "#141210"),
]:
    r = ratio(fill, on)
    ok = r >= 4.5; f += 0 if ok else 1
    print(f"{label:<34}{fill} on {on}  {r:>6.2f}:1  {'PASS' if ok else 'FAIL'}")
print(f"\n{'ALL PASS' if f==0 else str(f)+' FAILURES'}")
raise SystemExit(1 if f else 0)
