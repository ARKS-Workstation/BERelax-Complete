# ADR 0111 — A therapist page is a REFUSAL with three dispositions, and a departure redirects

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** W-SITE-06
- **Covers:** docs/01 decisions 23 — the implementation side of
  [ADR 0020](0020-regulatory-profile-drives-vocabulary-and-eligibility.md) (a therapist page needs a
  display name *and* a recorded photography consent), with ADR 0021 (style belongs to the treatment and
  not to the person) deciding how a specialism resolves, migration 0029's one-hop `redirect_map` reused
  rather than duplicated, and the route half of docs/09 §2

## Context

docs/09 §1 calls `/therapists/[slug]` *"the differentiator"* and §2 says why: a returning client searches
for a person, it is the site's best E-E-A-T signal in a health-adjacent category, and it converts because
the decision is already made. It is also the one route on this site whose content is a **named human
being**: a photograph, a name, a claim about what they are trained in, and an action that books them.

Two facts about this build decided the shape. Nineteen identifiable photographs are in the repository and
**no name, no photography consent, no language and no credential is on file** (`Y12-names`,
`Y12-consent-photo`, `Y8-staff`). And therapists leave.

## Decision 1 — the guard is a refusal, it lives in ONE module, and it has three outcomes

`isTherapistPublishable` in `packages/core/src/seo/therapist-publishable.ts` is the one predicate, and
`therapistDisposition` is the one function that answers what a URL does. Three outcomes, because docs/09
§2 names three and a boolean can only name two:

| disposition | the URL | the index | the sitemap | `Person` |
|---|---|---|---|---|
| `published` | 200 | a card **with** an anchor and a "Book with" action | one entry per locale | yes |
| `unpublished` | **404** | a card with **no anchor element at all** | absent | no |
| `retired` | **301 to `/therapists`** | no card | absent | no |

The obvious alternative — one boolean, `is_publishable`, which the database already generates — collapses
the last two rows, and that is the failure docs/09 §2 exists against: *"A therapist leaves and their page
has inbound links, accumulated reviews and rankings. Do **not** 404 it."* A 404 on a URL that ranks loses
the ranking and tells a crawler the page was a mistake. The two are indistinguishable in the output —
"the page is gone" — to everybody except the crawler holding the link.

The guard was W-SITE-03's and lived beside the `Person` builder, which was its only consumer. It now has
three, and the acceptance criterion is that there is exactly one of it, so it moved to a module of its own
and `apps/web/src/therapist-guard.test.ts` **scans the repository** for a second one. That scan is not
decoration: it found a real second statement of the pair (`isEmployeePublishable`, P-HR-01's mirror of the
generated column) and the resolution is the thing the brief asks for rather than a merge — both exist,
because one is a claim about what the DATABASE computes and the other about whether a PAGE may be
published, and `therapist-publishable.test.ts` asserts they agree over all four combinations of the pair
**and disagree for a retired therapist**, which is the reason there are two.

A portrait with no alt text is a **refusal** and not a lint. An alt-less portrait of an identifiable
person is the one failure that cannot be repaired after publication: the page is indexed, the image is
indexed with it, and a screen reader has announced an unlabelled photograph of somebody who consented to a
labelled one.

## Decision 2 — the slug is computed in TypeScript and made unique by the database

`employee.public_slug` (migration 0157) is a **written** column, not a generated one, and
`therapistSlug()` in `@berelax/core` is the only spelling of the transformation. The alternative was a
generated column with an `IMMUTABLE slugify()` in SQL — the shape `is_publishable` has — and it was
rejected because `pnpm db:drift` compares column *shapes*, not the behaviour of two functions: the SQL and
the TypeScript could disagree about a combining mark for ever with every check green.

What the database contributes is the refusal TypeScript cannot make. `employee_display_name_unique`
already existed and is **not enough**: `Anna-Maria` and `Anna Maria` are two distinct display names that
reduce to one slug, so without `employee_public_slug_unique` they are two therapists at one URL, two
sitemap entries for one page, and a route resolution decided by row order. That collision is asserted as a
fact about the function, so the index refuses a known case rather than a hypothetical one.

The consequence somebody has to live with: there is **no deferred trigger** forcing a display-name rename
to leave a 301, where 0029 has one for a service slug. 0029 needed the database because the CMS, the seed
and a `psql` session all write `service`; nothing but `publishTherapist` writes a display name, and that
claim is load-bearing — it is held by the same repository scan, which refuses a second
`update employee set display_name = …` anywhere in the tree.

## Decision 3 — both therapist routes are DYNAMIC, and the reason is consent rather than speed

docs/09 §1's table says ISR, and every other content route on this site is ISR for a good reason: the page
is generated from rows and a correction reaches it by revalidation rather than by a deploy. These two are
the exception, and the argument is one-directional.

A **withdrawn photography consent has to take effect on the next request.** An ISR copy of a therapist
page is a cached document carrying somebody's name and photograph, and `revalidatePath` is a door somebody
has to remember to walk through. A stale card showing a name after consent was withdrawn is the single
failure this guard exists to prevent, and it would be invisible: the row says unpublished and the page
says otherwise. The cost is a per-request render of a page that reads nineteen rows, which is the cheapest
read on the site.

## Decision 4 — a specialism resolves through `service_skill`, never through a string

`knowsAbout` is *"specialisms mapped to bookable services"* (docs/09 §2), and the mapping is a **row**.
`service.style` is `asian`; `employee_skill.skill` is `asian_style`; the relation between them is
`service_skill` (ADR 0021). A `${style}_style` would compile, read naturally, and be wrong the first time
a style is named anything else — and the symptom would be every therapist page refusing with a message
about an archived service, which is the wrong diagnosis for the right failure.

A specialism that resolves to **no live service refuses the page, naming the specialism.** Half a
`knowsAbout` is worse than a refusal: the page still publishes, the missing expertise is invisible, and a
client arrives at the desk asking for a treatment the business no longer sells.

## Decision 5 — the registry may DECLARE that a parameterised document has no sample path

`/therapists/[slug]` is the first document in the registry with no URL that answers 200, because no
therapist is publishable and this build may not invent one. Every consumer that opens a route —
the normalisation walk, the `hreflang` assertions, the structured-data extraction, the capture matrix —
was written against `documentRoutes()` and would have asserted all of it against a 404, which **passes**:
a 404 has a canonical link and a robots header like any other document.

So `RouteEntry` gained `noSamplePath`, a **sentence** and not a flag, and `sampleableDocumentRoutes()` is
the one reader of it. An omission was the alternative and it is indistinguishable from the defect it would
hide — a parameterised document whose author forgot the sample params, which is how a harness ends up
photographing a pattern. `registry.test.ts` asserts the two fields are mutually exclusive, that the reason
is a sentence, and that the two route sets differ by exactly one entry today.
