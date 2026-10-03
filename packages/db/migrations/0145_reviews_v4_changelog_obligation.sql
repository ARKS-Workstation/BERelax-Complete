-- 0145 — the quarterly duty to read the Business Profile API changelog, as a calendar row.
--
-- G-REV-07. ADR 0095 is the decision and `packages/google/src/adapters/reviews-v4.ts` is the quarantine
-- this row exists to keep honest. What this file is for is the half a document cannot do: docs/10 §8's
-- build-time list ends with an instruction in prose — *"read the Business Profile API changelog and
-- deprecation pages before writing the Reviews adapter, with a recurring quarterly reminder to re-read
-- them"* — and a recurring reminder written in a document is a reminder nobody receives.
--
-- ## Why it is an obligation row and not a comment, a TODO or a calendar invite
--
-- `obligation` (0052) is the one place in this build that holds a duty with a cadence, an owner role and a
-- blocking consequence, and it is read by the compliance calendar and the open-compliance dashboard. A row
-- here is therefore the only form of this duty that is VISIBLE to the person who owes it. The alternative
-- that was considered and refused is a comment in the adapter: the adapter is read when somebody is
-- changing it, and the whole point of a quarterly re-read is to notice a deprecation BEFORE anybody has a
-- reason to open the file.
--
-- Seeded by the MIGRATION rather than by `pnpm seed`, for the reason 0052's own seeded rows give: a
-- compliance calendar that exists only in a seeded database is a compliance calendar production can be
-- missing.
--
-- ## Why it is NOT `is_unverified`, when every row 0052 seeded is
--
-- The ten rows 0052 seeded are readings of secondary sources about UAE law, and `is_unverified` means *the
-- duty itself is our reading*. This duty is not a reading of anything: docs/10 §8 states it in the
-- imperative, in this build's own handover, and nobody has to confirm that Google deprecates APIs. So the
-- flag is false and `open_question_id` is NULL — and that distinction is worth keeping sharp, because
-- M-VAT-11's dashboard is driven by the flag and a false positive there is a legal question nobody owes an
-- answer to.
--
-- ## Why the owner role is `owner` and the blocking effect is `none`
--
-- `owner`, because the consequence of ignoring it is that an integration stops working with no warning —
-- a business decision about the business's own Google presence, not a floor task. There is no `developer`
-- or `engineer` in the F07 role vocabulary and inventing one for a single row would widen the
-- authorisation matrix for a reminder.
--
-- `none`, because an unread changelog does not make the premises unable to trade or unable to publish. A
-- `blocking_effect` that stopped publishing on an overdue reading would be a compliance control doing
-- something nobody asked for, and `is_blocking` is GENERATED from it so there is no second answer.
--
-- ## No anchor date
--
-- `anchor_on` stays NULL, exactly as every row 0052 seeded does, and its header says why: generation over
-- a horizon steps from this date, so a NULL anchor produces no instances rather than a calendar of
-- invented dates. The first date is the operator's to set, and `anchor_on` is the only column an UPDATE
-- may change.
--
-- ## Why `obligation_class` gains a value, and why the alternative was worse
--
-- The five classes 0052 declared are `licence`, `credential`, `hygiene`, `tax` and `labour`, and this duty
-- is none of them: it is not a permit, not a person's certificate, not a sanitation log, not a filing and
-- not a MOHRE duty. Filing it under the nearest one would be dishonest in a visible place — the compliance
-- calendar and M-VAT-11's dashboard both GROUP by class, so a vendor changelog reading would appear to an
-- operator under a heading a regulator owns.
--
-- `operational` is therefore added, additively. 0052's own table comment already says the table holds
-- *"statutory and operational obligation definitions"*, so this is the value that comment always implied.
-- The class/consequence constraint is unaffected: `obligation_blocking_effect_matches_class` permits
-- `blocking_effect = 'none'` for every class, and only `credential` and `licence` may carry a blocking
-- effect — which is exactly the guarantee that adding a class cannot make anything newly blocking.
--
-- `alter type ... add value` and the INSERT that uses it are separate statements on purpose: PostgreSQL
-- refuses a new enum value used in the same transaction that added it, and both migration runners apply a
-- file with plain `psql -f` (no `--single-transaction`), so each statement commits on its own.
--
-- The Drizzle mirror in `packages/db/src/schema/obligation.ts` gains the value in the same commit, because
-- `pnpm db:drift` compares the two both ways.
--
-- No new table, no trigger and no SQLSTATE. The ZY661-ZY670 band allocated to this unit is released
-- UNUSED and deliberately unregistered, because `pnpm sqlstate` refuses an entry for a code no migration
-- raises.

alter type obligation_class add value if not exists 'operational';

insert into obligation (
  key, title, obligation_class, cadence, subject_scope, owner_role, blocking_effect,
  evidence_required, is_unverified, unverified_note, open_question_id, source_reference, authority
) values
  (
    'business_profile_api_changelog_review',
    'Read the Business Profile API changelog and deprecation pages',
    'operational', 'quarterly', 'business', 'owner', 'none',
    -- Evidence required: the whole value of the reading is being able to say WHICH changelog entries were
    -- read and when, because the question it answers later is "did we know". A tick in a box would not.
    true, false, null, null,
    'docs/10-google-connection.md §8 (Build-time), §7 (API notes); docs/adr/0095',
    -- The authority is Google, which is not a UAE regulator and is named plainly rather than left NULL:
    -- NULL means the build has not been told which body owes the answer, and here it has been.
    'Google'
  )
on conflict (key) do nothing;
