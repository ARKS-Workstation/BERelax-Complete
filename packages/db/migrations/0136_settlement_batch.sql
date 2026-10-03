-- 0136 — the gateway payout, reconciled to the fils, where "to the fils" is a REFUSAL and not a report.
--
-- Y-PAY-09. ADR 0090 is the decision, `packages/core/src/payments/settlement.ts` is the arithmetic and
-- `packages/db/src/repositories/settlement.ts` is the write. What this file is for is the half that has to
-- hold when the caller is a `psql` prompt, a second importer written in a different worktree, or the same
-- importer after somebody widens a tolerance — and for this unit that half IS the unit, because every way
-- this process can go wrong leaves a perfectly balanced ledger behind.
--
-- ## Why the identity is in SQL as well as in TypeScript
--
-- `reconcileSettlementBatch` already returns four differences that must each be nought, and this file
-- states one of them again as `ZY442`. A second statement of a fact drifts, so the rule for writing one
-- is that the check holding the two equal arrives in the same commit: `packages/fixtures/src/settlement.itest.ts`
-- drives both sides through real transactions and the gate block refuses a tolerance in either.
--
-- The reason it is worth the second statement is the specific error available here. A settlement importer
-- that absorbs a difference produces an entry that BALANCES — debits equal credits, every time, because
-- the plug is on both sides — and the evidence is a slowly growing balance on `1030 Gateway clearing`
-- that ties to nothing and that nobody looks at until a year-end. ADR 0070 made the same argument about a
-- cost component: a zero substituted for an unknown is indistinguishable from a measured zero. A variance
-- absorbed by a tolerance is indistinguishable from no variance, and `ZY442` is what makes the absorption
-- impossible rather than discouraged.
--
-- ## Why a batch is POSTED or QUARANTINED and never both
--
-- The tempting shape is one batch row, an entry, and variance rows beside it for whatever did not tie —
-- "posted, with exceptions". It is refused, and `ZY443` is the refusal. A batch with an entry is a batch
-- the bank reconciliation treats as answered; a variance row beside it is a note nobody is obliged to
-- read. So the two states are exclusive: a posted batch has a journal entry and NO variance rows, and a
-- quarantined batch has at least one variance row and NO journal entry. Nothing is force-matched and
-- nothing is half-posted.
--
-- That is also what makes the acceptance line "an unmatched line is quarantined and alerted rather than
-- force-matched" checkable: `ZY446` requires the `audit_event` for a quarantined batch to have been
-- written in the SAME transaction, so a quarantine that nobody was told about cannot commit.
--
-- ## Why `content_sha256` is unique, and why re-import is a no-op rather than a refusal
--
-- The digest is of the BYTES the acquirer sent. `unique` on it is what makes a second import of one file
-- impossible — and the repository SELECTs on it first and answers `already_imported`, so the ordinary
-- re-import is a no-op and the unique violation is the backstop for two importers racing. A hash of the
-- parsed lines would have been wrong: two files whose lines differ only in order are the same settlement
-- and must be the same no-op, and two files that differ by a line nobody parsed are not — and only the
-- bytes can say so.
--
-- ## Why `settled_on` has no foreign key to `business_day`
--
-- An acquirer pays when it pays. A payout lands on a Friday the premises were shut, on a public holiday,
-- and on a date no trading session exists for — and `journal_entry.entry_date` deliberately has no key to
-- `business_day` for exactly that reason (ADR 0064: the journal must be able to record the rent for a
-- month containing days nothing happened on). `chargeback.trading_date` DOES have one, and the difference
-- is worth stating: a chargeback NOTICE is attributed to the trading day it arrived in because it belongs
-- in that day's card totals, while a payout is a bank movement that belongs to no session at all.
--
-- This is also the acceptance line about D+2. A capture on business day D keeps its trading date where
-- the capture put it; the settlement that pays it over two days later has its own date and touches no
-- revenue account, so there is no mechanism by which the payout could move a sale between business days.
-- Nothing in this file derives one date from the other, and no settlement delay is stated anywhere.
--
-- ## Where the tie accounts come from
--
-- `settlement_tie_account(kind)` is the SQL statement of `SETTLEMENT_LINE_TIE_ACCOUNT` in `@berelax/core`,
-- and `ZY445` holds every line to it. Two homes for one mapping, with the pairing suite holding them
-- equal — `tips_payable_account_code()` (0068) and `disputed_card_receipts_account_code()` (0135) are the
-- same arrangement one account each way, and they are CALLED here rather than having their codes retyped.
-- The reason the mapping is in SQL at all is `ZY445`'s predicate: a line that claimed to tie to a revenue
-- account would reconcile a payout against a sale, and the figure would be right.
--
-- Nothing here holds a fee rate, an interchange figure, an MCC, a gateway name or a settlement delay
-- (OPEN-QUESTIONS `Y7-gateway`, `Y7-mcc`, `Y7-card-fee`). The fee is whatever the file says, and the only
-- claim made about it is `ZY442`.
--
-- Seven codes of the band ZY441-ZY450. `ZY448`-`ZY450` are unused and are NOT registered: an entry for a
-- code no migration raises is what direction 3 of ADR 0043's gate refuses.
--
--   ZY441  a settlement batch, line and variance are append-only
--   ZY442  a posted batch's declared net equals the signed sum of its lines, to the fils
--   ZY443  a posted batch has an entry and no variance; a quarantined batch has a variance and no entry
--   ZY444  a line on a posted batch ties to a local figure exactly, and only a fee line ties to nothing
--   ZY445  a line's tie account is the one its kind declares
--   ZY446  a quarantined batch wrote its audit_event in the same transaction
--   ZY447  a variance of nought fils is not a variance

begin;

-- ------------------------------------------------------------------------------------------------
-- settlement_tie_account — the mapping, stated once in SQL
-- ------------------------------------------------------------------------------------------------

-- The account each line kind is RECONCILED AGAINST, which is not the account the batch entry posts to.
-- The entry reaches `1020`, `1030`, `6080` and the two reverse-charge accounts and nothing else; this
-- answers "what does a line of the acquirer's file claim about our books", which is what makes a one-fils
-- disagreement nameable.
--
-- `tips_payable_account_code()` and `disputed_card_receipts_account_code()` are CALLED, never retyped, so
-- re-coding either account is one edit rather than two that can disagree.
create function settlement_tie_account(p_kind text) returns text
  language sql immutable parallel safe
  as $$
    select case p_kind
             when 'capture'    then '1030'
             when 'refund'     then '1030'
             when 'chargeback' then disputed_card_receipts_account_code()
             when 'tip'        then tips_payable_account_code()
             when 'fee'        then '6080'
           end::text
  $$;

comment on function settlement_tie_account(text) is
  'The account a settlement line of this kind is reconciled AGAINST - the mirror of '
  'SETTLEMENT_LINE_TIE_ACCOUNT in @berelax/core, held equal to it by '
  'packages/fixtures/src/settlement.itest.ts. NOT where the batch entry posts: a payout is a cash '
  'movement and its entry reaches 1020, 1030, 6080 and the reverse-charge pair only. A tip ties to '
  'tips_payable_account_code() because the till already credited that liability - a settlement that '
  'credited it again would record one obligation twice - and ZY445 is what stops a line claiming to tie '
  'to revenue, which would reconcile a payout against a sale and be out by the whole of it.';

-- ------------------------------------------------------------------------------------------------
-- settlement_batch — one imported payout file
-- ------------------------------------------------------------------------------------------------

create table settlement_batch (
  id                 uuid        primary key default uuid_generate_v7(),

  -- The ACQUIRER's own reference for the payout. Free text and no shape asserted, for
  -- `chargeback.dispute_ref`'s reason: no gateway has been chosen and the format of a reference a vendor
  -- nobody picked will mint is not this build's to assume.
  batch_reference    text        not null
                       constraint settlement_batch_reference_nonempty
                       check (btrim(batch_reference) <> ''),

  -- The digest of the BYTES, lower-case hex. The whole of the re-import rule.
  content_sha256     text        not null
                       constraint settlement_batch_hash_is_sha256
                       check (content_sha256 ~ '^[0-9a-f]{64}$'),

  -- The day the acquirer paid. Deliberately NO reference to `business_day`: a payout lands on days the
  -- premises were shut, which is `journal_entry.entry_date`'s own decision (ADR 0064).
  settled_on         date        not null,

  -- SIGNED, both of them, and `bigint` rather than the `fils_nonneg` domain because of it. An acquirer
  -- BILLS the business in a period whose chargebacks exceed its captures, and a non-negative domain here
  -- would have made that batch unrecordable - or, worse, recordable with the sign dropped, which posts
  -- the same figure the other way round and balances.
  declared_net_fils  bigint      not null,
  lines_net_fils     bigint      not null,

  state              text        not null
                       constraint settlement_batch_state_known
                       check (state in ('posted', 'quarantined')),

  -- Null exactly when the batch is quarantined, and ZY443 is that biconditional. A real key when present:
  -- a posted batch with no entry behind it is a payout the bank reconciliation treats as answered and the
  -- ledger has never heard of.
  journal_entry_id   text        references journal_entry (entry_id),

  imported_at        timestamptz not null default now(),

  -- One batch per file, by content. A re-import is then a unique violation rather than a second posting,
  -- and the repository reads this column first so the ordinary case is a no-op and this is the backstop
  -- for two importers racing.
  constraint settlement_batch_one_per_file unique (content_sha256)
);

comment on table settlement_batch is
  'One imported gateway payout file. POSTED or QUARANTINED and never both (ZY443): a batch with an entry '
  'is one the bank reconciliation treats as answered, so a variance row beside it would be a note nobody '
  'is obliged to read. A posted batch''s declared net equals the signed sum of its lines to the fils '
  '(ZY442) - there is no tolerance and nowhere to add one, because a difference absorbed here produces an '
  'entry that BALANCES and a growing balance on 1030 that ties to nothing. Append-only (ZY441) for every '
  'role including the owner: a file imported wrongly is quarantined and re-imported under a new hash, '
  'never edited.';
comment on column settlement_batch.content_sha256 is
  'The digest of the BYTES the acquirer sent, not of the parsed lines. Two files whose lines differ only '
  'in order are the same settlement and must be the same no-op; two that differ by a line nobody parsed '
  'are not, and only the bytes can tell them apart.';
comment on column settlement_batch.settled_on is
  'The day the acquirer paid, from the file. No key to business_day, because a payout lands on days the '
  'premises were shut (ADR 0064) - and deliberately not derived from any capture''s trading date: this '
  'build holds no settlement delay and may not invent one.';
comment on column settlement_batch.declared_net_fils is
  'The net the FILE declares. Carried beside lines_net_fils precisely so the two can disagree: a '
  'difference belonging to no line is the unattributable variance, which is a refusal and never a zero '
  '(ADR 0070).';

create index settlement_batch_settled_idx on settlement_batch (settled_on desc, batch_reference);
create index settlement_batch_state_idx on settlement_batch (state, imported_at desc);

revoke update, delete, truncate on settlement_batch from berelax_app;

-- ------------------------------------------------------------------------------------------------
-- settlement_line — one line of the file, with the local figure it was matched against
-- ------------------------------------------------------------------------------------------------

create table settlement_line (
  id                 uuid        primary key default uuid_generate_v7(),
  batch_id           uuid        not null references settlement_batch (id),

  -- The line's position in the FILE, 1-based. Carried so a variance can name the offending line, which is
  -- what the acceptance line asks for: a reference alone cannot, because one reference legitimately
  -- appears on a capture line and a tip line of the same file.
  line_no            integer     not null
                       constraint settlement_line_no_positive check (line_no > 0),

  kind               text        not null
                       constraint settlement_line_kind_known
                       check (kind in ('capture', 'refund', 'chargeback', 'tip', 'fee')),

  reference          text        not null
                       constraint settlement_line_reference_nonempty
                       check (btrim(reference) <> ''),

  -- POSITIVE, always. The direction is the KIND, and a signed amount here would make `-500` and a refund
  -- of `500` two spellings of one fact — which is the arrangement where a sign dropped in one of the two
  -- places the totals are computed balances perfectly.
  amount_fils        fils_nonneg not null
                       constraint settlement_line_amount_positive check (amount_fils > 0),

  -- Where this line is reconciled against. Held to `settlement_tie_account(kind)` by ZY445 rather than
  -- left to the caller: a line claiming to tie to a revenue account would reconcile a payout against a
  -- sale and the figure would be right.
  tie_account_code   text        not null references account (code),

  -- What THIS BUILD holds for the same thing, as the importer read it. NULL means "no local record at
  -- all", which is not zero: a capture the acquirer reports and this build has never heard of is a line
  -- to quarantine, and a capture of nought fils is a malformed line. ADR 0070's distinction.
  local_fils         bigint,

  created_at         timestamptz not null default now(),

  constraint settlement_line_one_per_position unique (batch_id, line_no),
  -- The duplicate-line refusal, structural. Two lines about one movement cannot both be matched and
  -- summing both would double the amount, so the second is a unique violation rather than a judgement.
  constraint settlement_line_one_per_movement unique (batch_id, kind, reference)
);

comment on table settlement_line is
  'One line of an imported payout file, with the local figure it was matched against. amount_fils is '
  'POSITIVE and the direction is the kind (SETTLEMENT_LINE_PAYOUT_SIGN in @berelax/core); local_fils is '
  'NULL for "no local record", which is a different claim from a local nought and takes a different '
  'action. On a POSTED batch every line but a fee ties exactly (ZY444), and a fee ties to nothing because '
  'nothing in this build knows what an acquirer will charge and nothing may guess.';
comment on column settlement_line.local_fils is
  'What this build holds for the same movement. NULL is "nothing answers to this reference" - quarantined '
  'and alerted, never force-matched to the nearest payment of the same amount, which is a guess that '
  'posts perfectly and reconciles against the wrong invoice for ever.';

create index settlement_line_batch_idx on settlement_line (batch_id, line_no);
create index settlement_line_reference_idx on settlement_line (kind, reference);

revoke update, delete, truncate on settlement_line from berelax_app;

-- ------------------------------------------------------------------------------------------------
-- settlement_variance — the named variance, which is the only alternative to a tie
-- ------------------------------------------------------------------------------------------------

create table settlement_variance (
  id                 uuid        primary key default uuid_generate_v7(),
  batch_id           uuid        not null references settlement_batch (id),

  -- Null only for a batch-level variance, which is the `unattributable` kind: a residue that belongs to
  -- no line is a fact about the batch.
  settlement_line_id uuid        references settlement_line (id),

  kind               text        not null
                       constraint settlement_variance_kind_known
                       check (kind in ('amount_disagrees', 'no_local_record', 'duplicate_line',
                                       'amount_malformed', 'unattributable')),

  file_fils          bigint      not null,
  local_fils         bigint,
  -- NON-ZERO, and ZY447 says why: a variance of nought fils is not a variance, and a row carrying one
  -- would make `quarantined` a state a batch could reach with nothing wrong with it.
  difference_fils    bigint      not null,

  -- What a report shows an operator. A blank one is a blank row, which is the same lie as a missing one.
  explanation        text        not null
                       constraint settlement_variance_explanation_nonempty
                       check (btrim(explanation) <> ''),

  created_at         timestamptz not null default now(),

  constraint settlement_variance_line_only_for_a_line
    check ((settlement_line_id is null) = (kind = 'unattributable'))
);

comment on table settlement_variance is
  'The named alternative to a tie. Every settlement line either ties to a figure this build holds or has '
  'a row here, and a difference belonging to no line is the `unattributable` kind - which is a REFUSAL '
  'and never a zero (ADR 0070). A batch with any row here is quarantined and has no journal entry '
  '(ZY443), and its audit_event was written in the same transaction (ZY446), so a quarantine nobody was '
  'told about cannot commit.';

create index settlement_variance_batch_idx on settlement_variance (batch_id, kind);

revoke update, delete, truncate on settlement_variance from berelax_app;

-- ------------------------------------------------------------------------------------------------
-- ZY441 — all three tables are append-only
-- ------------------------------------------------------------------------------------------------

create function refuse_settlement_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'SettlementIsAppendOnly: % on %.% is refused. An imported payout file is EVIDENCE: the bytes an '
    'acquirer sent, the figures this build matched them against, and the entry or the quarantine that '
    'followed. Editing a line would restate what was matched after the entry had explained it, and '
    'deleting a batch would leave an entry with nothing it was about. A file imported wrongly is '
    're-imported - it has a different hash, so it is a different batch.',
    tg_op, tg_table_schema, tg_table_name
    using errcode = 'ZY441';
end $$;

comment on function refuse_settlement_change() is
  'Raises ZY441 for every UPDATE and DELETE on settlement_batch, settlement_line and '
  'settlement_variance, for EVERY role including the owner. One function for three tables because it is '
  'one rule; tg_table_name names which in the message.';

create trigger settlement_batch_no_update before update on settlement_batch
  for each row execute function refuse_settlement_change();
create trigger settlement_batch_no_delete before delete on settlement_batch
  for each row execute function refuse_settlement_change();
create trigger settlement_line_no_update before update on settlement_line
  for each row execute function refuse_settlement_change();
create trigger settlement_line_no_delete before delete on settlement_line
  for each row execute function refuse_settlement_change();
create trigger settlement_variance_no_update before update on settlement_variance
  for each row execute function refuse_settlement_change();
create trigger settlement_variance_no_delete before delete on settlement_variance
  for each row execute function refuse_settlement_change();

-- ------------------------------------------------------------------------------------------------
-- ZY445 / ZY447 — the per-row rules, checked immediately
-- ------------------------------------------------------------------------------------------------

-- Immediate rather than deferred: both are properties of the row alone, so there is no legal intermediate
-- state to tolerate, and a refusal at the INSERT names the statement that caused it.
create function assert_settlement_line_ties_to_its_kind() returns trigger
language plpgsql
as $$
declare
  v_expected text := settlement_tie_account(new.kind);
begin
  if new.tie_account_code is distinct from v_expected then
    raise exception
      'SettlementLineTiesToTheWrongAccount: line % of batch % is a "%" and claims to tie to %, and that '
      'kind ties to %. The mapping is settlement_tie_account() here and SETTLEMENT_LINE_TIE_ACCOUNT in '
      '@berelax/core, held equal by packages/fixtures/src/settlement.itest.ts. A line that claimed a '
      'revenue account would reconcile a payout against a SALE - and the figure would be right, which is '
      'why this is a refusal rather than a convention.',
      new.line_no, new.batch_id, new.kind, new.tie_account_code, v_expected
      using errcode = 'ZY445';
  end if;
  return new;
end $$;

comment on function assert_settlement_line_ties_to_its_kind() is
  'Raises ZY445 when a settlement line''s tie_account_code is not the one settlement_tie_account(kind) '
  'declares. The second statement of the mapping is deliberate and its pairing check ships in the same '
  'commit; what it buys is that a line cannot claim to tie to revenue.';

create trigger settlement_line_ties_to_its_kind
  before insert on settlement_line
  for each row execute function assert_settlement_line_ties_to_its_kind();

create function assert_settlement_variance_is_a_difference() returns trigger
language plpgsql
as $$
begin
  if new.difference_fils = 0 then
    raise exception
      'SettlementVarianceOfNought: a variance row for batch % claims a difference of 0 fils, which is '
      'not a variance. A row here quarantines the whole batch and withholds its entry, so a nought '
      'would stop a settlement that had nothing wrong with it - and, read the other way, it is the shape '
      'a tolerance takes when somebody writes one: the difference recorded and the batch treated as '
      'reconciled anyway (ADR 0070).',
      new.batch_id
      using errcode = 'ZY447';
  end if;
  return new;
end $$;

comment on function assert_settlement_variance_is_a_difference() is
  'Raises ZY447 for a variance row whose difference is nought. Not redundant with a CHECK: the message is '
  'the runbook answer, and ADR 0043 is about a refusal being identifiable by its code.';

create trigger settlement_variance_is_a_difference
  before insert on settlement_variance
  for each row execute function assert_settlement_variance_is_a_difference();

-- ------------------------------------------------------------------------------------------------
-- ZY442 / ZY443 / ZY444 / ZY446 — the batch's own identities, at COMMIT
-- ------------------------------------------------------------------------------------------------

-- DEFERRED, every one of them, and not as a precaution: the batch row, its lines, its variance rows, its
-- journal entry and its audit row are separate INSERT statements in one transaction, so an immediate
-- trigger would reject the legal sequence on the first statement (0124's reason, 0135's restatement).
create function assert_settlement_batch_reconciles() returns trigger
language plpgsql
as $$
declare
  v_batch_id    uuid;
  v_batch       settlement_batch;
  v_lines_net   bigint;
  v_variances   int;
  v_lines       int;
  v_untied      int;
  v_mismatched  int;
  v_fee_tied    int;
begin
  -- ONE function for three tables, because it is ONE claim: the batch's state, its line net, its ties and
  -- its variance rows are judged together. Driven from the children as well as from the parent, because a
  -- deferred trigger on the parent alone leaves the hole a second importer would find — insert the batch
  -- "posted", then insert a variance, and nothing re-judges the batch.
  --
  -- `tg_table_name` in an IF and not a CASE expression, for 0106's measured reason restated by 0135:
  -- plpgsql resolves every field reference in one expression and fails with "record new has no field" on
  -- whichever table lacks it.
  if tg_table_name = 'settlement_batch' then
    v_batch_id := new.id;
  else
    v_batch_id := new.batch_id;
  end if;

  select * into v_batch from settlement_batch where id = v_batch_id;
  -- Absent only if the whole transaction is being rolled back, in which case this never commits.
  if not found then return null; end if;

  -- The signed sum, over the rows, from the SAME partition the kind check admits. Written out here rather
  -- than read from a helper shared with the importer: a shared helper would make this check agree with
  -- the importer by construction, which is the one way it could not catch anything.
  select coalesce(sum(case l.kind
                        when 'capture'    then  l.amount_fils::bigint
                        when 'tip'        then  l.amount_fils::bigint
                        when 'refund'     then -l.amount_fils::bigint
                        when 'chargeback' then -l.amount_fils::bigint
                        when 'fee'        then -l.amount_fils::bigint
                      end), 0),
         count(*),
         count(*) filter (where l.kind <> 'fee' and l.local_fils is null),
         count(*) filter (where l.kind <> 'fee' and l.local_fils is not null
                                and l.local_fils <> l.amount_fils::bigint),
         count(*) filter (where l.kind = 'fee' and l.local_fils is not null)
    into v_lines_net, v_lines, v_untied, v_mismatched, v_fee_tied
    from settlement_line l
   where l.batch_id = v_batch_id;

  select count(*) into v_variances
    from settlement_variance v where v.batch_id = v_batch_id;

  if v_lines_net <> v_batch.lines_net_fils then
    raise exception
      'SettlementLinesNetDisagrees: batch % records a line net of % fils and its % line(s) sum to %. The '
      'stored figure is a cache of the rows and this holds the two equal, for the reason ZY163 holds '
      'payment_intent''s figures to its transactions: a header that could lie about its rows is a second '
      'source of truth, and the disagreement is found on a payout.',
      v_batch.batch_reference, v_batch.lines_net_fils, v_lines, v_lines_net
      using errcode = 'ZY442';
  end if;

  if v_batch.state = 'posted' then
    if v_batch.declared_net_fils <> v_lines_net then
      raise exception
        'SettlementDoesNotReconcile: batch % declares a net of % fils and its lines sum to %, a '
        'difference of % fils, and it is being POSTED. Reconciliation is to the fils: there is no '
        'tolerance and nowhere to add one. A difference absorbed here produces an entry that BALANCES - '
        'the plug is on both sides - and leaves a balance on 1030 Gateway clearing that ties to nothing '
        'and grows by a little every payout. A residue belonging to no line is a settlement_variance of '
        'kind "unattributable" and the batch is quarantined (ADR 0070, ADR 0090).',
        v_batch.batch_reference, v_batch.declared_net_fils, v_lines_net,
        (v_batch.declared_net_fils - v_lines_net)
        using errcode = 'ZY442';
    end if;

    if v_variances > 0 or v_batch.journal_entry_id is null then
      raise exception
        'SettlementIsPostedAndQuarantined: batch % is "posted" with % variance row(s) and journal entry '
        '%. The two states are exclusive. "Posted with exceptions" is the shape this refuses: a batch '
        'with an entry is one the bank reconciliation treats as answered, and a variance row beside it '
        'is a note nobody is obliged to read.',
        v_batch.batch_reference, v_variances, coalesce(v_batch.journal_entry_id, 'none')
        using errcode = 'ZY443';
    end if;

    -- Every line but a fee must tie EXACTLY; a fee must tie to nothing. Both directions, because both are
    -- refusals: a fee carrying a local figure is a figure this build invented, and a capture carrying
    -- none is a line that was posted without being matched.
    if v_untied > 0 or v_mismatched > 0 or v_fee_tied > 0 then
      raise exception
        'SettlementLineIsNotTied: batch % is "posted" with % line(s) matched to nothing, % line(s) whose '
        'figure disagrees with ours, and % fee line(s) carrying a local figure. A posted line ties to '
        'the fils or the batch is quarantined; a FEE ties to nothing at all, because nothing in this '
        'build knows what an acquirer will charge and a local figure for one would be a rate somebody '
        'invented (brief rule 15).',
        v_batch.batch_reference, v_untied, v_mismatched, v_fee_tied
        using errcode = 'ZY444';
    end if;

    return null;
  end if;

  -- Quarantined.
  if v_variances = 0 then
    raise exception
      'SettlementIsQuarantinedWithNoReason: batch % is "quarantined" and has no settlement_variance row. '
      'A quarantine with no named variance is a batch an operator cannot act on, which is the state ADR '
      '0070 is about: the difference exists either way, and only one of the two spellings of it can be '
      'investigated.',
      v_batch.batch_reference
      using errcode = 'ZY443';
  end if;

  if v_batch.journal_entry_id is not null then
    raise exception
      'SettlementIsQuarantinedAndPosted: batch % is "quarantined" and names journal entry %. A '
      'quarantined batch posts NOTHING: an entry would put the acquirer''s figures on the bank '
      'reconciliation while the variance that stopped the batch was still open.',
      v_batch.batch_reference, v_batch.journal_entry_id
      using errcode = 'ZY443';
  end if;

  -- ZY446. The alert, and it has to be in THIS transaction: an audit row written afterwards in a second
  -- transaction is not the same guarantee, because the quarantine can commit and the alert can fail —
  -- and the only evidence that a payout went unmatched would then be the payout (0093 ZZ004's argument).
  if not exists (select 1 from audit_event
                  where entity_type = 'settlement_batch'
                    and entity_id = v_batch.id::text
                    and action = 'settlement.quarantined') then
    raise exception
      'SettlementQuarantineNotAlerted: batch % reached COMMIT quarantined with no '
      'audit_event(action=settlement.quarantined, entity_type=settlement_batch, entity_id=%) in the same '
      'transaction. The acceptance line is "quarantined and ALERTED rather than force-matched", and a '
      'quarantine nobody was told about is the force-match with an extra step: the lines sit in a table '
      'and the money sits unexplained.',
      v_batch.batch_reference, v_batch.id
      using errcode = 'ZY446';
  end if;

  return null;
end $$;

comment on function assert_settlement_batch_reconciles() is
  'The batch''s four identities at COMMIT. ZY442: the stored line net equals the rows, and a POSTED '
  'batch''s declared net equals it too - to the fils, with no tolerance available. ZY443: posted and '
  'quarantined are exclusive, in both directions. ZY444: a posted line ties exactly and a fee ties to '
  'nothing. ZY446: a quarantine wrote its audit_event in the same transaction. Deferred, because the '
  'batch, its lines, its variances, its entry and its audit row are separate statements - and attached '
  'to the CHILD tables as well, because a trigger on the parent alone would let a variance inserted '
  'after the batch row commit a "posted" batch with an open exception.';

create constraint trigger settlement_batch_reconciles
  after insert on settlement_batch
  deferrable initially deferred
  for each row execute function assert_settlement_batch_reconciles();

create constraint trigger settlement_line_batch_reconciles
  after insert on settlement_line
  deferrable initially deferred
  for each row execute function assert_settlement_batch_reconciles();

create constraint trigger settlement_variance_batch_reconciles
  after insert on settlement_variance
  deferrable initially deferred
  for each row execute function assert_settlement_batch_reconciles();

commit;
