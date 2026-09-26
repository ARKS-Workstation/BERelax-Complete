# ADR 0031 — the consent gate is a refusal, the AAD binds the template version, and residency is a setting

- **Status:** accepted
- **Date:** 2026-09-26
- **Unit:** C-CRM-08
- **Covers:** docs/01 decisions — none; this is the mechanism behind the intake half of the boundary
  ADR 0010 designed and ADR 0025 extended to staff records

## Decision

Three things, and each one is here rather than in the application because ADR 0010's thesis is that the
clinical boundary must survive a mistake in the code above it.

1. **No intake answer may be stored without a consent record for the wording that template carries.**
   Enforced twice: `assertConsentForWrite` in `packages/clinical/src/repository.ts` refuses by name before
   anything is sealed, and migration 0082's deferred constraint trigger refuses the same INSERT at COMMIT
   (`ZJ003`). The absent case and the withdrawn case take the same branch.

2. **The AAD gains a fourth term: the template version the answers were given to.** `RecordBinding.context`
   in `packages/clinical/src/envelope.ts`, stored as `clinical.intake_submission.aad_context` and tied to
   `template_version` by a CHECK.

3. **A read needs a step-up re-authentication for one stated purpose, and is audited individually.**
   `resolveClinicalRead` in `packages/core/src/clinical/intake.ts` is the decision; `clinical.step_up_grant`
   is the evidence; the window is a setting with a fifteen-minute ceiling the database enforces.

## Why the consent gate matches on the wording HASH and not on the template id

The template id is the obvious key and it is wrong in both directions.

Consent given against version 3's wording covers version 4 **only if the wording did not change** — and a
template version changes for all sorts of reasons that have nothing to do with the consent paragraph, such as
adding a question. Keyed on the template id, a client who consented last week to wording nobody has touched
is refused, which is an operational failure that the front desk will route around.

The other direction is the one that matters. Keyed on the template id and applied loosely — "they consented
to *a* version of this form" — a client whose consent predates a **rewritten consent paragraph** is accepted.
That is the failure this whole unit exists to make unreachable: a consent record that does not correspond to
what the person actually read is not a consent record, it is a row that looks like one.

`consent_hash` is the only column that can tell the two apart, so it is the join.

## Why "consent could not be established" and "consent was withdrawn" are one branch

They have different messages and the same consequence, and the reason to say so explicitly is that the
tempting design is a three-state one: consented, withdrawn, and *unknown*. An unknown that is not a refusal
is a refusal that can be skipped, and the skip is invisible — the submission stores, the screen looks right,
and the only evidence is the absence of a row nobody queries.

So the refusal is the DEFAULT and the grant is the exception. `consentFor` returns null for "no record" and
returns the withdrawn row rather than skipping it, because skipping a withdrawal would let an older live
consent mask it. That is brief rule 12's first recorded case — `resolveTarget` ordering by id and letting a
leftover consent win — arriving in a place where the cost is reading the notes of somebody who asked to be
left alone.

## Why the AAD needed a fourth term when ADR 0010's three were enough for a treatment note

A treatment note's payload is prose. Read against the wrong row it is still the same prose, so binding
`table | record id | customer id` is the whole of what it needs: the attack is moving it between clients.

An intake submission's payload is a **map from a question set's field keys to values**. Its meaning is a
function of the template version, not just of the row. An attacker with UPDATE — or a migration with a bug —
that moved a payload from a version 3 row onto a version 4 row would produce a page where an answer to *"any
recent surgery?"* is presented as an answer to *"any allergies?"*. Every stored consistency check passes,
because they are all columns the same writer set, and the ciphertext decrypts cleanly.

The version is therefore in the GCM tag, and the term is **stored rather than derived**. Deriving it from
`template_version` at read time would leave the AAD's fourth term outside migration 0043's ZK002, which
freezes columns; storing it means all four terms are columns of the row and all four are frozen. It also
means the key rotation can SEE it: `postgres-key-store.ts` reads `aad_context` off the row, because a re-wrap
must reproduce the exact AAD a payload was sealed under, and a term the rotation cannot see is a row the
rotation cannot re-wrap — arriving as `ClinicalDekUnwrapFailed` on a row nothing is wrong with, half way
through a key rotation.

`context` is optional and **absent is not the empty string**, so a three-term binding produces byte-identical
AAD to what it produced before the field existed. That is what left every treatment note, and every staff
record sealed under ADR 0025's `STAFF_PII_KEK`, untouched.

## Why the step-up grant names a purpose, and why the read must match it

A grant that authorised any read for its window would make step-up a turnstile: step up once to check a
contraindication before a treatment, and the same five minutes covers reading every note on every client. So
the grant carries a stated purpose, the read declares one, and they must be equal.

The cost is a real one and worth naming: an operator who legitimately needs to do two things steps up twice.
That is the intended shape. The audit trail's value is that the purpose on the row was committed to **before**
the record was opened, and a purpose that covers everything is not a purpose.

Migration 0082 refuses a blank or placeholder purpose (`is_placeholder_text`, migration 0026), for brief rule
15's reason applied to a sentence rather than to a number: *"reviewing"* is a plausible purpose and
indistinguishable from a real one.

## Why the grant lives in the `clinical` schema

ADR 0010's test for what belongs behind the boundary is whether it **moves with the store**. A step-up grant
is consumed by exactly one code path — the audited clinical read — nothing else joins it, and it holds no
health data. A relocated store that had left its grants in `public` would have to reach back across a
database boundary for its own authorisation decision, which is precisely the coupling the boundary exists to
prevent. `employee_id` is a plain uuid and not a foreign key, for 0008's reason unchanged.

The asymmetry with ADR 0025's `STAFF_PII_KEK` is deliberate and consistent: an employment record does not
move with the clinical store, so its key is separate; a clinical step-up grant does move with it, so it lives
inside.

## Why the residency gate is a SETTING and not a migration

`Y5-residency` asks whether intake notes count as health data subject to UAE localisation. The strict reading
is that they do, so `data_origin = 'real'` is refused entirely until the owner answers — by the repository,
and by migration 0082's trigger reading `app_setting`.

A migration would have been the obvious way to hold that, and it makes answering the question a release. As a
setting, answering it is a configuration change on the Unconfirmed Assumptions panel with a written
justification, which is what docs/12 §1.3 asks of every deferred decision. The trigger reads a public-schema
row, which is a READ and not a foreign key: the boundary rule is about references that weld the two schemas
together for a relocation, and a relocated store carries this function with it.

An absent setting row reads as **false**. A gate whose default is "permitted" when its configuration is
missing is a gate that opens during a restore, which is exactly when nobody is watching.

## Why the question copy lint is one rule narrower than the assertive copy lint

`Y1-licence` decides the permitted public vocabulary. Unconfirmed, so the narrower reading applies: the
template's title and consent wording go through the full publication lexicon, and so does every question
label — minus `banned_claim_term`.

A question does not claim; it asks. *"Are you taking any medication for a heart condition?"* contains a word
the profile bans and asserts nothing about what these premises deliver. A lint that refused it would leave an
intake form that cannot ask about medication, which is not a stricter form, it is an unusable one — and an
unusable lint is one somebody switches off, which is the argument `lexicon.ts` already makes about its own
stemming.

Every other rule applies to a question unchanged, and each for a reason that survives the grammatical mood:
*"has our physiotherapist seen you?"* names a title the licence may not permit whether it is asked or
asserted, a treatment style attached to a person is an advertisement about people either way, and an
unlicensed activity is not made lawful by a question mark.

The exemption is **one rule wide and named in one constant**, so widening it is a visible edit.

## Consequences somebody will have to live with

- **A refusal's audit row is written on a separate connection.** Every other audit row in this system commits
  with the change it describes. A refusal inverts that: the transaction is going to roll back, so a denial
  row written inside it disappears, and an attempt to read a health record with no stated purpose becomes the
  only event in the system that leaves no trace. `audit_event` is append-only and a refusal has no other
  state to stay consistent with, so the separate connection costs nothing — but it is a second write path
  into that table and it is here on purpose.

- **A template can never be edited, only superseded.** Correcting a typo in a question is a new version. That
  is the right trade for a clinical form and it will be annoying, and the annoyance is the point: a
  submission holds a reference to its template row, so an edit changes what somebody was recorded as having
  been asked.

- **A treatment note's consent basis is weaker than a submission's, and stated rather than hidden.** A note
  has no template and therefore no wording of its own, so the basis asserted is that the client has a live
  clinical consent at all. Binding a note to a particular wording would mean choosing one, and the only
  available choices are the current template's (which refuses every note taken before the last reword) or
  the note's own (which does not exist). Inventing a third would be inventing a business rule. What holds is
  the part that matters: a client with no consent on record, or whose consent has been withdrawn, cannot have
  their notes read.

- **Serving a clinical record needs a database credential nobody has configured yet, and the route says
  so rather than working round it.** Migration 0009 does `revoke all on schema clinical from berelax_app`,
  which is this ADR's second property, so `/clients/[id]/intake` cannot read a submission over
  `DATABASE_URL` in production. It reads fine in the test database, because the connecting role there is
  the owner — which is why this was not visible in any passing test and had to be found by reading. The
  route therefore catches `insufficient_privilege` (42501) and rethrows it as
  `ClinicalConnectionNotConfigured`, naming what is missing, with **no fallback**: a route that used the
  application credential when a clinical one was absent would pass every test and fail in the only
  environment that matters. The remedy is a second database credential holding `berelax_clinical` — a
  secret-inventory entry and a runbook heading rather than a code change — and **not** granting
  `berelax_app` access to the clinical schema, which would delete the boundary instead of fixing the page.

- **The intake route takes `employee` and `purpose` as query parameters.** There is no admin session until
  W-SYS-01, exactly as every route under `/compliance`, `/hr` and `/settings` records. It is not a way to
  read somebody else's records — without a grant of their own the read is refused, and the refusal is
  recorded against whoever was named — but it is a shape that has to change when the session arrives, and
  the store call is written so that only the two arguments' source changes.

- **`packages/clinical` now depends on `packages/core`.** It did not before. The dependency runs the correct
  way and `core` remains pure, but it is a new edge and `pnpm boundaries` is what keeps it honest.

- **The step-up window has no provisional marker, and that is a claim.** Five minutes is a value this build
  chose. It is not on the Unconfirmed Assumptions panel because the panel is worth reading exactly to the
  extent that everything on it needs an owner's answer, and this needs none: shorter is unambiguously
  stricter, five minutes is already short, and nothing about the licence, the emirate or the entity moves it.
  If that reasoning is wrong, the remedy is a `provisional` block on the setting and a new OPEN-QUESTIONS id.
