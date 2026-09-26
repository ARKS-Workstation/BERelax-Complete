# ADR 0033 — the crossing carries a flag and never an answer, `false` means "not affirmed", and an answer nobody can read escalates

- **Status:** accepted
- **Date:** 2026-09-26
- **Unit:** C-CRM-09
- **Covers:** docs/01 decisions — none; this is the mechanism behind the one thing the booking layer sees of
  a clinical record, which ADR 0010 designed the boundary for and ADR 0031 built the store behind

## Decision

Four things, and each one is a refusal to say something the system does not know.

1. **A flag is derived from a `boolean` question and from nothing else.** `deriveContraindicationFlags` in
   `@berelax/core` reads `answers[key]` for a template field whose `key` **equals** the flag key and whose
   `kind` is `boolean`. It never reads free text, it never matches a label, and there is no alias table.

2. **An answer the derivation cannot read sets `requires_consultation` and NOT the flag it was about.** Four
   readings — affirmed, denied, undetermined, not asked — collapse onto two booleans, and the collapse is
   where every decision in this unit lives.

3. **`false` in the crossing means "not affirmed by an answer on record", never "ruled out".** Both screens
   say so in words, in one sentence spelled once (`CONTRAINDICATION_FALSE_MEANING`).

4. **The two sides of the crossing are in two packages that do not import each other.**
   `packages/clinical/src/flags-view.ts` writes the row behind the boundary;
   `packages/db/src/repositories/contraindication-flags.ts` reads
   `public.customer_contraindication_flags` over the application credential. The booking layer imports
   nothing from `@berelax/clinical`.

## Why a flag may only come from a boolean question

The tempting alternative is right there and it would work most of the time. An intake form asks *"are you
taking any medication?"* as `short_text`, a client writes a drug name, and a regular expression over that
answer would set `blood_thinners` correctly for the common cases.

It would also be this system asserting a fact about somebody's health that nobody stated — and the cases it
gets wrong are exactly the cases where the answer was unusual, which is to say the cases where the flag
mattered. A derived flag has to be traceable to an answer the client actually gave against wording that was
stored; a flag inferred from prose is traceable to a regular expression.

So if the salon wants the flag, the template asks the question: `blood_thinners`, `kind: 'boolean'`.
`lintContraindicationDefinition` refuses a template that asks a flag-keyed question any other way, at
publication — because the failure is otherwise silent for the life of that template version, and it fails
towards *false*, which is the direction that matters.

**Identity mapping, not a lookup table.** A field determines a flag when its key equals the flag key. An
alias table is a place where somebody adds `'surgery_recent' -> recent_surgery` for one template, and a
template that spells it a third way then derives `false` for a client who answered yes.

## Why `undetermined` escalates and `not_asked` does not

These are the two readings with nowhere to go, and they are answered differently. That asymmetry is the
substance of this ADR.

**`undetermined`** — the captured version asked, as a boolean, and the payload holds no answer this system
will read. Setting the specific flag would assert a condition from an answer nobody could read. Setting
nothing would be *"we could not establish it"* falling through to *"proceed"*, which is the failure ADR 0031
spent a whole unit making unreachable one layer down. So it sets the flag that means **a human has to ask**,
and the observable behaviour is escalation rather than a claim. Migration 0084 holds the same rule as a
CHECK: `undetermined_count = 0 or requires_consultation`, so a row written by hand that swallows an
unreadable answer is refused.

**`not_asked`** — the captured version never asked. This does **not** escalate, and the reason is that the
alternative does not work: escalating every unasked flag makes `requires_consultation` true for every
submission of every real template, and a marker that is always lit is a marker the front desk stops reading.
Which questions the form asks is the salon's decision, taken once per template version.

The cost is that `false` carries less than a reader assumes, which is why the sentence correcting it is on
every screen rather than in a comment.

## Why the crossing is booleans only, down to the SQL

The acceptance line is that the exported type is `Record<FlagKey, boolean>` and nothing else, and a type
alone cannot hold that: what a consumer actually reads is a view.

So migration 0084 rebuilt `public.customer_contraindication_flags` to expose a customer id and the eight
booleans — and **dropped `updated_at`**, which was the one non-boolean it carried. An instant there is the
date on which somebody filled in a health form; a booking decision has never needed it, and leaving it would
have made the SQL crossing a different shape from the TypeScript one. It stays on the table, behind the
step-up gate.

`packages/clinical/src/store.ts` held a second declaration of this shape from F08, with five booleans, a
customer id and a date. It is now an alias of the one in `@berelax/shared`: two exported shapes for one
crossing defeats the criterion however careful the first one is, because a consumer imports whichever it
found.

For the same reason `IntakeSubmissionInput.flags` is gone. Flags supplied by a caller are not derived flags —
a call site could have set `pregnancy: true` for a client who was never asked, and the row would be
indistinguishable. C-CRM-08 reached the same conclusion from the other end and gave `recordIntake` no flags
argument at all.

## Why the reader lives in `packages/db` and not beside the writer

The obvious home for "read this client's flags" is next to the code that writes them, and it is wrong.

Every consumer of the crossing is in the booking layer. If the reader lived in `@berelax/clinical`, every one
of those would import the package that holds the envelope, the KEK parser and the store — and
`reviews-generator-must-not-reach-clinical-data` would then be the only thing standing between a prompt
builder and a package the whole application depends on.

So the reader selects from a view over the application credential, holds no key, needs no clinical privilege,
and imports nothing from that package. "Boolean-only crossing" is an arrangement of modules, not a claim
about a type.

## Why the dependency rule was widened to name `packages/core/src/clinical/`

C-CRM-08 considered this and left it, reasoning that the real protection is that decrypting needs the KEK and
the store. That is true of the **data** and is not what the rule is for: the rule closes the **import path**,
and every path it named crosses a package boundary.

`packages/core/src/reviews/` and `packages/core/src/clinical/` are sibling directories of one package. So
`import { deriveContraindicationFlags } from '../clinical/contraindication-flags.ts'` needs no entry in any
`package.json`, is invisible to `pnpm deps`, and is the shortest edit in the repository. What it reaches is
not incidental either: `renderSubmission` takes a decrypted answer map and labels it with the questions a
client was asked, and the derivation takes the same map — a prompt builder importing either has a payload in
hand, which is the only reason to import them.

`@berelax/shared` is deliberately **not** forbidden: it holds the flag key set, a closed list of eight column
names, and banning it would ban the package every package may import.

The known-bad fixture is in `scripts/test-boundaries.mjs` rather than in `scripts/test-gates.mjs`, because a
relative import inside one package is what has to be seen to fire, and a fixture importing `@berelax/core`
would resolve to `core/src/index.ts` and match nothing.

## Why staleness arrives as the escalation flag rather than as a ninth column

A stored flag set can stop saying what a fresh derivation would say in four ways, and
`resolveContraindicationFreshness` names all four. The front desk's reader cannot compute any of them:
migration 0009 revokes the clinical schema from `berelax_app`, so it can see neither which submission is live
nor what version the form is at. A staleness check a consumer cannot perform is one it silently skips.

So the rule is also in SQL, and what it drives is `requires_consultation` — ORed into it by the view. Three
consequences, and the first is the argument:

- **A consumer cannot forget it.** There is no second column and no `if (stale)` for anybody to leave out. A
  stale set arrives at the front desk as *ask the client*, which is what a set of markers derived from a form
  the client has since replaced warrants.
- **The crossing stays the closed set.** A `flags_are_stale` column would be a ninth boolean and a second
  shape to keep in step.
- **The reason is lost, and that is correct for this reader.** A receptionist learns there is something to
  ask about. *Why* — an unreadable answer, a newer form, a newer derivation — is detail, and detail is what
  this boundary keeps in. The clinical screen gets the sentence.

The stored column and the view's column therefore differ: the row records what the derivation **found**, and
the view reports what the front desk must **do**.

`clinical.contraindication_flags_are_stale()` is `SECURITY DEFINER`, which is the one elevation this unit
adds. `security_invoker = false` makes a view's own base relations checked against the view owner; it does
not do that for a function called from the view body, so a `SECURITY INVOKER` version read the clinical
schema as `berelax_app` and the page answered `permission denied for schema clinical`. Inlining the three
clauses into the view would have needed no elevated function at all, and was rejected because the rule would
then exist only inside a view body: uncallable by a re-derivation sweep, unassertable against the pure
verdict, unmutatable by a gate case. What is elevated is one uuid in, one boolean out, and `search_path` is
pinned.

## Why the assignment scope is on the therapist and not on the front desk

A therapist's justification for opening a client's record is the appointment they are about to deliver, and
it names one client. An unassigned therapist is therefore refused **both** the flags and the note — not
merely the note — because a flag set is still a disclosure about somebody they have no reason to be looking
at, and the therapist is the role that can also read the note, so the narrower scope belongs on the wider
read.

A receptionist's justification is the booking they are taking, and it names no client in advance: a walk-in
at the door has no appointment to be assigned to. Scoping the front desk the same way would make it
impossible to route the one client the scope matters most for, and a control that cannot be complied with is
a control somebody removes. What bounds the receptionist instead is the read itself: eight booleans, no note,
and `clinical_note:read` refused by name.

## Why `?role=` may be taken from a query string

There is no admin session until W-SYS-01. `?employee=` is safe on the intake route for a reason that does not
transfer — that read is refused by the database without a step-up grant, so naming somebody else buys nothing
— but a role **is** the permission.

So the role can only **narrow**. `narrowContraindicationAccess` intersects the claimed role's decision with
`CONTRAINDICATION_SESSIONLESS_CEILING_ROLE`'s, which holds `clinical_flags:read` and not
`clinical_note:read`. `?role=therapist` does not unlock the detail; `?role=therapist` still has to be
assigned to see the flags, because that half comes from the database; `?role=marketer` is refused everything.
Both the ceiling and the narrowing are in `@berelax/core`, so the property is proved by a pure test — a
ceiling whose only test needs a server is a ceiling somebody removes without ever seeing it fail.

## `Y1-licence`, and why the eighth key is `requires_consultation`

The manifest's provisional set named it `practitioner_review_required`. It is `requires_consultation`, and
either of two reasons would decide it alone.

Migration 0008 already created the column, and 0009's view already exposes it. Renaming it would be a
migration whose only product is a synonym.

And `Y1-licence` is open. Unconfirmed resolves to the narrower reading — commercial wellness — and
`practitioner` is in `PROVIDER_TITLES` and is not in the seeded
`regulatory_profile.permitted_public_titles` (`['Therapist','Senior Therapist','Spa Therapist']`, 0004). So a
label built on that word is refused by `unpermitted_staff_title`, and
`packages/core/src/clinical/contraindication-flags.test.ts` asserts that with the label this build ships as
the control: the difference is the word, not the lint. Being wrong this way costs a reworded label; being
wrong the other way is a staff title this business may not be licensed to use, printed beside a health
marker.

**What widens if the owner answers `healthcare`:** `permitted_public_titles` gains the clinical titles and
`CONTRAINDICATION_FLAG_LABELS` may then name who reviews. The KEY does not change — a database column is not
copy.

## Consequences somebody will have to live with

- **`false` is weaker than it looks, and the screens have to keep saying so.** A template that does not ask
  about blood thinners produces `blood_thinners: false`. The sentence correcting that reading is rendered on
  every flags page, and a gate case fails if it is removed. If a later unit puts the flags on a second
  surface, that sentence goes with them.

- **A flag row is overwritten, not superseded.** This is the one place the unit departs from the clinical
  schema's append-only habit, and deliberately: a flag set is not evidence. The evidence is the submission,
  which is retained and still decrypts, and these eight booleans are a function of it. A history of them
  would be a growing record of somebody's health conditions kept for no reason anybody could state. The
  audit trail holds what changed and when.

- **The audit row carries no flag values.** `audit:read` is held by the owner, the manager, the accountant
  and the auditor; of those four only the first two hold the `clinical.flags` field group. Putting the flag
  set on the audit row would hand a client's contraindications to two roles the matrix refuses them to,
  through a table that is append-only and therefore cannot be corrected. The row carries the versions, the
  counts and whether anything changed.

- **A template version moving makes every stored flag set stale, and re-deriving cannot clear it.** That is
  correct rather than a defect: the answers on record are answers to the older question set, so a flag the
  new version asks about has nothing behind it. What clears it is the client filling in the newer form. The
  operational cost is that a reword escalates every client until they next attend, and the alternative is a
  screen that presents answers to questions nobody asked as current.

- **Bumping `CONTRAINDICATION_DERIVATION_VERSION` requires a migration.** The number is spelled in
  TypeScript and in `clinical.contraindication_derivation_version()`, because the staleness check has to run
  where `berelax_app` has no privilege. An integration test asserts the two agree. The cost is intended: a
  derivation that changes what the same answers mean is a re-derivation of every stored row, which is a
  release rather than a deploy.

- **A merged-away record's markers now reach the survivor, and this unit is why that mattered.**
  `packages/db/src/merge-participants.ts` registered `clinical.contraindication_flag.customer_id` as a column
  a merge deliberately does not re-point, and recorded that the tombstone is resolved on READ — and that
  nothing in the build read the view yet. This unit is its first reader. The view resolves `customer_id`
  through `merge_survivor_of()` and `bool_or`s the two histories, because a merge joins two and either may
  hold the affirmative. Without it, a client whose duplicate record was merged away would silently lose every
  contraindication marker.

- **Deriving a flag set is a full clinical read, with a full clinical read's cost.** It needs a step-up
  re-authentication for a stated purpose and writes a `read` audit row on the submission as well as a
  `derived` row on the flags. So the front desk cannot refresh somebody's markers; a reader who may open the
  record has to. That is the right shape — the derivation decrypts a payload — and it means a client whose
  form nobody has opened has no markers at all, which the screen renders as its own state rather than as
  eight falses.
