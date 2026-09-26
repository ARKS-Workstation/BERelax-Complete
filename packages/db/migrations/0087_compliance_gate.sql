-- 0087 — the promotional window cannot be switched off, and the refusal holds for a psql session.
--
-- C-AUTO-04. The unit is one choke point, in CODE rather than in settings, and this file is the layer that
-- claim needs in order to be true of the DATABASE rather than of whichever caller remembered to go through
-- the right function.
--
-- ## What was missing, and how it would have been used
--
-- `messaging.promotional_window` is an `app_setting` row holding `{"startHour": 7, "endHour": 21}`. Before
-- this migration, `assertPromotionalWindowChange` in `@berelax/messaging` was the only thing that refused a
-- widening: it checks the role, refuses a window outside the ceiling and refuses one that never opens, and
-- it is correct. It was also the ONLY refusal, so every route into this row that did not pass through it
-- accepted `{"startHour": 0, "endHour": 24}`:
--
--   * `writeSetting` called from a script or a seed;
--   * an import of a settings export taken from another environment;
--   * `update app_setting set value = ... where key = 'messaging.promotional_window'` in `psql`, which is
--     what somebody does at 02:00 to get a campaign out;
--   * and the admin panel's own validation, whose zod schema was `min(0).max(23)` / `min(1).max(24)` and
--     therefore had no ceiling to report.
--
-- The zod schema is now bounded inside 07:00-21:00 as well (C-AUTO-04 changed it, and says why on the
-- definition). This file is the third layer, and it is the one that holds when neither of the other two is
-- in the path at all.
--
-- ## Why the same shape as 0080's frequency cap and not something new
--
-- 0080 made the frequency cap unswitchable with ONE predicate called from a trigger and from a CHECK, and
-- the division of labour there is exactly right here:
--
--   * the TRIGGER is what gives a human a sentence they can act on — which key, what they tried to set it
--     to, why it is refused, and where the real off switch is;
--   * the CHECK is the layer that still holds when `session_replication_role = 'replica'` has triggers off,
--     which is how a restore from a dump runs. A restore that silently widened the promotional window
--     would be the one route in that nobody is watching.
--
-- One function called from both, for `is_placeholder_text`'s reason: two copies of one predicate is one
-- predicate plus a future disagreement.
--
-- ## Why 0, null, 'off' and false are all refused, and separately from a widening
--
-- Those four are how "switch quiet hours off" is actually spelled in a change request, and none of them is
-- a window. They are refused BY SHAPE — not an object, or missing a key, or a key that is not a whole
-- number — before the ceiling is consulted at all, so the refusal message can say "this is not a window"
-- rather than "0 is outside 7-21", which sends somebody off to argue about the ceiling.
--
-- A window that never opens is refused too, and it is the subtle one: `{"startHour": 21, "endHour": 21}` is
-- inside the ceiling by both bounds and permits nothing. Held promotional traffic would then accumulate for
-- ever with nothing saying why — quiet hours switched off by starvation instead of by a setting. The same
-- reasoning is why `nextPromotionalOpen` in `@berelax/core` REFUSES rather than searching for ever when its
-- dated overrides leave no opening.
--
-- ## Why the ceiling is written down HERE, when C-AUTO-04 went to some trouble not to write it down
--
-- `@berelax/core` takes the ceiling as an argument and `@berelax/messaging` reads it from the settings
-- registry, precisely so the gate and the admin panel cannot disagree. This file states 7 and 21 as
-- literals, and that is not an inconsistency: SQL cannot read the TypeScript registry, and the alternative
-- is a second `app_setting` row holding the ceiling — which is a switch for the ceiling, which is the thing
-- being prevented. A ceiling that can be raised by an UPDATE is not a ceiling. So the figure appears in
-- exactly two places in this repository, the registry default and here, and the pair is asserted equal
-- behaviourally: gate case 114h drives this constraint with the registry's own numbers.
--
-- The figures are NOT provisional and no OPEN-QUESTIONS id covers them. 07:00-21:00 is TDRA's restriction
-- (docs/04 SS5), which is why `messaging.promotional_window` deliberately does not appear in the Unconfirmed
-- Assumptions panel. What IS provisional is the Ramadan NARROWING (`Y9-ramadan-window`, provisionally
-- 10:00-16:00) and the staleness ceiling on a held message (`Y9-queued-staleness`, provisionally 12 hours),
-- and neither is stored here: the narrowing is dated rows in `business_calendar` an admin states, because
-- Ramadan's dates are announced by an authority and are not a value this build may invent (brief rule 15),
-- and the staleness ceiling is a named constant in `@berelax/core`. This migration adds no table and seeds
-- no row.
--
-- ## The private SQLSTATE
--
-- `ZX001` (PromotionalWindowNotANarrowing). A private class rather than `invalid_parameter_value` for
-- 0061's reason: that code is raised by a dozen other places, so a probe asserting it passes when the
-- statement bounced off something else entirely. `ZX` because it is unowned — and picking an unowned letter
-- matters more than it looks: `ZW001` is currently raised by BOTH 0080 (FrequencyCapNotACap) and 0081
-- (published rota immutable), which is the collision the private-class convention exists to prevent, since
-- a probe asserting `ZW001` cannot tell which statement it bounced off. Reported rather than repaired here:
-- renaming another unit's SQLSTATE is another unit's migration.

begin;

-- ---------------------------------------------------------------------------------------------
-- The predicate
-- ---------------------------------------------------------------------------------------------
-- `case` rather than `and`, and that is not a style choice — it is 0080's finding, restated because this
-- function makes the same mistake available. SQL does not guarantee the evaluation order of `and`, so
-- `jsonb_typeof(v->'startHour') = 'number' and (v->>'startHour')::numeric >= 7` may evaluate the cast first
-- and raise `invalid_input_syntax` for the very value it is meant to refuse politely. `case` is documented
-- not to evaluate the branches it does not need.
--
-- NOT strict, for `is_placeholder_text`'s reason: a strict function returns NULL for NULL, and a CHECK
-- whose expression is NULL is SATISFIED — so a strict version would accept the NULL it exists to refuse.
create function promotional_window_is_a_narrowing(p_value jsonb) returns boolean
language sql
immutable
as $$
  select case
           when p_value is null then false
           when jsonb_typeof(p_value) <> 'object' then false
           when jsonb_typeof(p_value -> 'startHour') <> 'number' then false
           when jsonb_typeof(p_value -> 'endHour') <> 'number' then false
           else
             (p_value -> 'startHour')::numeric = trunc((p_value -> 'startHour')::numeric)
             and (p_value -> 'endHour')::numeric = trunc((p_value -> 'endHour')::numeric)
             -- Inside the ceiling, both ends.
             and (p_value -> 'startHour')::numeric >= 7
             and (p_value -> 'endHour')::numeric <= 21
             -- And it has to be a window. See the header on why 21-21 is the subtle one.
             and (p_value -> 'startHour')::numeric < (p_value -> 'endHour')::numeric
         end;
$$;

comment on function promotional_window_is_a_narrowing(jsonb) is
  'True only for a JSON object whose startHour and endHour are whole numbers with 7 <= startHour < endHour '
  '<= 21. Refuses SQL NULL, JSON null, 0, false, "off", a widening, and a window that never opens. NOT '
  'strict: a strict function returns NULL for NULL and a CHECK whose expression is NULL is satisfied.';

-- ---------------------------------------------------------------------------------------------
-- The trigger: the layer a human reads
-- ---------------------------------------------------------------------------------------------
create or replace function assert_promotional_window_is_a_narrowing()
returns trigger
language plpgsql
as $$
begin
  if new.key <> 'messaging.promotional_window'
     or promotional_window_is_a_narrowing(new.value) then
    return new;
  end if;

  raise exception
    '% cannot be set to %: the promotional send window is not switchable. It may only ever be NARROWED '
    'inside 07:00-21:00 Asia/Dubai, must be an object of two whole hours, and must actually open - '
    '{"startHour": 21, "endHour": 21} is inside the ceiling and permits nothing, which holds every '
    'promotional message for ever with nothing saying why. TDRA restricts promotional SMS to those hours '
    'and the sanction is sender-ID SUSPENSION rather than a per-message fine, so a send at 21:30 stops the '
    'booking confirmations too. To stop promotional traffic, engage the marketing kill switch, which says '
    'so on its face and records who engaged it. To narrow the window for Ramadan, add a dated row to '
    'business_calendar rather than editing this one, so the narrowing ends when Ramadan does '
    '(Y9-ramadan-window).',
    new.key, coalesce(new.value::text, 'NULL')
    using errcode = 'ZX001';
end $$;

comment on function assert_promotional_window_is_a_narrowing() is
  'Raises ZX001 when messaging.promotional_window is set to anything but an object of two whole hours with '
  '7 <= startHour < endHour <= 21. The CHECK constraint beside it calls the same predicate and is the layer '
  'that still holds when session_replication_role has triggers off, which is how a restore runs.';

create trigger app_setting_promotional_window_is_a_narrowing
  before insert or update of value on app_setting
  for each row execute function assert_promotional_window_is_a_narrowing();

-- The second layer. Named so the violation says what it is even with the trigger disabled.
alter table app_setting
  add constraint app_setting_promotional_window_cannot_be_widened check (
    key <> 'messaging.promotional_window'
    or promotional_window_is_a_narrowing(value)
  );

commit;
