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

## Derivatives

None are committed. Sized and re-encoded variants are built at deploy time into the public media
bucket, per [docs/08](../../docs/08-frontend-design.md) §6; these are the masters.
