# Media library — sourced from the prototype, not invented

Every file here came from `berelax.netlify.app`, the business's own prototype site. Nothing is stock,
nothing is generated, and nothing depicts a person who does not work here.

| Folder | What | Count |
|---|---|---|
| `team/` | Staff portraits, full length, in uniform | 19 |
| `photos/` | Interior and hero photography | 4 |
| `logo/` | Wordmark, dark and white | 2 |

## Two things this library is not yet

**The portraits carry no names.** Nineteen photographs, zero names — that is the state of the real
site, and it is why [ADR 0020](../../docs/adr/0020-regulatory-profile-drives-vocabulary-and-eligibility.md)
makes a display name a precondition for publishing a therapist page. The names are the admin's to
enter; the build does not invent them, and a therapist without one renders as an unlinked photo card.

**The portraits have not passed a photography-consent check.** `Y12-consent-photo` in
[OPEN-QUESTIONS](../../docs/OPEN-QUESTIONS.md) tracks it. Until each is on record, the same guard
applies: visible on the site, absent from the index, not linked.

## The aspect-ratio problem, which is real and measured

Native ratios across the nineteen portraits run from **0.461 to 0.799** — a spread of nearly two to
one. They are full-length shots, and the face occupies roughly the top fifth of the frame.

A grid at a fixed 4:5 with a centre crop therefore produces a row of torsos. That is not a
hypothetical: `scripts/check-media.mjs` measures each file and fails when an asset deviates from its
slot's ratio without a declared focal point, which is what `assets/media/manifest.json` records.

The focal points there are a reasonable default, derived from the framing, not from a person's actual
position in each frame. Setting them properly is a media audit — `Y12-photos` — and it is exactly the
kind of work a placeholder at the correct ratio is supposed to expose rather than disguise.

## There is no video here

Not one frame. docs/08 §6's shot list opens with "hero loop" and the prototype has none, so W-SYS-06 built
the four-rendition video pipeline — H.264 High and HEVC `hvc1`, at the 16:9 desktop and 4:5 mobile crops —
with nothing real to encode. `Y12-hero-video` in [OPEN-QUESTIONS](../../docs/OPEN-QUESTIONS.md) tracks it.

What stands in is deliberately not footage and says so in its own bytes. `standInMasterY4m()` renders
`photos/hero-team.jpg` as a `scale(1.0 → 1.06)` ramp — docs/08 §8's cut-order option 6, which that section
already offers as an intentional shipping choice rather than an apology — into an **uncompressed** y4m whose
header carries `BERELAX-STAND-IN-NOT-REAL-FOOTAGE-Y12-hero-video`. It is read back by `describeMaster()`,
reported in the build result, and printed in the job's log line, so no run can report renditions of footage
that does not exist. Nothing is committed: a y4m of three seconds at 1080p is 233MB.

## Derivatives

None are committed. Sized and re-encoded variants are built at deploy time into the public media
bucket, per [docs/08](../../docs/08-frontend-design.md) §6; these are the masters.

`packages/media` builds them: two art-directed crops (4:5 for phones, 16:9 above them), four widths
each, AVIF / WebP / JPEG, into content-addressed immutable paths. `apps/worker`'s
`media.build-derivatives` queue runs it on upload, and with `MEDIA_STORAGE=fake` — the default — every
put lands in `artifacts/media-outbox/` where it can be opened and looked at.

Two of these numbers are gated rather than documented. `pnpm budgets` builds the widest AVIF rung of
`photos/hero-team.jpg` at both crops and fails over 95KB / 170KB; `packages/fixtures/src/media-derivatives.itest.ts`
does the same for all four interiors. The worst of them is `photos/spa-03.jpg` at 156KB on the 16:9
crop — about 90% of its budget, so a higher-contrast replacement for that frame would breach it.

## What the placeholder colour turned out to be

[docs/08](../../docs/08-frontend-design.md) §6 asks for a flat OKLCH placeholder, "clamped to chroma
≤0.06, lightness 0.86–0.94". The clamp is doing all the work here: the dominant colour of every one of
the twelve rendered images is **below** that lightness floor, from 0.134 (`team/team-05.jpg`) to 0.783
(`team/team-06.jpg`), and `photos/spa-02.jpg` is over the chroma bound at 0.0755. §8's "pastel
photography is a performance asset" is not a description of these files. The raw measurement and a
`clamped` flag are kept rather than discarded, and `Y12-photos` is where it gets settled.
