-- 0036 — the justification on a settings change, which has never been recorded.
--
-- `app_setting_history.justification` has existed since 0010 and has never held a value. 8,202 rows,
-- none of them with a reason, including every change to a `compliance_locked` setting — which is the one
-- kind of change `writeSetting` refuses to make WITHOUT a written justification. The reason was demanded
-- of the operator, validated, and then dropped on the floor.
--
-- The mechanism: 0010 records history from a trigger on `app_setting`, and the trigger cannot see a
-- justification because it is not a column on `app_setting`. `writeSetting` therefore annotated the row
-- afterwards with `update app_setting_history set justification = …`, and 0010 also creates
--
--   create rule app_setting_history_no_update as on update to app_setting_history do instead nothing
--
-- because the table is append-only (ADR 0008). So the UPDATE succeeded, affected zero rows, and the
-- `.catch(() => undefined)` beside it — there to stop a failed annotation failing the change — never
-- fired, because nothing failed. An append-only table silently accepting a write that does nothing is
-- exactly the shape ADR 0008 warns about, and the column read as "no reason given" rather than as broken.
--
-- The fix keeps the table append-only and gives the trigger the value at INSERT time, through a
-- transaction-local setting. `set_config(..., true)` is local to the transaction, so a justification
-- cannot leak into the next statement on a pooled connection — which a column on `app_setting` or a
-- session-level variable would both allow.
--
-- `current_setting(..., true)` returns NULL rather than raising when unset, so an unjustified change (any
-- setting that is not compliance-locked) still records history with a NULL justification, exactly as now.

begin;

create or replace function record_setting_history()
returns trigger
language plpgsql
as $$
declare
  v_justification text;
begin
  -- Transaction-local, and empty-string-normalised: `set_config` cannot store SQL NULL, so a caller with
  -- no justification sets '' and that must not be recorded as a reason somebody gave.
  v_justification := nullif(btrim(coalesce(current_setting('berelax.justification', true), '')), '');

  insert into app_setting_history (key, old_value, new_value, tier, changed_by, justification)
  values (new.key,
          case when tg_op = 'UPDATE' then old.value else null end,
          new.value,
          new.tier,
          new.updated_by,
          v_justification);
  return new;
end $$;

comment on function record_setting_history() is
  'Writes app_setting_history on every value change, taking the justification from the transaction-local '
  'berelax.justification. Set it with set_config(''berelax.justification'', $1, true) in the same '
  'transaction as the UPDATE; the table is append-only, so it cannot be annotated afterwards.';

commit;
