-- 0055 — the two trigram indexes the duplicate-candidate scan runs through.
--
-- C-CRM-02. Duplicates are guaranteed in a phone-first business: one person is `+971501234567` at the
-- desk, `0501234567` on the WhatsApp export and `050 123 45 67` in the paper diary, and until something
-- looks for them each spelling is its own row with a third of the person's history on it. The pure half
-- of the detection is `packages/core/src/crm/duplicate-score.ts`; this migration is the part a scorer
-- cannot do, which is finding the handful of rows out of thousands that are worth scoring at all.
--
-- ## What is here, and what is deliberately not
--
-- Two indexes, no tables, no columns and no foreign keys. That is worth stating because the obvious
-- alternative — a `duplicate_candidate` table the detector writes its findings into — would be wrong
-- twice over. It would be a second source of truth for a question the scorer answers from the rows
-- themselves, stale from the moment either record is edited; and the review queue and the merge that
-- acts on it are C-CRM-05's, which is the unit that knows what a reviewed pair needs to record. A table
-- written now would be a table that unit has to migrate.
--
-- It also adds no foreign key, and that too is deliberate. A new FK referencing `appointment` or
-- `customer` makes PostgreSQL refuse `TRUNCATE` on that table in any statement that does not also name
-- the referencing one — and four integration suites truncate `appointment`. One unit's single new table
-- has already turned two dozen unrelated assertions red that way.
--
-- ## Why the name index is on `name_match_key` and not on `display_name`
--
-- 0019 already built `customer_display_name_trgm_idx` on the raw written name, which serves a human
-- searching for a customer. It is the wrong index for duplicate detection, because the name folding this
-- system uses is not something SQL does: `normaliseNameForMatching` in `packages/core` lower-cases,
-- strips Latin accents, folds ta-marbuta to ha and alef-maksura to ya — half this customer base writes
-- Arabic, and `unaccent` folds none of that — and then SORTS the words, so that a customer who gives
-- their name family-name-first on a form still lands beside the record the desk typed the other way
-- round.
--
-- `customer.name_match_key` already holds that folded form, written by the application. 0019 states why
-- it is not a generated column and the reason is the same one that decides this index: `unaccent` is
-- STABLE, not IMMUTABLE, so it cannot appear in an index expression at all, and a plpgsql
-- re-implementation of the folding would give one match key two definitions that drift. So the folding
-- stays in TypeScript, in one place, and PostgreSQL is left with the part it is genuinely better at —
-- the trigram similarity.
--
-- The index is on `split_part(name_match_key, ':', 1)`, which is the key without its `:last-4` tail.
-- `split_part` is IMMUTABLE, so the expression is indexable, and dropping the tail matters: with it, two
-- records sharing the last four digits of their numbers score as more similar on their NAMES, which is
-- the phone signal leaking into the label signal and being counted twice.
--
-- ## Why the phone index is a trigram index and not another btree
--
-- `customer_phone_match_key_idx` (0019) is a btree, and it answers "is there a row with exactly these
-- nine digits" — which is the case the normaliser already collapses. The duplicates a btree cannot find
-- are the mistyped ones: one digit wrong, two digits swapped, a digit dropped. A trigram index finds
-- those, because nine digits that differ in one position share almost all of their trigrams, and it
-- finds them with an index scan instead of a sequential scan over the whole customer table.
--
-- ## Why both indexes are GiST and not GIN, which is measured rather than assumed
--
-- GIN is the usual recommendation for `pg_trgm` and it is the wrong one at the size this business is.
-- Measured against the 5,000-row probe table `packages/fixtures/src/crm-duplicates.itest.ts` builds, for
-- a nine-digit phone probe:
--
--   * sequential scan        estimated 186, ran in 8.0 ms
--   * GIN bitmap index scan  estimated 583, ran in 3.2 ms   <- faster, and NOT CHOSEN
--   * GiST index scan        estimated   8, ran in 0.8 ms   <- chosen
--
-- `gincostestimate` charges an eleven-trigram probe roughly 580 in startup before it reads a single row,
-- which is more than reading the whole table costs — so the planner picks the sequential scan, and the
-- GIN index is a megabyte of write amplification that nothing ever reads. An index the planner will not
-- use at the size the table actually is is not an index; it is a comment with a maintenance cost. GiST
-- estimates honestly, is a third of the size, and supports `<->` distance ordering into the bargain.
--
-- The trade, stated so that the next person can reverse it deliberately: GiST is lossy and loses to GIN
-- once a table is large enough that GIN's startup stops mattering — tens of thousands of rows and up.
-- This business has one premises and thousands of customers. If that changes, the swap is one migration
-- and the candidate query does not move, because `%` is answered by both operator classes.
--
-- `pg_trgm` is already installed (0001) and 0019 already relies on it.

begin;

-- ---------------------------------------------------------------------------------------------
-- The phone candidate index
-- ---------------------------------------------------------------------------------------------

create index customer_phone_match_key_trgm_idx on customer using gist (phone_match_key gist_trgm_ops);

comment on index customer_phone_match_key_trgm_idx is
  'C-CRM-02 candidate scan. The btree on the same column answers exact equality, which the normaliser '
  'has already collapsed; this one finds the MISTYPED neighbours - one digit wrong, two transposed, one '
  'dropped - which is what a duplicate looks like once every spelling of one number is canonical.';

-- ---------------------------------------------------------------------------------------------
-- The label candidate index
-- ---------------------------------------------------------------------------------------------
-- Partial on `name_match_key is not null`, because a null key is not a candidate for anything: most
-- customers have no display name at all (no name is ever invented for a customer, ADR 0020) and
-- indexing their absence would put the majority of the table in an index that cannot match.

create index customer_name_fold_trgm_idx
  on customer using gist (split_part(name_match_key, ':', 1) gist_trgm_ops)
  where name_match_key is not null;

comment on index customer_name_fold_trgm_idx is
  'C-CRM-02 candidate scan, on the FOLDED name without its :last-4 tail. The folding is '
  'normaliseNameForMatching in packages/core and cannot be done here: unaccent is STABLE so it cannot '
  'appear in an index expression, and it folds no Arabic orthography anyway. split_part is IMMUTABLE, '
  'which is what makes the expression indexable; dropping the tail stops the phone signal being '
  'counted a second time as a name signal.';

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- Nothing granted and nothing revoked, which is a conclusion rather than an omission: an index is not
-- a grantable object, and every role that can already read `customer` (0019, 0009) can use these.

commit;
