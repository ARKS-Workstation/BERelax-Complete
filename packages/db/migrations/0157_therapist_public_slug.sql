-- 0157 — the therapist page's URL: one slug per published display name, and the unique index that is the
--        only thing standing between two therapists and one page.
--
-- W-SITE-06 serves `/therapists/<slug>`, and the slug is the display name reduced to URL characters
-- (`therapistSlug` in `packages/core/src/seo/therapist-publishable.ts`). docs/09 §2's argument for the
-- route is that "a returning client searches for a person, not a service", so the name is in the URL and
-- the internal handle `Therapist 07` stays internal.
--
-- ## Why the column is WRITTEN and not GENERATED
--
-- `employee.is_publishable` is generated, and this looked like its sibling. It is not, and the difference
-- is where the transformation is spelled. A generated column needs an IMMUTABLE `slugify()` in SQL, which
-- would be a second implementation of a rule TypeScript already states — and `pnpm db:drift` compares
-- column shapes, not the behaviour of two functions, so the two could disagree about `Zoë` for ever with
-- every check green. So the slug is computed once, in `@berelax/core`, and written by the one repository
-- function that sets a display name (`publishTherapist` in `repositories/therapists.ts`).
--
-- What the database contributes is the part TypeScript cannot. `employee_display_name_unique` already
-- exists, and it is NOT enough: `Anna-Maria` and `Anna Maria` are two distinct display names that reduce to
-- one slug, so without `employee_public_slug_unique` they are two therapists at one URL, two sitemap
-- entries claiming the same page, and a route resolution decided by row order.
-- `packages/core/src/seo/therapist-publishable.test.ts` asserts that collision as a fact about the
-- function, so the index is the refusal of a known case rather than a precaution.
--
-- ## Why the two columns move together
--
-- `employee_public_slug_with_display_name` is an equivalence and not an implication. A slug with no display
-- name is a URL for a therapist who may not be published; a display name with no slug is a therapist the
-- route cannot find, which presents as a 404 on a page the admin has just published and names neither
-- column. Both halves have to be refused, so the constraint compares the two NULL-nesses.
--
-- ## What is deliberately NOT here
--
-- **No redirect trigger.** 0029's `redirect_map_one_hop` special-cases `/treatments/<slug>` targets
-- because a treatment target has a row to check. A therapist's archival redirect targets `/therapists` —
-- the index, which is a static route that always answers — so there is nothing for a trigger to verify
-- that the existing `redirect_map` constraints do not already cover.
--
-- **No deferred trigger on a rename.** 0029 refuses a service slug change with no 301 at COMMIT, and the
-- symmetric rule for a display name was considered and rejected: a service slug is changed by one
-- repository function and a display name is set by one repository function, and that function writes the
-- redirect in the same transaction. The reason 0029 needed the database was that the CMS, the seed and a
-- psql session all write `service`; nothing but `publishTherapist` writes `display_name`, and
-- `apps/web/src/therapist-guard.test.ts` is what holds that true by scanning for a second writer.
--
-- **No SQLSTATE.** Every refusal here is a CHECK or a unique index, so the codes are 23514 and 23505 and
-- the constraint name says which rule. ZY781 through ZY790 are released UNUSED and deliberately
-- unregistered: `pnpm sqlstate` refuses an entry for a code no migration raises.

begin;

alter table employee
  add column public_slug text;

comment on column employee.public_slug is
  'The slug of this therapist''s public page, computed from display_name by therapistSlug() in '
  '@berelax/core and written by publishTherapist(). NULL exactly when display_name is NULL. The UNIQUE '
  'index is the point: two distinct display names can reduce to one slug.';

-- An equivalence, not an implication. See the header.
alter table employee
  add constraint employee_public_slug_with_display_name
  check ((display_name is null) = (public_slug is null));

comment on constraint employee_public_slug_with_display_name on employee is
  'A slug with no name is a URL for somebody who may not be published; a name with no slug is a therapist '
  'the route cannot find, which 404s a page the admin just published and names neither column.';

-- The shape `therapistSlug` produces, asserted on the way in rather than trusted. A slug with an upper
-- case letter, a space or a leading hyphen is one somebody wrote by hand, and the URL it serves would be
-- canonicalised away by `proxy.ts` into a path this column does not hold.
alter table employee
  add constraint employee_public_slug_shape
  check (public_slug is null or public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

comment on constraint employee_public_slug_shape on employee is
  'Lower case, digits and single hyphens. proxy.ts canonicalises every other spelling, so a slug outside '
  'this shape is a row the route can never match.';

create unique index employee_public_slug_unique on employee (public_slug);

comment on index employee_public_slug_unique is
  'The refusal TypeScript cannot make. employee_display_name_unique admits Anna-Maria and Anna Maria, '
  'which reduce to one slug — two therapists at one URL and two sitemap entries for one page.';

commit;
