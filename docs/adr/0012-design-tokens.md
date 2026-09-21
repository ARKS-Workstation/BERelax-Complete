# ADR 0012 — the palette is derived, not chosen, and generated artifacts are committed

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** F11
- **Covers:** docs/01 decisions 30, 31

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

- **A colour change shows up in a diff.** A reviewer saw `--color-ink-3` move from `#90877B` to
  `#857D71` when decision 5 below changed what the derivation measures against — nine tokens moved in that
  one commit, and the diff said so without anybody running a build to find out what happened.
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
because it is the brand, and the darkened `--color-accent-gold` — `#89612E`, 4.58:1 on the darkest surface
text may sit on — is what text uses, still recognisably gold. The classification lives in `packages/ui/src/tokens/palette.ts`, where a unit test
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

## Decision 5 — every ratio is measured against the worst surface text may sit on

Amended 2026-09-21, after the original derivation was found to be measuring the wrong thing.

Decisions 1 to 4 keep the palette's *claims* true. This one is about the claim itself being the right claim.
Every token was derived and re-measured against `--color-ground` alone — and the ground is the lightest
thing a dark foreground sits on in light mode, and the darkest thing a light foreground sits on in dark
mode. So the ground ratio is the flattering one, always, and it is not the ratio that has to hold.

Measured across the real matrix of text tokens against surfaces:

| Token | On the ground | On `--color-surface-raised` | Required |
|---|---|---|---|
| dark `--color-danger` | 4.53:1 | **3.69:1** | 4.5:1 |
| dark `--color-success` | 4.63:1 | **3.77:1** | 4.5:1 |
| dark `--color-accent-green` | 4.63:1 | **3.77:1** | 4.5:1 |
| dark `--color-accent-teal` | 4.64:1 | **3.78:1** | 4.5:1 |

and in light mode `--color-accent-gold` fell to 4.00:1 on `--color-surface-sand`, with
`--color-border-strong` at 2.63:1 against its 3:1 floor. `pnpm palette` printed PASS for all of it, and
F11's acceptance line — "every text pair meets its stated ratio in both themes" — was not what was being
checked. There was never a *pair* in the check at all.

Latent rather than live: `pnpm a11y` runs axe against real pages and passed, because no page had yet put one
of those tokens on a raised surface. The next unit to do it would have shipped the defect, and the palette
gate would have gone on reporting PASS.

So `derive_all` walks until the target is met against **every** surface text is allowed on, and the report's
PASS/FAIL column is the worst of them. Nine hexes moved, all by small steps along their own hue — the
palette did not need redesigning, it needed measuring against the right thing.

Two consequences worth stating, because both are places this could have gone wrong:

**`--color-surface-clay` is excluded.** Its own row in docs/08 §3 reads "large shapes, **never text**", so
including it would darken half the palette to serve a pairing the design system forbids. The exclusion is
not a convenience: `packages/ui/src/tokens/contrast.test.ts` asserts that something *would* fail on clay, so
an exclusion that stopped doing any work would be deleted rather than explained.

**`--color-border-strong` and `--color-focus` are not text and take the same worst case anyway**, at their
own 3:1 target. WCAG 2.2 1.4.11 measures non-text contrast against the *adjacent* colour, and for a
control's edge or its focus ring that is whatever surface the control sits on. A focus ring visible on the
page and invisible on a card is the same defect as illegible body text, and considerably harder to notice.

What this does *not* fix: `--color-hairline` and `--color-border` state no minimum, so nothing derives them
against anything stricter. In dark mode `--color-hairline` measures 1.01:1 against `--color-surface-raised`
— a rule that does not render. Darkening a separator no rule asks to be darker is a design decision rather
than a correctness fix, so it is recorded as `Y12-separator` in docs/OPEN-QUESTIONS.md, and the shortfall is
printed by `pnpm palette` for every token, separators included, rather than hidden.

The check is doubled on purpose. `scripts/palette.py` measures in Python; `contrast.test.ts` recomputes the
whole matrix in TypeScript from the emitted hexes with its own implementation of the WCAG formula. One
implementation asserting is how this survived as long as it did; two agreeing is the check.

## What this does not decide

Components. `packages/ui` is tokens only until `W-SYS`. The type scale, motion curves and grid are
published as tokens here; which components consume them, and how, is that unit's problem.

The body typeface remains open (`Y12-body-face`): Jost is retained for marketing display, and the
build proceeds with a workhorse sans for body and admin because it is the safer default for a booking
flow and a till screen. Generated documents already use IBM Plex Sans, which pairs with the Arabic
face by construction — see [ADR 0011](0011-documents-render-in-chromium.md).
