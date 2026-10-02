-- 0134 — the card-on-file mandate, and the fee charge path that is provably disabled.
--
-- Y-PAY-07. ADR 0088 is the decision and `packages/core/src/payments/fee-policy.ts` is the logic. What
-- this file is for is the half of it a `psql` prompt can reach, and it is the half that matters most,
-- because the thing being prevented here is a charge that a screen's validation would be the only thing
-- standing in the way of.
--
-- ## What a mandate is, and what it is not (ADR 0067)
--
-- A mandate here is a RECORD THAT A MANDATE EXISTS AT A GATEWAY. It is the paperwork and never the
-- instrument: which disclosure the customer was shown, when they agreed, what maximum they agreed to, and
-- the opaque handle the gateway returned for the card IT holds. Under SAQ-A card entry happens entirely
-- inside the gateway's cross-origin hosted fields and nothing in this build may hold a primary account
-- number — so there is no PAN column, no expiry column, no CVV column, no last-four column and no BIN
-- column, and `ZY423` refuses a token reference that is card-shaped so that the absence is a refusal
-- rather than a convention somebody later widens. There is no chosen gateway, no merchant account and no
-- MCC (`PENDING['card-gateway']`), which is why `gateway` is free text with an open question beside it and
-- not an enum: an enum here would be a list of gateway names nobody has chosen (brief rule 15).
--
-- ## Why the mandate row is APPEND-ONLY, and why that forces revocation into its own table
--
-- The acceptance line is "an UPDATE on it is refused by a DB rule", and the reason is the same one ADR
-- 0008 gives for `audit_event`: the row is EVIDENCE. It says a specific person was shown specific words
-- and agreed to a specific figure. An UPDATE on it would restate what somebody consented to, after the
-- fact, with nothing left saying what they actually consented to — and the figure it would restate is the
-- cap, which is the entire content of the agreement.
--
-- So `ZY421` refuses UPDATE and DELETE on `payment_mandate` for every role including the owner. That
-- makes `revoked_at` on the row impossible, which is not a wrinkle to work around: a revocation is a
-- SECOND act by the same person at a later instant, and the right shape for a second act is a second row.
-- `payment_mandate_revocation` holds it, append-only on the same terms, at most one per mandate — a
-- mandate cannot be revoked twice, because the second revocation would be a statement about an authority
-- that no longer existed. `payment_mandate_status` is the view that reads the state out of the dates,
-- which is ADR 0057's shape one subject along from `appointment_deposit_balance`: the live figure is a
-- derivation over rows nobody has edited, never a stored column somebody has to remember to set.
--
-- A stored `state` column would be the dangerous alternative and the failure is specific: nothing runs at
-- the instant a mandate expires, so a stored state says `active` for ever unless a job sweeps it, and the
-- charge path would read `active` from a row whose authority lapsed in March.
--
-- ## Why the charge path exists at all, when it refuses every input
--
-- `cancellationCharge()` answers zero for every input, `Y9-windows` says "24h window; no fee charged,
-- flagged only", and the owner has agreed no fee policy. So why is there a `mandate_charge_attempt` table?
--
-- Because the acceptance lines are "a charge above the recorded cap is refused" and "a revocation takes
-- effect on the next charge attempt", and a refusal nobody has seen fire is not a refusal (ADR 0003). The
-- attempt table is what makes every one of those rules reachable and testable TODAY. An attempt is
-- recorded whatever its outcome, including a refused one — `outcome` is in
-- {refused_no_policy, refused_cap, refused_not_active, charged} — because "we tried to charge this
-- customer and the system stopped us" is a fact an operator needs and the attempt that was blocked is the
-- one worth having a record of.
--
-- `ZY426` is the load-bearing one: an attempt with `outcome = 'charged'` is refused while
-- `cancellation_fee_policy_on_file()` answers false, which it does. That is the sentence "the charge path
-- ships disabled" made into a statement PostgreSQL enforces, rather than a comment in a TypeScript module
-- that a second call site would not read. And it is a REFUSAL and not a charge of zero fils, for ADR
-- 0070's reason: a zero posts, balances, and reports as a fee that had been correctly worked out to be
-- nothing, so the figure ends up in the books as a decision nobody made.
--
-- ## Why the order of the refusals is the reverse of the obvious one
--
-- `ZY425` (not active) and `ZY424` (above cap) are checked on the ROW, which means they fire for an
-- attempt whose outcome already says `refused_no_policy`. That looks redundant and is not: it is what
-- keeps the cap rule and the revocation rule reachable while no policy exists. If the policy gate were
-- the only check, every one of the five acceptance refusals would collapse into one message and four of
-- them would be code nobody had ever seen run.
--
-- ## One rule, one code — and the one place this file does NOT add a code
--
-- Six codes of the band `ZY421`-`ZY430` issued to this unit. `ZY427`-`ZY430` are unused and are NOT
-- registered: an entry for a code no migration raises is what direction 3 of ADR 0043's gate refuses.
--
--   ZY421  the mandate record and its revocation are append-only
--   ZY422  a mandate must name the disclosure it was agreed against, and the hash must be a hash
--   ZY423  a mandate token reference may not be card-shaped
--   ZY424  a charge attempt may not exceed the cap the customer agreed
--   ZY425  a charge attempt against a mandate that is not active at that instant is refused
--   ZY426  no attempt may be recorded as charged while no fee policy is on file
--
-- `is_card_shaped()` and `luhn_check()` are 0117's and are CALLED here, not restated.
-- `scripts/check-saq-a.mjs` refuses a second Luhn check anywhere in the tree, and a second one here would
-- be the second policy — the one that misses the spelling with spaces in it.

begin;

-- ------------------------------------------------------------------------------------------------
-- cancellation_fee_policy_on_file — the provisional answer, stated ONCE
-- ------------------------------------------------------------------------------------------------

-- False, and a FUNCTION rather than a constant in a predicate for the reason `customer_deposit_account_code()`
-- is one: the answer appears in exactly one place a reader can find, so the day a fee policy is agreed
-- there is one definition to change and `packages/fixtures/src/mandate.itest.ts` has one assertion to
-- update deliberately rather than quietly.
--
-- It reads no setting, and that is the honest shape. `payments.cancellation_fee_charging_enabled` is named
-- in `@berelax/core` as the setting that WOULD have to be changed, with the audit trail `app_setting`
-- carries; but no such row exists, and a function that read a missing row and fell back to false would
-- make "the policy is off" and "nobody has recorded a policy" indistinguishable — which is exactly the
-- conflation ADR 0070 refuses one layer up.
create function cancellation_fee_policy_on_file() returns boolean
  language sql immutable parallel safe
  as $$ select false $$;

comment on function cancellation_fee_policy_on_file() is
  'Whether a cancellation or no-show fee policy is on file. FALSE. Y9-windows is open, the owner has '
  'agreed no fee policy and the business holds no merchant account. Stated once so ZY426''s predicate and '
  '@berelax/core''s PROVISIONAL_FEE_POLICY can be compared in one place '
  '(packages/fixtures/src/mandate.itest.ts). The remedy is a decision and an ADR, not an edit here.';

-- ------------------------------------------------------------------------------------------------
-- payment_mandate — the paperwork, and no instrument
-- ------------------------------------------------------------------------------------------------

create table payment_mandate (
  id                uuid        primary key default uuid_generate_v7(),
  customer_id       uuid        not null references customer (id),

  -- Free text with an open question beside it, deliberately NOT an enum: no gateway has been chosen
  -- (PENDING['card-gateway']) and a check constraint listing gateway names would be a list of vendors
  -- nobody picked. `payment_intent.gateway` (0106) carries the same decision for the same reason.
  gateway           text        not null
                      constraint payment_mandate_gateway_nonempty check (btrim(gateway) <> ''),

  -- The gateway's OPAQUE HANDLE to the instrument the gateway holds. ZY423 refuses a card-shaped value.
  -- There is deliberately no last-four, no BIN, no expiry month and no scheme column: each of them is a
  -- fragment of card data, each is individually defensible, and the set of them is a cardholder data
  -- environment this build is not in (ADR 0067).
  token_reference   text        not null
                      constraint payment_mandate_token_nonempty check (btrim(token_reference) <> ''),

  -- WHICH disclosure, and the hash of the words that were shown. Not the words: the wording has not been
  -- written or approved, so a body column here would be filled with something plausible, which is worse
  -- than empty (brief rule 15). The version is the customer's evidence and the hash is what makes it
  -- checkable the day the wording is on file.
  wording_version   text        not null
                      constraint payment_mandate_wording_version_nonempty
                      check (btrim(wording_version) <> ''),
  wording_sha256    text        not null,

  -- The maximum the customer agreed to. Strictly positive: a mandate authorising zero is not a mandate,
  -- and `fils_nonneg` alone would admit one.
  cap_fils          fils_nonneg not null
                      constraint payment_mandate_cap_positive check (cap_fils > 0),

  agreed_at         timestamptz not null,
  -- Mandates do not last for ever. An open-ended authority to take money is not an authority anybody
  -- gave, so the column is `not null` and the window is checked rather than assumed.
  expires_at        timestamptz not null,
  constraint payment_mandate_expires_after_agreement check (expires_at > agreed_at),

  trading_date      date        not null references business_day (trading_date),
  created_at        timestamptz not null default now()
);

comment on table payment_mandate is
  'A record that a card-on-file mandate exists AT A GATEWAY: which disclosure the customer was shown, '
  'when, what maximum they agreed to, and the gateway''s opaque handle. Never an instrument - there is no '
  'column here able to hold a primary account number, an expiry, a CVV, a last-four or a BIN, and ZY423 '
  'refuses a card-shaped token reference (ADR 0067). Append-only: UPDATE and DELETE raise ZY421 for every '
  'role including the owner, because the row is evidence of what a person consented to. A revocation is a '
  'row in payment_mandate_revocation, never an edit here.';
comment on column payment_mandate.token_reference is
  'The gateway''s opaque handle to the instrument the GATEWAY holds. ZY423 refuses a 13-to-19-digit '
  'Luhn-valid run via 0117''s is_card_shaped(). [UNVERIFIED] Y7-gateway: no gateway has been chosen, '
  'so the real shape of this value is unknown and nothing here assumes one.';
comment on column payment_mandate.wording_sha256 is
  'The sha256 of the disclosure the customer was actually shown, lowercase hex. The WORDS are not in this '
  'build - no mandate disclosure has been written or approved (Y9-mandate-wording) - so ZY422 refuses the hash of the empty '
  'string and a placeholder version marker rather than letting an unwritten disclosure read as agreed.';
comment on column payment_mandate.cap_fils is
  'The maximum this mandate authorises, per charge. A per-charge ceiling and not a running budget: '
  'mandateHeadroomFils in @berelax/core states that reading once so a screen cannot invent a different '
  'one. ZY424 holds every attempt to it.';

create index payment_mandate_customer_idx on payment_mandate (customer_id, agreed_at desc);
create index payment_mandate_trading_date_idx on payment_mandate (trading_date);

revoke update, delete, truncate on payment_mandate from berelax_app;

-- ------------------------------------------------------------------------------------------------
-- payment_mandate_revocation — the second act, as a second row
-- ------------------------------------------------------------------------------------------------

create table payment_mandate_revocation (
  mandate_id  uuid        primary key references payment_mandate (id),
  revoked_at  timestamptz not null,
  -- Who. `audit_event` holds the full actor record; this is the one field the charge path itself reads,
  -- because "the customer took it back" and "the front desk removed it" are answered differently when the
  -- customer asks why their card is no longer on file.
  revoked_by  text        not null
                constraint payment_mandate_revocation_actor_known
                check (revoked_by in ('customer', 'staff', 'gateway')),
  reason      text,
  created_at  timestamptz not null default now()
);

comment on table payment_mandate_revocation is
  'A revocation, as its own append-only row. The primary key IS the mandate id, so a mandate cannot be '
  'revoked twice - a second revocation would be a statement about an authority that no longer existed. '
  'UPDATE and DELETE raise ZY421: taking a revocation back is a NEW mandate, with a new disclosure and a '
  'new agreement, never an edit to the record of the customer having withdrawn.';

revoke update, delete, truncate on payment_mandate_revocation from berelax_app;

-- ------------------------------------------------------------------------------------------------
-- ZY421 — the mandate record and its revocation are append-only
-- ------------------------------------------------------------------------------------------------

-- ONE function for both tables because it is ONE rule, which is ADR 0043's own subject read the other
-- way round: one code may not stand for two rules, and two codes for one rule is the same drift mirrored.
create function refuse_mandate_record_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'MandateRecordIsAppendOnly: % on % is refused. A mandate row is EVIDENCE that a specific person was '
    'shown a specific disclosure and agreed to a specific maximum, and the cap it holds is the entire '
    'content of that agreement. Editing it would restate what somebody consented to with nothing left '
    'saying what they actually consented to. A mandate that is wrong is REVOKED and replaced; a '
    'revocation that is wrong is a new mandate.',
    tg_op, tg_table_name
    using errcode = 'ZY421';
end $$;

comment on function refuse_mandate_record_change() is
  'Raises ZY421 for every UPDATE and DELETE on payment_mandate and payment_mandate_revocation, for EVERY '
  'role including the owner. The remedy is always a new row.';

create trigger payment_mandate_no_update before update on payment_mandate
  for each row execute function refuse_mandate_record_change();
create trigger payment_mandate_no_delete before delete on payment_mandate
  for each row execute function refuse_mandate_record_change();
create trigger payment_mandate_revocation_no_update before update on payment_mandate_revocation
  for each row execute function refuse_mandate_record_change();
create trigger payment_mandate_revocation_no_delete before delete on payment_mandate_revocation
  for each row execute function refuse_mandate_record_change();

-- ------------------------------------------------------------------------------------------------
-- ZY422 — a mandate must name the disclosure it was agreed against
-- ------------------------------------------------------------------------------------------------

-- A trigger and not a CHECK, for 0117's reason inverted: the message has to name what is wrong with the
-- row and a CHECK violation names only the constraint. Three ways a mandate can claim an agreement that
-- did not happen, and all three have been seen in builds of this shape:
--
--   * the hash is not a hash — 64 lowercase hex or it is not sha256 output;
--   * the hash is the sha256 of the EMPTY STRING, which is what hashing an unwritten disclosure returns
--     and which balances every check that only looks at the shape;
--   * the version carries a placeholder marker (0026's `is_placeholder_text`), which is what arrives when
--     somebody wires the path up before the words exist.
create function assert_mandate_wording_is_on_file() returns trigger
language plpgsql
as $$
-- sha256 of the empty string. Spelled out because a mandate agreed against nothing hashes to exactly
-- this, and that row would otherwise satisfy every shape check in the file.
declare
  empty_sha constant text := 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
begin
  if new.wording_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception
      'MandateWordingHashIsNotAHash: payment_mandate.wording_sha256 must be 64 lowercase hexadecimal '
      'characters and is %. The hash is what makes "this customer was shown these words" checkable once '
      'the disclosure is written; a value that is not sha256 output makes the claim uncheckable while '
      'looking exactly as authoritative.',
      length(new.wording_sha256)
      using errcode = 'ZY422';
  end if;

  if new.wording_sha256 = empty_sha then
    raise exception
      'MandateWordingIsEmpty: payment_mandate.wording_sha256 is the sha256 of the empty string, so this '
      'mandate was agreed against no words at all. No card-on-file disclosure has been written or '
      'approved for this business (Y9-mandate-wording), and a mandate recorded against nothing '
      'is a consent record that proves the opposite of what it appears to prove.'
      using errcode = 'ZY422';
  end if;

  if is_placeholder_text(new.wording_version) then
    raise exception
      'MandateWordingIsPlaceholder: payment_mandate.wording_version carries a placeholder marker. A '
      'provisional disclosure version is indistinguishable from a configured one once it is in the row, '
      'which is why 0026 refuses placeholder text wherever a customer-facing fact is stored.'
      using errcode = 'ZY422';
  end if;

  return new;
end $$;

comment on function assert_mandate_wording_is_on_file() is
  'Raises ZY422 when a mandate claims an agreement against words that are not on file: a hash that is not '
  'sha256 output, the hash of the empty string, or a placeholder version marker.';

create trigger payment_mandate_wording_is_on_file
  before insert on payment_mandate
  for each row execute function assert_mandate_wording_is_on_file();

-- ------------------------------------------------------------------------------------------------
-- ZY423 — a mandate token reference may not be card-shaped
-- ------------------------------------------------------------------------------------------------

-- `is_card_shaped()` is 0117's and is CALLED, not restated: `scripts/check-saq-a.mjs` refuses a second
-- Luhn check or a second PAN pattern anywhere in the tree, because a second detector is a second policy
-- and the second one is the one that misses the spelling with spaces in it.
--
-- A SEPARATE function and a separate code from 0117's `ZY231`, rather than a branch added to
-- `refuse_card_shaped_payment_text()` by `create or replace`. The two are different rules over the same
-- shape: `ZY231` is about free text a PERSON TYPED into a payments column, and this one is about a value
-- a GATEWAY RETURNED. They differ in remedy — remove the digits, against change the integration — and
-- `create or replace` of a shipped function would also put that function's body in two migration files,
-- so the one that reads second silently wins.
--
-- The value is deliberately NOT in the message. A refusal that quoted it would write the number into the
-- log it was raised to keep it out of, which is also why this is a trigger rather than a CHECK: a CHECK
-- violation's DETAIL line prints the failing row.
create function refuse_card_shaped_mandate_token() returns trigger
language plpgsql
as $$
begin
  if is_card_shaped(new.token_reference) then
    raise exception
      'CardShapedMandateTokenRefused: payment_mandate.token_reference holds text shaped like a card '
      'number (a 13-to-19-digit Luhn-valid run) and the write is refused. A mandate is a RECORD THAT A '
      'MANDATE EXISTS AT A GATEWAY and never a stored instrument: under SAQ-A the card is entered inside '
      'the gateway''s cross-origin hosted fields and this build holds no primary account number anywhere '
      '(ADR 0067). The offending value is deliberately NOT in this message. If the gateway genuinely '
      'returns a handle of this shape, that is a decision about the integration and not an exemption here.'
      using errcode = 'ZY423';
  end if;
  return new;
end $$;

comment on function refuse_card_shaped_mandate_token() is
  'Raises ZY423 when a mandate token reference is card-shaped, using 0117''s is_card_shaped(). Names the '
  'column and never the value.';

create trigger payment_mandate_no_card_shaped_token
  before insert on payment_mandate
  for each row execute function refuse_card_shaped_mandate_token();

-- ------------------------------------------------------------------------------------------------
-- payment_mandate_status — the state, as a derivation over rows nobody has edited
-- ------------------------------------------------------------------------------------------------

-- ADR 0057's shape, one subject along from `appointment_deposit_balance`. A stored `state` column is the
-- dangerous alternative and the failure is specific: nothing runs at the instant a mandate expires, so a
-- stored state reads `active` for ever unless a job sweeps it, and the charge path would then read
-- `active` from a row whose authority lapsed in March.
--
-- Revocation beats expiry when both apply, which is `mandateStateAt`'s order in @berelax/core for the
-- same reason: the customer's own act is the stronger fact, and reporting a revoked mandate as merely
-- expired loses the one thing that changes what may be said to them next.
create view payment_mandate_status as
select m.id              as mandate_id,
       m.customer_id,
       m.gateway,
       m.cap_fils,
       m.wording_version,
       m.agreed_at,
       m.expires_at,
       r.revoked_at,
       case
         when r.revoked_at is not null and now() >= r.revoked_at then 'revoked'
         when now() >= m.expires_at                              then 'expired'
         else                                                         'active'
       end               as state
  from payment_mandate m
  left join payment_mandate_revocation r on r.mandate_id = m.id;

comment on view payment_mandate_status is
  'Each mandate''s state NOW, derived from its dates and its revocation row. A mandate with no row here '
  'is ABSENT rather than inactive: "this customer never gave a mandate" and "this customer gave one and '
  'revoked it" are different facts and the second one has rows.';

grant select on payment_mandate_status to berelax_app;

-- ------------------------------------------------------------------------------------------------
-- mandate_charge_attempt — every attempt, including the ones that were stopped
-- ------------------------------------------------------------------------------------------------

create table mandate_charge_attempt (
  id             uuid        primary key default uuid_generate_v7(),
  mandate_id     uuid        not null references payment_mandate (id),
  -- Plain uuid, NO foreign key, for `deposit_movement.appointment_id`'s reason: PostgreSQL refuses
  -- `truncate appointment` while a referencing table is absent from the statement and four suites
  -- truncate it by list (0055, 0058, 0021, 0024).
  appointment_id uuid        not null,

  -- Why the charge was attempted. A no-show and a late cancellation are judged by different people at
  -- different moments and a fee policy may one day treat them differently, so the record says which.
  reason         text        not null
                   constraint mandate_charge_attempt_reason_known
                   check (reason in ('no_show', 'late_cancellation')),

  requested_fils fils_nonneg not null
                   constraint mandate_charge_attempt_requested_positive check (requested_fils > 0),

  -- Exhaustive, and the refused outcomes are members rather than an absence: the acceptance lines are
  -- about refusals, and a refusal with no row is a refusal nothing can count.
  outcome        text        not null
                   constraint mandate_charge_attempt_outcome_known
                   check (outcome in ('refused_no_policy', 'refused_cap', 'refused_not_active', 'charged')),

  -- NULL for every refused attempt, and that pairing is checked: a refused attempt that named an intent
  -- would be claiming the gateway was reached, and a charged one with no intent would be money moving
  -- with nothing in the payments ledger behind it.
  payment_intent_id uuid references payment_intent (id),
  constraint mandate_charge_attempt_intent_is_a_charge check (
    (payment_intent_id is null) = (outcome <> 'charged')
  ),

  attempted_at   timestamptz not null,
  trading_date   date        not null references business_day (trading_date),
  created_at     timestamptz not null default now()
);

comment on table mandate_charge_attempt is
  'Every attempt to charge a fee against a mandate, including - especially - the ones the database '
  'stopped. "We tried to charge this customer and the system refused" is a fact an operator needs, and a '
  'refusal with no row is a refusal nothing can count. ZY424, ZY425 and ZY426 are the three refusals, and '
  'ZY426 means no row in this table can read `charged` while no fee policy is on file: that is the '
  'sentence "the charge path ships disabled" written where PostgreSQL enforces it rather than where a '
  'second call site would not read it. Append-only: UPDATE and DELETE raise ZY421, for every role '
  'including the owner - the same code as the mandate record''s, because the attempt log is evidence on '
  'exactly the same terms (ADR 0043).';

create index mandate_charge_attempt_mandate_idx on mandate_charge_attempt (mandate_id, attempted_at desc);
create index mandate_charge_attempt_appointment_idx on mandate_charge_attempt (appointment_id);
create index mandate_charge_attempt_outcome_idx on mandate_charge_attempt (outcome, trading_date);

revoke update, delete, truncate on mandate_charge_attempt from berelax_app;

create function refuse_charge_attempt_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'ChargeAttemptIsAppendOnly: % on mandate_charge_attempt is refused. An attempt is a record of what '
    'was tried and what the system answered; editing one would restate a refusal as a success, or the '
    'reverse, with nothing left saying which happened. A different outcome is a NEW attempt.',
    tg_op
    using errcode = 'ZY421';
end $$;

comment on function refuse_charge_attempt_change() is
  'Raises ZY421 for every UPDATE and DELETE on mandate_charge_attempt. Same rule and therefore the same '
  'code as the mandate record''s: the attempt log is evidence on exactly the same terms (ADR 0043).';

create trigger mandate_charge_attempt_no_update before update on mandate_charge_attempt
  for each row execute function refuse_charge_attempt_change();
create trigger mandate_charge_attempt_no_delete before delete on mandate_charge_attempt
  for each row execute function refuse_charge_attempt_change();

-- ------------------------------------------------------------------------------------------------
-- ZY424 / ZY425 / ZY426 — the three refusals, in the order that keeps all three reachable
-- ------------------------------------------------------------------------------------------------

-- The policy gate fires LAST, after the mandate has been found, read and measured against its cap. That
-- looks like the wrong order and is the whole reason the unit's other four acceptance lines are testable:
-- if `ZY426` ran first, every refusal would collapse into "no policy on file" and the cap rule and the
-- revocation rule would be code nobody had ever seen run (ADR 0003).
create function assert_charge_attempt_is_authorised() returns trigger
language plpgsql
as $$
declare
  m_cap        bigint;
  m_expires    timestamptz;
  m_revoked    timestamptz;
  m_state      text;
begin
  select m.cap_fils, m.expires_at, r.revoked_at
    into m_cap, m_expires, m_revoked
    from payment_mandate m
    left join payment_mandate_revocation r on r.mandate_id = m.id
   where m.id = new.mandate_id;

  -- The state AT THE ATTEMPT'S OWN INSTANT, never at `now()`. A revocation recorded after the attempt
  -- does not make the attempt retrospectively unauthorised, and an attempt replayed by an importer must
  -- be judged by the authority that was in force when it happened.
  m_state := case
               when m_revoked is not null and new.attempted_at >= m_revoked then 'revoked'
               when new.attempted_at >= m_expires                           then 'expired'
               else                                                              'active'
             end;

  if m_state <> 'active' and new.outcome <> 'refused_not_active' then
    raise exception
      'MandateNotActiveAtAttempt: mandate % was % at %, so this attempt may only be recorded as '
      'refused_not_active and is recorded as %. A revocation takes effect on the NEXT attempt and is '
      'never applied backwards to one that already succeeded - that would be a refund, with its own '
      'document and its own direction in the ledger.',
      new.mandate_id, m_state, new.attempted_at, new.outcome
      using errcode = 'ZY425';
  end if;

  if new.requested_fils > m_cap and new.outcome <> 'refused_cap' then
    raise exception
      'FeeExceedsMandateCap: mandate % authorises at most % fils and this attempt requests % fils, so it '
      'may only be recorded as refused_cap and is recorded as %. The cap is the entire content of the '
      'customer''s agreement, so a charge above it is refused rather than clamped: a silently reduced '
      'charge is a figure nobody decided, posted against a document claiming the customer agreed to it.',
      new.mandate_id, m_cap, new.requested_fils, new.outcome
      using errcode = 'ZY424';
  end if;

  if new.outcome = 'charged' and not cancellation_fee_policy_on_file() then
    raise exception
      'NoFeePolicyOnFile: a charge of % fils against mandate % is refused because no cancellation or '
      'no-show fee policy is on file. Y9-windows is open ("24h window; no fee charged, flagged only"), '
      'the owner has agreed no fee policy, and the business holds no merchant account. This is a REFUSAL '
      'and not a charge of zero fils: a zero would post, balance and report as a fee that had been '
      'correctly worked out to be nothing, and the figure would be in the books as a decision nobody '
      'made (ADR 0070). A no-show is FLAGGED and posts nothing at all.',
      new.requested_fils, new.mandate_id
      using errcode = 'ZY426';
  end if;

  return new;
end $$;

comment on function assert_charge_attempt_is_authorised() is
  'ZY425, ZY424 and ZY426 in that order, which is the reverse of the obvious one: the policy gate fires '
  'LAST so that the cap rule and the revocation rule stay reachable and testable while no policy exists. '
  'The mandate state is read at the ATTEMPT''s instant, never at now().';

create trigger mandate_charge_attempt_is_authorised
  before insert on mandate_charge_attempt
  for each row execute function assert_charge_attempt_is_authorised();

commit;
