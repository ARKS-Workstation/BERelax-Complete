-- 0117 — no column a checkout writes may hold text shaped like a card number.
--
-- Y-PAY-03. One function and one rule, `ZY231`, on the two tables a hosted-fields checkout writes to.
--
-- ## What this is for
--
-- The unit's subject is an ABSENCE: under SAQ-A, card entry happens entirely inside the gateway's
-- cross-origin hosted fields and a primary account number never reaches this system. An absence cannot be
-- proved by a passing assertion, so it is defended by things that FAIL when it stops holding — a static
-- scan (`pnpm saq-a`), a redaction sweep over every sink, and this.
--
-- The specific hole this closes is the one our OWN form leaves open. `payment_intent.reference` is free text
-- typed by a member of staff at the front desk, and `idempotency_key` is free text supplied by the client.
-- Neither is card data and both are places a card number can END UP: an operator pastes the wrong clipboard
-- into the reference box, or an integration concatenates a form's fields into a key. The request boundary
-- refuses that (`assertNoCardData` in `@berelax/payments`, answered as a 400), and as the ONLY guard it fails
-- the way ADR 0056 describes: it is one `if` away from being skipped, the skip is silent, and three later
-- units — Y-PAY-04's webhook, Y-PAY-05's reconciliation, Y-PAY-06's refund screen — are three more writers
-- of this table in three worktrees that cannot see each other.
--
-- ## Why this is a TRIGGER and not a CHECK constraint, which is the whole point of the file
--
-- A CHECK is the obvious mechanism: `check (not is_card_shaped(reference))`. It is the WRONG mechanism here,
-- and the reason is specific rather than stylistic. PostgreSQL reports a CHECK violation as
--
--     ERROR:  new row for relation "payment_intent" violates check constraint "..."
--     DETAIL:  Failing row contains (019a…, 4111111111111111, …).
--
-- so the constraint that keeps the card number out of the column writes it into the server log, and from
-- there into whatever ships those logs. The guard would create the exact disclosure it exists to prevent, and
-- it would do it on the one path everybody agrees is the safe one. A trigger raising a message we write
-- ourselves names the COLUMN and never the value.
--
-- That is ADR 0067's first consequence, and it is the reason the refusal carries a private SQLSTATE at all
-- (ADR 0043): a caller has to be able to branch on this rule without reading prose, because the prose is
-- deliberately uninformative about what was refused.
--
-- ## Why only these two tables, and deliberately NOT audit_event or outbox_event
--
-- "No audit row may be able to contain a card number" is the strongest-sounding version of this rule and it
-- is refused here, on measured grounds. `is_card_shaped` reports a 13-to-19-digit Luhn-valid run, and about
-- one arbitrary run in ten of that length is Luhn-valid. `audit_event.after_state` and `outbox_event.payload`
-- carry the whole build's payloads, which include a fifteen-digit TRN, IBANs whose BBAN can be sixteen digits
-- or more (P-HR-12's WPS file), and E.164 numbers up to fifteen digits. A trigger there would refuse
-- legitimate writes roughly one time in ten per long digit run — and an audit write that can be refused is an
-- audit trail with a hole in it, which is a worse failure than the one being prevented.
--
-- So the append-only shared tables get the other mechanism: every payments payload passes through
-- `redactCardData` before it reaches a sink, `scripts/check-saq-a.mjs` refuses a payments audit or outbox
-- write that does not, and `apps/web/src/checkout.itest.ts` drives a Luhn-valid test PAN through the checkout
-- and full-text scans `audit_event`, `outbox_event`, the message outbox, the captured log stream and the
-- captured breadcrumbs for it. Structural where a refusal is safe; scanned where it is not. ADR 0067 records
-- the division and why it is not an oversight.
--
-- ## The second statement of one fact, and the check that holds it equal
--
-- `is_card_shaped()` here and `cardShapedRuns()` in `packages/payments/src/redaction.ts` are the same rule
-- written twice, because SQL cannot read TypeScript. A second statement of a fact drifts, and the direction
-- it would drift in is the dangerous one: a database still accepting what the request boundary had started
-- refusing, so a test asserting a refusal would be satisfied by the wrong layer. `CARD_SHAPE_PROBES` is the
-- corpus, stated once in that module, and `packages/fixtures/src/card-shape-agreement.itest.ts` drives every
-- entry through both implementations and requires identical verdicts.
--
-- One private SQLSTATE, `ZY231`, of the band `ZY231`-`ZY240` issued to this unit. `ZY232`-`ZY240` are unused
-- and are NOT registered: an entry for a code no migration raises is what direction 3 of ADR 0043's gate
-- refuses, which is the direction that lets the registry shrink. One code and not two, although the rule is
-- attached to two tables, because it is ONE rule — a payments column may not hold card-shaped text — and
-- ADR 0043's subject is precisely one code standing for two rules.

begin;

-- ------------------------------------------------------------------------------------------------
-- is_card_shaped — the shape, in SQL
-- ------------------------------------------------------------------------------------------------

create function luhn_check(p_digits text) returns boolean
language plpgsql
immutable
strict
parallel safe
as $$
declare
  v_sum    integer := 0;
  v_double boolean := false;
  v_value  integer;
  v_index  integer;
begin
  if p_digits = '' or p_digits ~ '\D' then
    return false;
  end if;
  -- Right to left, doubling every second digit and casting out nines. The ordinary Luhn walk, and it is
  -- written out rather than expressed as a sum over a generated series because the alternating double is
  -- positional and a set-returning expression would need the position anyway.
  for v_index in reverse length(p_digits)..1 loop
    v_value := substr(p_digits, v_index, 1)::integer;
    if v_double then
      v_value := v_value * 2;
      if v_value > 9 then
        v_value := v_value - 9;
      end if;
    end if;
    v_sum := v_sum + v_value;
    v_double := not v_double;
  end loop;
  return v_sum % 10 = 0;
end $$;

comment on function luhn_check(text) is
  'The Luhn checksum over a string of digits. Stated here because SQL cannot read TypeScript; '
  'isLuhnValid in packages/payments/src/redaction.ts is the other statement of it, and '
  'packages/fixtures/src/card-shape-agreement.itest.ts holds the two equal over CARD_SHAPE_PROBES.';

create function is_card_shaped(p_text text) returns boolean
language plpgsql
immutable
strict
parallel safe
as $$
declare
  v_match  text[];
  v_groups text[] := '{}';
  v_gaps   text[] := '{}';
  v_index  integer;
  v_group  text;
  v_gap    text;
  v_chain  text := '';
  v_chains text[] := '{}';
  v_run    text;
  v_length integer;
  v_start  integer;
begin
  /*
    Digit groups, joined across a SINGLE space or hyphen when both groups are at most six digits long.

    Six because every published card format groups in fours except American Express's 4-6-5, and the clause
    is load-bearing rather than tidy: without it an all-digit uuid - `00000000-0000-7000-8000-000000000000` -
    joins into one 33-digit run full of Luhn-valid windows, and a legitimate intent id reads as a card
    number. That was a live defect in the TypeScript half, found by Y-PAY-02's route suite asserting a 404
    and getting a 400, and this function is the same rule so it had the same bug.

    `([0-9]+)([^0-9]*)` walks the whole string in order and hands back each group with the gap that follows
    it, so "exactly one separator" is a length test on the gap rather than a lookbehind - and PostgreSQL's
    regex lookbehind is not something to rest a refusal on.
  */
  for v_match in select regexp_matches(p_text, '([0-9]+)([^0-9]*)', 'g') loop
    v_groups := v_groups || v_match[1];
    v_gaps   := v_gaps || v_match[2];
  end loop;

  -- The join is tested on BOTH sides, which is the part a one-pass version gets wrong: a four-digit group
  -- followed by a twelve-digit one must not join, and a loop that checked only the group it was holding
  -- would have joined `8000-000000000000` into sixteen digits. That was this file's own first draft.
  for v_index in 1..coalesce(array_length(v_groups, 1), 0) loop
    v_group := v_groups[v_index];
    if v_chain = '' then
      v_chain := v_group;
    end if;
    v_gap := v_gaps[v_index];
    if v_index < array_length(v_groups, 1)
       and (v_gap = ' ' or v_gap = '-')
       and length(v_group) <= 6
       and length(v_groups[v_index + 1]) <= 6 then
      v_chain := v_chain || v_groups[v_index + 1];
      continue;
    end if;
    v_chains := v_chains || v_chain;
    v_chain := '';
  end loop;

  foreach v_run in array v_chains
  loop
    if length(v_run) < 13 then
      continue;
    end if;
    -- Every 13-to-19-digit window inside the run, not only the whole run. A card number pasted inside a
    -- longer digit string is exactly the shape an accident produces, and a whole-run check misses it.
    for v_length in 13..least(length(v_run), 19) loop
      for v_start in 1..(length(v_run) - v_length + 1) loop
        if luhn_check(substr(v_run, v_start, v_length)) then
          return true;
        end if;
      end loop;
    end loop;
  end loop;
  return false;
end $$;

comment on function is_card_shaped(text) is
  'True when the text holds a 13-to-19-digit Luhn-valid run, after single separators between digits are '
  'removed. The same rule as cardShapedRuns in packages/payments/src/redaction.ts, which is the other '
  'statement of it. Deliberately NOT applied to audit_event or outbox_event: those payloads carry TRNs, '
  'IBANs and E.164 numbers, and refusing an audit write one time in ten is a worse failure than the one '
  'being prevented. See migration 0117 and ADR 0067.';

-- ------------------------------------------------------------------------------------------------
-- ZY231 — a payments column may not hold card-shaped text
-- ------------------------------------------------------------------------------------------------
-- A trigger and not a CHECK, because a CHECK violation's DETAIL line prints the failing row. See the header.
-- The message names the TABLE and the COLUMN and never the value.

create function refuse_card_shaped_payment_text() returns trigger
language plpgsql
as $$
declare
  v_column text := null;
begin
  if tg_table_name = 'payment_intent' then
    if is_card_shaped(new.reference) then
      v_column := 'reference';
    elsif is_card_shaped(new.idempotency_key) then
      v_column := 'idempotency_key';
    elsif new.gateway_intent_id is not null and is_card_shaped(new.gateway_intent_id) then
      v_column := 'gateway_intent_id';
    end if;
  elsif tg_table_name = 'payment_intent_transaction' then
    if is_card_shaped(new.gateway_event_id) then
      v_column := 'gateway_event_id';
    end if;
  end if;

  if v_column is null then
    return new;
  end if;

  raise exception
    'CardShapedTextRefused: %.% holds text shaped like a card number (a 13-to-19-digit Luhn-valid run) '
    'and the write is refused. Card entry under SAQ-A happens entirely inside the gateway''s cross-origin '
    'hosted fields; nothing this build stores may hold a primary account number, and this column least of '
    'all - it is free text a person types. The offending value is deliberately NOT in this message: a '
    'refusal that quoted it would write the number into the log it was raised to keep it out of, which is '
    'why this is a trigger rather than a CHECK constraint (whose DETAIL line prints the failing row). '
    'Remove the digits; if a real reference genuinely looks like this, it needs a new column and a '
    'decision, not an exemption.',
    tg_table_name, v_column
    using errcode = 'ZY231';
end $$;

comment on function refuse_card_shaped_payment_text() is
  'Raises ZY231 when a payments column would hold card-shaped text. One function for both tables because '
  'it is ONE rule; tg_table_name chooses the columns. Names the column and never the value.';

create trigger payment_intent_no_card_shaped_text
  before insert or update on payment_intent
  for each row execute function refuse_card_shaped_payment_text();

create trigger payment_intent_transaction_no_card_shaped_text
  before insert on payment_intent_transaction
  for each row execute function refuse_card_shaped_payment_text();

-- INSERT only on the transaction table, deliberately: ZY161 already refuses every UPDATE and DELETE on it
-- for every role, so a BEFORE UPDATE trigger here could only ever fire after ZY161 had already refused -
-- and a trigger that can never be reached is a rule nobody has seen work (ADR 0003). `payment_intent` takes
-- both, because an UPDATE there is the ordinary path: ZY162 lets an intent move, and a move must not be the
-- opportunity to write a card number into the reference.

commit;
