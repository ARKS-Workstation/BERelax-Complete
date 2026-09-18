# Frontend Design System

The implementable design language: palette, type, space, motion, media and the performance budget
that keeps it honest. Requirements are in
[07-frontend-and-agents-requirements.md](07-frontend-and-agents-requirements.md).

---

## 1. Scandinavian minimalism as constraints

Not a mood. A set of rules that can be checked in review.

**Do:** negative space as the primary compositional tool · natural light in all photography ·
functionalism — nothing decorative that is not also useful · muted, low-chroma palettes · one
repeated asymmetric grid rather than many layouts · craft in small details (optical alignment,
hairlines, considered focus rings) · honest materials — linen, stone, water, wood, skin.

**Do not:** gradients as decoration · drop shadows faking depth (exactly **one** shadow token exists,
for overlays) · stock-photo gloss · carousels · parallax · more than two Latin typefaces ·
centre-aligned body text · icon-only buttons without labels · full-bleed everything.

The discipline that makes it work: **contrast comes from ink and photography, not from colour.**

---

## 2. Palette — the pastel problem, solved

Pastels are light and low-chroma, so pastel-on-pastel text fails WCAG 2.2 AA (4.5:1 body, 3:1 large
text and UI). The rule, stated once and enforced:

> **Pastels carry surfaces and large shapes. Ink and accents carry text. A pastel is never
> load-bearing for text.**

### Light

| Token | OKLCH | Hex | Contrast on `--ground` |
|---|---|---|---|
| `--ground` | `oklch(98.4% 0.006 85)` | `#FCF9F5` | — |
| `--surface` | `oklch(100% 0 0)` | `#FFFFFF` | — |
| `--ground-sunk` | `oklch(96.8% 0.008 85)` | `#F7F4EE` | — |
| `--ink` | `oklch(24% 0.014 240)` | `#192025` | **15.68:1** |
| `--ink-2` | `oklch(44% 0.013 240)` | `#4C5459` | **7.40:1** |
| `--ink-3` | `oklch(54.5% 0.012 240)` | `#6A7177` | **4.72:1** |
| `--surface-sage` | `oklch(93% 0.023 152)` | `#DDEDE0` | surface only |
| `--surface-clay` | `oklch(93.5% 0.026 42)` | `#FAE4DC` | surface only |
| `--surface-ochre` | `oklch(94.5% 0.030 88)` | `#F5ECD7` | surface only |
| `--pastel-sage` | `oklch(86.5% 0.040 152)` | `#C0DBC6` | chips only |
| `--pastel-clay` | `oklch(88% 0.044 42)` | `#F2CFC1` | chips only |
| `--pastel-ochre` | `oklch(90% 0.050 88)` | `#ECDDB9` | chips only |
| `--accent-sage` | `oklch(43% 0.056 155)` | `#365942` | **7.53:1** |
| `--accent-clay` | `oklch(47% 0.090 38)` | `#854734` | **6.78:1** |
| `--hairline` | `oklch(90.5% 0.008 85)` | `#E2DFDA` | 1.27:1 — decorative only |
| `--border` | `oklch(84.5% 0.010 85)` | `#CFCCC5` | 1.53:1 |
| `--border-strong` | `oklch(65.5% 0.012 85)` | `#949089` | 3.03:1 — UI boundaries |
| `--focus` | `oklch(52% 0.130 250)` | `#1F6CB0` | — |
| `--danger` | `oklch(45% 0.150 25)` | `#972527` | **7.68:1** |
| `--success` | `oklch(43% 0.090 150)` | `#255D34` | **7.42:1** |

Note `--ink` is a near-black with a slight cool cast, never `#000`.

### Dark — warm, not inverted

Pastels are **re-derived** at lower lightness and higher relative chroma, not dimmed.

| Token | Hex | Contrast |
|---|---|---|
| `--ground` | `#1A1612` | — |
| `--ground-sunk` | `#13100C` | — |
| `--surface` | `#24201A` | — |
| `--surface-raised` | `#2D2822` | — |
| `--ink` | `#EFECE7` | **15.26:1** |
| `--ink-2` | `#B9B5AF` | **8.80:1** |
| `--ink-3` | `#8F8C85` | **5.33:1** |
| `--pastel-sage` | `#A5D1B3` | — |
| `--pastel-clay` | `#EDBAA5` | — |
| `--accent-text` | `#A0CAAD` | **9.83:1** |
| `--hairline` / `--border` | `#332E29` / `#453F39` | — |

**Accent polarity flips.** Light: `--accent-fill: #365942`, `--accent-on-fill: #FCF9F5` (7.53:1).
Dark: `--accent-fill: #A5D1B3`, `--accent-on-fill: #1A1612` (10.52:1).

**Shadow.** Exactly one token, overlays only:
`--shadow-overlay: 0 1px 2px oklch(24% 0.014 240 / .04), 0 12px 32px -8px oklch(24% 0.014 240 / .10)`.
None in dark mode — elevation there is surface lightness.

A **hex mirror** of every semantic token is generated and committed, so designers, email templates and
PDF generation share one source of truth.

---

## 3. Typography

| Role | Face | Notes |
|---|---|---|
| UI / body | **Schibsted Grotesk** (variable) | Nordic provenance, humanist grotesque |
| Display | **Newsreader** (variable, `opsz` 6–72) | Editorial serif for headlines only |
| Arabic | **IBM Plex Sans Arabic** (400/500/600) | Static weights |

**Scale.** eyebrow `0.75rem/1.33/+0.08em` uppercase · xs `0.75/1.4` · sm `0.875/1.5` ·
**base `1.0625rem` (17px) / `1.647` (28px)** · lg `1.25/1.6` · xl `1.5/1.333/−0.008em` ·
2xl `1.875/1.267/−0.012em` · 3xl `clamp(2rem, 1.4rem + 2.2vw, 2.5rem)/1.15/−0.016em`.

**Measure.** body 68ch · lede 56ch · h3 40ch · h2 34ch · h1 26ch · display 18ch · hard max 76ch.

**Arabic adjustments** — not a font swap, a typographic recalibration:

```css
:lang(ar) {
  --font-size-scalar: 1.06;
  line-height: 1.85;                /* headings: 1.3 minimum */
  letter-spacing: 0 !important;     /* never track Arabic */
  text-transform: none;             /* no uppercase */
  font-weight: 500;                 /* where Latin uses 400 */
}
```

**Loading.** `next/font/local`, woff2 only, variable roman files, `latin`+`latin-ext` subset on English
routes, **preload exactly two files**, `font-display: swap`, and metric-matched fallbacks
(`size-adjust`, `ascent-override`, `descent-override`) — without these a 96px display swap alone costs
0.05–0.15 CLS. Budget ≤120KB Latin, ≤100KB Arabic, and **Arabic is never served on English pages**.
*(Individual file sizes UNVERIFIED — measure at build.)*

---

## 4. Space, radius, layout

**Spacing (8px base):** `1, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128, 160, 192`.

**Radius:** `--radius-1: 2px` (images, cards, inputs, chips) · `--radius-2: 8px` (buttons, selects) ·
`--radius-3: 16px` (dialog, bottom sheet) · `--radius-handle: 999px` (sheet handle only).

**Breakpoints:** 360 floor · 480 · 768 · 1024 · 1280 · 1600. Gutters 20/24/40/64/80px. Container 1360px.

**The editorial grid** — one asymmetry, repeated everywhere rather than many bespoke layouts:

```css
grid-template-columns:
  [full-start] minmax(var(--gutter), 1fr)
  [wide-start] minmax(0, 12rem)
  [measure-start] min(68ch, 100% - var(--gutter) * 2) [measure-end]
  minmax(0, 20rem) [wide-end]
  minmax(var(--gutter), 1fr) [full-end];
```

**Container queries** rather than page breakpoints for reusable pieces: `TherapistCard` at 260/340/420px,
`ServiceRow`, `SlotGrid` (3/4/6 columns by container width).

**Touch targets:** 40px desktop, **48px mobile**, 8px minimum gap. Slot buttons 48×44.
**Focus:** `outline: 2px solid var(--color-focus); outline-offset: 2px`, with each section setting
`--ring-offset` to its own background.

---

## 5. Motion — a system, not a collection of effects

**Durations.** `--dur-instant 90ms` (press, checkbox, ring) · `--dur-fast 140ms` (hover, colour) ·
`--dur-base 200ms` (tooltip, toast, chevron, number cross-fade) · `--dur-slow 320ms` (accordion, sheet,
dialog, page) · `--dur-reveal 500ms` (below-fold media).

**Easings.** `--ease-out-quiet cubic-bezier(.22,1,.36,1)` entrances ·
`--ease-out-soft cubic-bezier(.16,1,.30,1)` large reveals and sheets ·
`--ease-in-quick cubic-bezier(.40,0,1,1)` exits · `--ease-calm cubic-bezier(.45,0,.55,1)` A→B movement.
Linear is used for opacity only.

**Distance–duration rule.** `duration = clamp(120ms, 120ms + 0.6 × distance_px, 480ms)`.
8px→125ms · 100px→180ms · 400px→360ms · a 900px sheet→480ms.

**Stagger.** 40ms for ≤6 siblings · 24ms for 7–12 · **total capped at 240ms** · above 12 items animate
the container once, never the children. **No stagger above the fold.**

**Springs.** Direct manipulation (sheet drag, admin scheduler drag): stiffness 220, damping 26, mass 1.
Success checkmark only: stiffness 400, damping 22.

**Reduced motion** as a token override, not a per-component branch:

```css
@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion="full"]) {
    --dur-instant: 1ms; --dur-fast: 1ms; --dur-base: 120ms;
    --dur-slow: 120ms; --dur-reveal: 120ms; --dur-ambient: 0s;
    --move-sm: 0px; --move-md: 0px; --move-lg: 0px; --stagger: 0ms;
  }
}
```

Movement becomes zero; opacity cross-fades survive. One change, whole system compliant.

**RTL** via a direction multiplier so no animation is authored twice:

```css
:root { --dir: 1 }  [dir="rtl"] { --dir: -1 }
transform: translateX(calc(var(--move-lg) * var(--dir)));
```

### Microinteraction catalogue

Each must **communicate** something. Motion that communicates nothing is decoration and is cut.

| Interaction | Spec | Communicates |
|---|---|---|
| Therapist card hover | image `scale(1.03)` 200ms `--ease-calm`, name underline wipe 140ms | this is explorable |
| Slot selection | press `scale(.97)` 90ms **CSS**, then shared-element exchange | your choice registered |
| Field focus | ring 90ms, label rise 140ms | where you are |
| Validation | error slides 8px + fades 200ms, **on blur not keystroke** | what to fix, without nagging |
| Below-fold reveal | opacity + 16px rise, 500ms `--ease-out-soft`, once | content arriving |
| Header condensation | height + blur on `animation-timeline: scroll()` | you have moved |
| Accordion | height 320ms, chevron 200ms | disclosure |
| Booking success | checkmark spring, single use | it worked |

**Above the fold, entrance animations are banned.** An element at `opacity: 0` is not painted, so a
200ms delay plus a 500ms fade on the hero H1 costs ~0.7s of LCP. The ban costs nothing, because nobody
misses an animation they never saw.

---

## 6. Media — the hero

### The technique that makes a video hero free

The LCP element is **a real `<img>`** with `fetchPriority="high"` and `decoding="sync"` inside
`<picture>` — **not** the video's `poster` attribute, which is left unset.

The `<video>` ships with `preload="none"`, `muted loop playsinline` and **no `src`**. A ~1.4KB island
attaches the source after `requestIdleCallback` (timeout 2500) or `load + 400ms`, then cross-fades on
the `playing` event (opacity 0→1, 320ms).

**Cost: ~0ms LCP.** Done the obvious way — video as LCP candidate — expect **+0.3–0.9s LCP** on
mid-tier 4G, which no amount of caching fixes. This is the whole trick, and it is why the video hero is
affordable.

Art-directed preload, two links, one per breakpoint:

```html
<link rel="preload" as="image" media="(max-width:767px)" fetchpriority="high"
      type="image/avif" imagesrcset="…414w, …828w, …1080w" imagesizes="100vw">
```

### Encoding

**Two renditions per crop: H.264 High (universal) + HEVC `hvc1` (Safari). Skip VP9/WebM entirely.**

- H.264: `-profile:v high -level 4.0 -preset veryslow -crf 26` desktop, `-crf 28 -level 3.1` mobile
- HEVC: `-tag:v hvc1` — mandatory or Safari ignores it
- AV1 (P2): `-c:v libsvtav1 -preset 4 -crf 36 -svtav1-params "tune=0:film-grain=0"`
- **`-movflags +faststart` on every MP4**
- Seamless loop without a reshoot: `[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[out]`

Progressive MP4 with Range requests. **No HLS, no hls.js** for a hero loop.

### Images

- Ladder: `[414, 640, 828, 1080]` mobile 4:5 · `[1024, 1440, 1920, 2560]` desktop 16:9
- `sharp` AVIF `{ quality: 52, effort: 4, chromaSubsampling: '4:2:0' }`; WebP `{ quality: 76 }`;
  JPEG `{ quality: 80, mozjpeg: true }`
- **Colour management, critical for pastels:**
  `.pipelineColourspace('rgb16').toColourspace('srgb').withMetadata({ icc: 'srgb' })`
- Placeholder: dominant colour from `sharp().stats()`, converted to OKLCH and clamped to chroma ≤0.06,
  lightness 0.86–0.94. No blurhash — a flat calm colour suits this aesthetic better and costs nothing.
- **Genuine art direction** via `<picture>` `<source media>`, not CSS cropping. A landscape hero
  CSS-cropped to a phone looks bad; it also wastes ~40% of the pixels.

### Storage and delivery

Two buckets: **`berelax-private`** (originals, video masters, signed consent PDFs — no CDN, no public
read) and **`berelax-media`** (derivatives only, public read, CDN).

URLs are content-addressed and immutable:
`/m/{mediaId}/{first16OfSha256}/{slot}-{width}.{ext}` with `Cache-Control: public, max-age=31536000, immutable`.
Served **same-origin** via a Cloudflare rule to the Spaces origin — never expose
`*.cdn.digitaloceanspaces.com`. Same-origin media is what keeps requests-to-LCP low.

DO Spaces has **no built-in image transformation**, so: MVP builds derivatives with `sharp` in a pg-boss
job plus a custom `next/image` loader mapping width → nearest named size. P2 option is Cloudflare Images
remote-origin transforms (~$0.50/1,000, first 5,000/month free). Spaces base $5/month covers 250GiB and
1TiB transfer.

Video hosting: **self-host progressive MP4 on Spaces** at MVP ($0 marginal). Cloudflare Stream (~$6/month
at this volume) only if long-form video appears later.

### Editable media without ruined pages

Named **slots** — hero, therapist portrait, service card, gallery, testimonial background — each
declaring aspect ratio, minimum dimensions, maximum file size and **required alt text**. Payload's native
focal point (appears only when `imageSizes`/`resizeOptions` are defined; crop applies before resize;
store `focalX`/`focalY` as percentages).

Alt-text junk filter: minimum 15 characters, and reject
`/^(image|photo|picture|img|hero|banner|untitled|dsc[_-]?\d+|img[_-]?\d+)/i`.

A **breakpoint preview** shows the editor the real crop at real widths before publishing. It is roughly
a week of engineering that produces no user-visible feature and prevents most bad publishes.

### Autoplay, slow connections and WCAG

- Slow-connection gate that works cross-browser (not just Chrome's `saveData`):
  `PerformanceResourceTiming` → `(transferSize * 8) / duration < 600 kbit/s` → serve the still.
- `v.play().catch()` → `NotAllowedError` → stay on the still, reveal tap-to-play. **Plus** a `pause`
  listener, because iOS Low Power Mode can be enabled mid-session.
- **WCAG 2.2.2 pause control**: 44×44px target, always visible, bottom inline-end,
  `rgb(255 255 255 / .72)` with `backdrop-filter: blur(8px)`, choice persisted to `localStorage` as
  `berelax:motion`.
- Never autoplay with sound. Ever.

### Photography brief (hand this to the photographer)

Natural light only. **Real therapists, never stock.** Hands and detail over faces where privacy
matters. Texture: linen, stone, water, wood. Negative space reserved for text overlay. Grade to the
palette: deepest in-frame value `#3A3B37` — **never `#000`** — highlights toward `#FBF7F2`, greens
desaturated 10–15%, highlights warmed ~+150K. Scrim for legibility:

```css
linear-gradient(to top,
  rgb(58 59 55 / var(--scrim)) 0%,
  rgb(58 59 55 / calc(var(--scrim) * .55)) 38%,
  transparent 72%)
```

Shot list: hero loop, room interiors, three therapist portrait styles, treatment detail, product still
life, exterior and arrival. **Model releases and staff photography consent are a requirement**, not a
footnote — and they connect to therapist-page archival when someone leaves.

---

## 7. Component stack

Tailwind **v4** with CSS-first tokens, shadcn/ui components **copied into `packages/ui`**, Radix
primitives, `tw-animate-css` with our motion tokens overriding its defaults.

Delete Tailwind's default palette so no un-tokened colour can be used by accident:

```css
@theme inline { --color-*: initial; /* then one mapping per semantic token */ }
```

Dark mode: `@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *))`, plus a
`@media (prefers-color-scheme: dark)` block guarded by `:root:not([data-theme="light"])`.

**Not looking like every other shadcn site** is a stated requirement, and these are what achieve it:
17px base type on a 28px rhythm (not 16/24), a 2px corner radius (not 8), one shadow token instead of
five, the editorial grid, Newsreader display type, and real photography. Default shadcn geometry is
replaced, not themed.

Motion library: `motion` (ex-framer-motion) v12, **≤2 code-split islands, never in the shared layout** —
roughly 32–36KB gzip each *(UNVERIFIED)* plus 5–30ms INP on first interaction. Everything else is CSS,
which costs ~0ms. Scroll effects use `animation-timeline: scroll()`/`view()` — compositor-driven, with an
IntersectionObserver fallback that toggles a class once and disconnects. **Exactly two** scroll-driven
effects exist: header condensation and below-fold reveal.

Icons: Lucide behind a wrapped `<Icon>` export at `strokeWidth 1.5`, 20px UI / 24px nav, plus ~12
commissioned service pictograms on a 24px grid at 1.25px stroke.

RTL requires `<DirectionProvider dir={locale === 'ar' ? 'rtl' : 'ltr'}>` around the Radix tree. Every
number, price, time range, phone and Latin brand name is wrapped in `<bdi>` or `dir="ltr"`, and all
formatting goes through `Intl.NumberFormat('ar-AE-u-nu-latn')` / `DateTimeFormat`.

---

## 8. Performance budget

p75, field data, mid-tier Android — set tighter than Google's "good" thresholds so content growth does
not push the site into "needs improvement".

| Metric | Target | Google "good" |
|---|---|---|
| LCP | **≤2.0s** | 2.5s |
| INP | **≤150ms** | 200ms |
| CLS | **≤0.05** | 0.1 |
| TTFB (cached ISR) | ≤600ms | — |

| Budget | Mobile | Desktop |
|---|---|---|
| Critical above-fold | ≤250KB | ≤340KB |
| Hero poster (AVIF, widest rung) | ≤95KB | ≤170KB |
| Hero video (deferred, gated) | ≤350KB | ≤1.2MB — hard stop 2MB |
| First-party JS, home route | ≤110KB gzip | — |
| CSS | ≤25KB gzip (expect 14–18KB) | — |
| Full page, all media | ≤1.9MB | ≤3.2MB |
| Requests before LCP | ≤8 | ≤10 |
| DOM nodes | ≤1500 | — |

### The honest cost of each aesthetic choice

- **Video hero:** 350KB–1.2MB of deferred weight and 60–120ms main-thread work at attach. **0ms LCP**,
  because it has no `src` until LCP is final.
- **Pastel photography is a performance asset.** Soft, low-contrast, low-detail images hit the ≤95KB
  AVIF budget where a high-detail image needs 140–180KB for equal perceptual quality. The aesthetic
  *saves* 40–80KB. Worth saying out loud.
- **Pastel flats** are the exception: low-variance areas band, needing ~15–30% more weight. Render flats
  as CSS/SVG (0 bytes) and reserve raster for photography.
- **`backdrop-filter` blur** in the condensed header is the most expensive paint on the site and
  measurably hurts scroll smoothness on mid-tier Android — a large share of UAE traffic. 8px maximum,
  dropped under `prefers-reduced-transparency`, and replaceable with an opaque fill.
- **Art direction** costs an extra shoot setup and derivative ladder, and saves ~40% of mobile hero
  pixels. It pays for itself.
- **Not optional, must be budgeted:** AVIF encode CPU in the worker (2–8s per large image), ffmpeg in
  the worker image (non-trivial size), and the breakpoint preview component.

### Cut order when a page exceeds budget

1. Drop the desktop AV1 rendition.
2. Shorten the loop 6s → 4s, ping-pong it.
3. **Drop video on mobile, serve the still.** Mobile is where the budget bites and the still is ~90% as good.
4. Gallery 12 → 6 images with fetch-on-demand.
5. Drop the second webfont weight (~22–30KB).
6. **Drop video everywhere**; animate the poster with a 24s `scale(1.0 → 1.06)`. Zero network bytes,
   reduced-motion-safe, genuinely beautiful on a calm site. Presented as an intentional design option,
   not an apology, so it is available without a negotiation.
7. **Last:** poster quality q52 → q45. Visible on skin gradients and pale walls — exactly where this
   brand lives. Most teams do this first. Do it last.

### Enforcement, three independent layers

1. **Field** — `web-vitals` v4 attribution build reporting LCP element identity, CLS sources and INP
   target to an internal endpoint, segmented by route, breakpoint, locale and whether the video
   attached. The Arabic and English sites will have different numbers because they ship different fonts.
2. **CI** — Lighthouse CI with `budget.json` that **fails the build** on home, service, therapist and
   gallery routes, in both themes and both directions.
3. **Publish** — a synthetic weight check inside the existing draft → lint → approval → publication
   record plane, so an editor's oversized photo fails *before* publication rather than a week later in
   CrUX.

Any of the three failing is a red build, not a ticket.

---

## 9. What is exposed to settings

Per the bounded model in [07](07-frontend-and-agents-requirements.md) §2.

| Setting | Constraint |
|---|---|
| Accent | Enum of 3 curated pairings (sage / clay / ochre), each pre-validated AA in both themes |
| Density | Enum: comfortable · compact |
| Radius | Enum: sharp (2px) · soft (8px) |
| Theme default | Enum: system · light · dark |
| Logo | Upload, SVG preferred, max dimensions enforced |
| Motion | Enum: full · reduced (overrides the media query upward only) |
| Hero media | Slot-constrained upload with required alt text |

**Not settable:** arbitrary hex on any text-bearing surface, font upload or substitution, the type
scale ratio, spacing scale, breakpoints, the shadow token, grid structure, motion durations and easings.

If a free hex input is ever added, it must run a contrast check and **refuse** a failing value with an
explanation of why. That refusal is the feature — it is what protects the aesthetic being paid for.
