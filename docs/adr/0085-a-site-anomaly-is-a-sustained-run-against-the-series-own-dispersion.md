# ADR 0085 — a site anomaly is a sustained run against the series' own dispersion, an absent answer is a finding with no figure, and the structured-data rule set is reused whole

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** G-SEO-04
- **Covers:** docs/01 decisions — none; this is the mechanism behind docs/09's warning about an agent
  that cries wolf and its *"do not mark up your own testimonials as review snippets"*, and it stands on
  ADR 0002 (a passing check that examined nothing is worse than a failing one), ADR 0003 (every gate
  needs a known-bad fixture asserted by rule name), ADR 0005 (no real provider in this build, so there is
  no Search Console property and no Business Profile API access), ADR 0020 (an unanswered licence question
  resolves to the stricter vocabulary, and a therapist without a display name or a recorded photography
  consent may not be published) and ADR 0070 (an unattributable figure is a refusal and never a zero)

## The problem this record is about

G-SEO-01 mirrors Search Console nightly and G-SEO-03 reads the query report back. This unit is the other
half: the analyses that judge the **live site** — a coverage and ranking series, the sitemap against the
crawl, and the structured data the pages actually serve.

All three have the same failure mode and it is not a bug. It is a report nobody opens. An agent that
raises a finding every time a daily figure moves, or lists nineteen missing therapist pages that are
missing on purpose, or re-states a rule the CI gate already enforces, produces a weekly email whose
signal-to-noise ratio teaches its reader to skim — and the week it is right is the week nobody notices.
docs/13 §5 describes the shape of that outcome for a different subject (*"19 indexed, empty,
near-duplicate pages — worse for SEO than having none"*); this is the same thing happening to attention
instead of to an index.

## Decision 1 — an anomaly is a RUN, judged against the series' own dispersion, and never a delta

Three conditions, all of which must hold, and each is a caller-supplied threshold with **no default**:

1. **`minConsecutiveDays`** qualifying days in a row, reported as **one** finding for the run.
2. **`minRelativeDropBp`** basis points below the baseline — the half a reader recognises.
3. **`minDispersionMultipleMilli`** thousandths of the baseline window's own dispersion.

The baseline is the **median** of a bounded window and the scale is the **mean absolute deviation from
that median**, both in integers. The obvious implementation — yesterday against today, past some
percentage — is what makes the feature worthless: a single salon's daily impressions move by 40% on a
quiet Tuesday, and so does a PageSpeed score between two runs of the same unchanged page. The acceptance
criterion is the measurement rather than the argument: a one-day dip and a six-point PageSpeed swing must
each produce **zero** findings, and a sustained 40% drop over seven consecutive days **exactly one**.

Condition 3 is what makes this statistical rather than a second hard-coded number. A site whose
impressions normally swing by half needs a bigger fall to be a finding than one that never moves, which
is the only reading of "statistical threshold" that does not collapse back into a magic constant.

**Why the mean absolute deviation and not the median absolute deviation.** The MAD was implemented first
and is degenerate here, measured and not reasoned: `medianOf` takes the **lower middle** of an even count
so that the answer is an integer, and the MAD of a two-valued alternating series is therefore **zero** — a
fortnight of 410, 390, 410, 390 has a MAD of nought, so `drop >= dispersion x multiple` becomes
`drop >= 0` and condition 3 does nothing at all. It passed its own unit test because that test's series
was flat, and the noisy control that was supposed to prove discrimination passed for an unrelated reason
(the run sat *above* a median pinned to the series' lower value, so the absolute floor refused it and
condition 3 was never consulted). The median stays the centre, because a centre must be robust to the
collapse being judged; the scale is the mean of the absolute deviations from it. Less robust in theory,
not degenerate in practice, and the trade worth making for fourteen daily counts.

**The consequence somebody will live with.** There is no shipped threshold set. Every caller states its
own, which is what makes a figure in the weekly report explicable — and it means a caller added later with
carelessly chosen numbers gets a cry-wolf analysis back, with nothing in this module to stop it. The
alternative was a default, and a threshold that arrives by default is a threshold nobody chose; `ctr-
outliers.ts` made the same call for the same reason.

## Decision 2 — an empty field-data answer is a FINDING whose payload holds no number

CrUX has a traffic floor: an origin below it has no field data and the dataset answers with no record
rather than with zeros. This business is below it today. Two wrong answers were available and both have
shipped elsewhere in this problem space: report nothing, so a panel shows a blank that a reader fills in
with "fine"; or coerce the absence to `0`, so the panel shows the worst possible LCP as if it had been
measured.

ADR 0070 settled the general case. What is new here is that the refusal is **structural**:
`NoFieldDataFinding` has no numeric field at all, so there is nowhere for a zero to be rendered from, and
the measured figures live on a sibling type the no-data rule cannot construct. A shape with an optional
`lcpMs` would have passed every assertion a test could reasonably make and would have been read as zero
the day somebody spread a default into it. The test asserts it over the payload's own values rather than
over a rendering, which is the form in which the claim is about the data and not about one screen.

## Decision 3 — the structured-data rule set is REUSED whole, and the one new rule is about EVIDENCE

`jsonld/validate.ts` (W-SITE-03) already holds thirty rules about what a graph says, and
`scripts/validate-structured-data.mjs` is the CI gate over them. `structured-data-validate.ts` calls it
rather than restating any of it. A second validator would be a second answer to "is this markup false",
and the day they disagreed the gate and the agent's weekly report would argue about the same page.

What the site-side module adds is only what is a property of the **page**: extraction (a block that does
not parse is markup Google drops silently, and `validateGraph` is handed an object, which exists only if
the parse succeeded), absence (a page serving no block at all passes every rule about a graph), and
evidence.

Evidence is the one that matters. `validateGraph` refuses an `aggregateRating` with **no `reviewCount`**.
That catches carelessness. It does not catch what docs/09 actually warns about, because a testimonial
block on the site produces a rating with a perfectly well-formed count: fourteen testimonials,
`reviewCount: 14`, valid markup, and a rich result Google serves until it issues a manual action. So the
question is not whether a count is present but whether anything **outside this site** evidences it — a
fact the page cannot contain. `evidencedReviewCount` is how the caller states it, it is **required**
rather than defaulted (for `ValidateGraphOptions.licence`'s reason: the caller who forgets it is the
caller whose reviews have started arriving), and in this build it is **zero**, because ADR 0005 means no
review this business has received is held anywhere a count could be derived from. Any rating is therefore
refused today, which is the correct answer rather than a limitation.

## Decision 4 — an absence a recorded refusal explains is not a finding

Nineteen therapists have no display name and no recorded photography consent (ADR 0020,
`Y12-consent-photo`), so `mayPublishTherapist` refuses every one and the sitemap carries no therapist
route. A naive orphan audit reports nineteen findings on its first run, and an owner who reads that
report learns to scroll past the therapist section — which is where the real defect will eventually be.

So an absent therapist route is a finding only when **no refusal explains it**, and the refusals come
from `therapistPublishingRefusals`, imported rather than restated: a second copy of "may this therapist be
published" is a second answer, and the day they disagree the sitemap and the structured data describe
different staff. The excused routes are **on the report**, with the refusal named, because an absence
nothing records is an absence nobody can audit — and the day an admin sets a display name the route must
appear, which is then a change in this report rather than in a comment.

The same reasoning is why every one of these analyses returns a **coverage count per rule** beside its
findings. Three of the four coverage rules have few or no subjects on this site today — there is no Search
Console property — and a rule with no subjects returns no findings, which is indistinguishable from a rule
that passed. ADR 0002 is the reason that distinction is on the answer and not in a comment;
`link-graph.ts` made the same decision one unit earlier.

## Decision 5 — fetched bytes enter `packages/core` only inside the untrusted envelope, enforced

`internal-link-audit.ts` and `structured-data-validate.ts` take a `SeoUntrustedEnvelope`, not a `string`,
and `.dependency-cruiser.cjs`'s `seo-site-analysis-must-take-the-untrusted-envelope` requires both to
import it. The envelope gains one field for this — `fenced`, the bytes that were enclosed.

**Why a field and not an inverse function.** An un-gutter-and-re-fingerprint reader was written first and
is wrong: `encloseUntrustedSeoData` splits the body on every separator a renderer might honour (`\r\n`,
`\r`, ` `, ` `) and the fingerprint is taken **before** that split, so a page served with CRLF
line endings — most of them — recovers text that cannot hash to its own fences. The reader would have
thrown `seo_untrusted_envelope_broken` on correctly built envelopes: a broken feature wearing an integrity
check's clothes. The enclosed bytes are a fact the factory already holds; carrying them is exact and
deriving them is a guess.

It does not weaken the envelope. The guarantee is about what reaches a **model** — one region, no
instruction bytes, an unforgeable label — and `region` is still the only thing a prompt is built from,
enforced by `seo-prompt-must-use-the-untrusted-envelope` and by the 200-string fuzz suite. The
deterministic analyses are not a model: they parse the bytes, and a parser handed a fence would be reading
our own framing as the page's content.

**The rule names two modules and not the directory**, which is deliberate. `coverage-anomaly.ts` is handed
numbers; demanding the import there would be satisfied by a dead one, and a rule satisfied by a dead
import is worse than no rule because it reads as proof.

## Decision 6 — NAP comes from the premises row, and the absence of a copy is a scan

"NAP consistency" means comparing what the site publishes against what the business **is**, and the only
authority for the latter is `premises` (0003) by way of the facts payload. A module holding its own copy of
the address answers "consistent" about itself, silently and for ever. It is also brief rule 15's hazard: a
plausible address written into a comparison is indistinguishable from a configured one.

So `packages/fixtures/src/seo-nap-literals.test.ts` scans every non-test module under
`packages/core/src/seo/` for a phone number, a street address and an opening-hour literal, with a
known-bad line per pattern asserted to match (three patterns never seen to fire are three patterns that
may no longer fire) and a negative control per pattern asserted not to. Two files are exempt —
`jsonld/specimen.ts`, whose values are visibly specimens, and `jsonld/business.ts`, which holds
schema.org's day boundaries — and **each exemption is asserted to still be needed**, so one that has gone
stale fails the test rather than persisting as a permission nobody can see a reason for.
