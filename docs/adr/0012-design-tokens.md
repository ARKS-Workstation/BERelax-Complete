# ADR 0012 — the palette is derived, not chosen, and generated artifacts are committed

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** F11

## The failure this prevents

A design system's contrast ratios are true on the day they are measured. Then someone nudges a hex
because it looked a little flat on their monitor, and the system still *claims* 4.62:1 while shipping
3.8:1. Nothing catches it, because nothing ever measured it again.

So the palette is not a list of chosen colours. **It is a derivation**: `scripts/palette.py` takes the
prototype's colours and walks each one along its own hue and saturation until it meets a stated
ratio, then re-measures every result. The hexes in `docs/08` and in
`packages/ui/src/tokens/palette.generated.ts` are its output. Editing either by hand fails CI.

Contrast is computed on sRGB relative luminance because that is how WCAG 2.2 defines it — a palette
validated in a perceptual space and shipped to a browser that judges it in sRGB would be validated
against the wrong thing.

## Decision 1 — HLS derivation, OKLCH interaction states

Derivation walks HLS lightness, which holds the hue angle constant by construction. The obvious
alternative is to author tokens in OKLCH, whose lightness is perceptually uniform.

Rejected, for one reason: it would mean two representations of every colour — the OKLCH the token is
authored in and the sRGB hex that WCAG is measured on, and an email client or a PDF needs the hex.
Two representations drift. The gate exists to stop exactly that.

What OKLCH is genuinely better at — an even hover or pressed state — is available without a second
representation, because `color-mix(in oklab, var(--color-accent-gold) 88%, black)` mixes
perceptually from whatever the token already is. One source of truth, and the perceptual benefit
where it matters.

## Decision 2 — generated files are committed

Three artifacts are generated and committed: the token module, `tokens.css`, and the Tailwind theme.
Committing build output is usually wrong. Here it buys two things worth more than the tidiness:

- **A colour change shows up in a diff.** A reviewer sees `--color-ink-3` move from `#90877B` to
  `#948A7D` without running a build to find out what happened.
- **The PDF renderer and the web read the same bytes.** `@berelax/pdf` inlines `tokensCss()` into
  every invoice. Without one committed source, an invoice would be a slightly different grey from the
  page that produced it, and nobody could say which was right.

The cost is staleness, which is what `pnpm tokens` is for: it fails if either file differs from what
the emitter would write today. It has already earned its place — Biome reformatted the generated
module and the gate caught it on the next run.

## Decision 3 — three lint rules the design document cannot enforce

`pnpm colours` scans every CSS and TypeScript source outside the token layer.

**No un-tokened colour.** A hand-typed hex is a colour nobody derived and nobody measured. The
palette's value is that every shade meets a stated ratio; one raw hex in a component and that is a
claim rather than a fact.

**The brand gold never carries text.** `#C08A43` measures **2.90:1** against the light ground. It
fails the 4.5:1 body threshold *and* the 3:1 threshold for user-interface components, so it cannot be
a text colour, a meaningful icon, or a border that conveys state. It stays as `--color-decor-gold`
because it is the brand, and the darkened `--color-accent-gold` at 4.62:1 is what text uses — still
recognisably gold. The classification lives in `packages/ui/src/tokens/palette.ts`, where a unit test
asserts it is total: every token is exactly one of text-bearing or decorative.

Note the inversion, which is the reason theme-aware tokens are worth the trouble: **the same
`#C08A43` reaches 6.19:1 on the dark ground and is the primary accent there.** Accent polarity flips
with the theme; a single "brand gold" constant could not.

**No Tailwind default palette.** `tailwind.css` clears the defaults with `--color-*: initial`, which
removes the entire namespace rather than discouraging it. The lint rule is the belt to that
suspenders: a stale build or a copied snippet can still carry a default utility class, and catching
the class name is cheaper than discovering it rendered grey.

## Decision 4 — the document is gated against the code

`docs/08` says its palette tables are the script's output, not aspiration. `scripts/palette.py` now
proves it: it parses the tables and fails if any hex or ratio differs, or if a token is missing. On
its first run it found the dark table had silently omitted `--hairline` and `--border`.

This is the same discipline as schema drift. A document that describes the system is only useful
while it is true, and the way to keep it true is to fail the build when it is not.

## What this does not decide

Components. `packages/ui` is tokens only until `W-SYS`. The type scale, motion curves and grid are
published as tokens here; which components consume them, and how, is that unit's problem.

The body typeface remains open (`Y12-body-face`): Jost is retained for marketing display, and the
build proceeds with a workhorse sans for body and admin because it is the safer default for a booking
flow and a till screen. Generated documents already use IBM Plex Sans, which pairs with the Arabic
face by construction — see [ADR 0011](0011-documents-render-in-chromium.md).
