-- 0035 — the message row, its status lifecycle, and the delivery receipts that drive it.
--
-- B-MSG-01 gave the template a class, an encoding and a cost. B-MSG-02 gave the system one send choke
-- point and recorded nothing: every outcome was a returned value plus a provider call log, which is
-- enough to prove a decision and not enough to answer "did that reminder arrive?". This is the row.
--
-- ## Why the lifecycle is OURS and the vendor's vocabulary is only a column
--
-- The vendors are fixed — RESEND for email, SMSALA for SMS — and their status words are not ours to
-- choose: SMSala reports accepted / delivered / failed / expired / rejected, Resend reports delivered /
-- bounced / complained / opened, and a third vendor would report a fourth vocabulary. So `status` is a
-- four-value enum this system defines, `vendor_status` keeps the vendor's own word verbatim beside the
-- mapping it produced, and changing vendor is a change to the mapping table in
-- packages/messaging/src/transports and to nothing else. Storing the vendor's word as the status would
-- put every report, every badge and every query in the vendor's vocabulary, and the day the contract
-- moves is the day they all have to be rewritten at once.
--
-- An unrecognised vendor status maps to NULL, is recorded with applied = false and
-- ignored_reason = 'vendor_status_unrecognised', and changes nothing. It must never become 'delivered':
-- the whole value of a delivery receipt is that 'delivered' means the handset acknowledged the message,
-- and a vocabulary we do not recognise is precisely the case where we do not know.
--
-- ## Why the no-regression rule is a trigger and not a convention
--
-- A DLR is a webhook. Webhooks arrive out of order, arrive twice, and arrive from a retry queue hours
-- late. The delivered receipt overtaking the accepted one is the normal case, not the exotic one, and
-- the obvious write — `update message set status = $1` — silently turns a delivered message back into a
-- sent one, which is a message the reminder audit then says never landed. The rank function orders the
-- four states once, `refuse_message_status_regression` refuses any UPDATE that lowers it, and the
-- repository's UPDATE carries the same predicate so an out-of-order receipt is a no-op rather than an
-- error. Two layers on purpose: the repository makes the normal case quiet, the trigger makes every
-- other writer — a migration, a psql session at 2am, a future worker — obey it too.
--
-- 'delivered' and 'failed' share the top rank, so the first terminal state wins and the second is
-- recorded and ignored. A message that reached the handset cannot be un-delivered by a late expiry
-- notice, and a message the vendor rejected cannot be talked into having arrived.

begin;

-- Four states, and deliberately only four: this is what a person reads in the inbox and what a report
-- groups by. Every vendor nuance lives in message_delivery_receipt.vendor_status, where it can be read
-- without teaching the rest of the system a second vocabulary.
create type message_status as enum ('queued', 'sent', 'delivered', 'failed');

-- The lifecycle order, as one function rather than as a CASE repeated in a trigger and a query.
--
-- IMMUTABLE and not STABLE: the answer depends on nothing but the argument, which is what lets it be
-- used in an index predicate later if the inbox ever needs one.
create or replace function message_status_rank(p_status message_status) returns integer
language sql immutable as $$
  select case p_status
           when 'queued' then 0
           when 'sent' then 1
           -- Equal, so neither can displace the other: the first terminal receipt wins.
           when 'delivered' then 2
           when 'failed' then 2
         end;
$$;

create table message (
  id                   uuid            primary key default uuid_generate_v7(),
  -- The version that was sent, not the current one. reclassify_template (0015) creates a new version
  -- rather than editing a row, and a message has to keep pointing at the words and the class it
  -- actually left with — which is also why this is ON DELETE RESTRICT: a sent message is evidence.
  template_id          uuid            not null references message_template(id) on delete restrict,
  channel              message_channel not null,
  -- Copied from the template at send time and never recomputed. The frequency cap counts promotional
  -- messages, and a later reclassification must not retroactively move a message into or out of that
  -- count — the cap describes what was sent, not what the template says today.
  message_class        message_class   not null,
  locale               text            not null check (locale in ('en', 'ar')),
  -- Which vendor's status vocabulary a receipt on this row is written in. A closed set, because a row
  -- whose vendor is a typo is a row whose receipts cannot be interpreted at all.
  vendor               text            not null check (vendor in ('smsala', 'resend')),
  -- E.164 for sms, an address for email. Masked at render: the inbox is screenshotted.
  recipient            text            not null,
  -- The registered sender identity the message left from (sms only). Null for email, which has a
  -- from-address rather than a TDRA registration.
  sender_id            text,
  subject              text,
  body                 text            not null,
  -- The HTML part, exactly as the provider was given it, so the inbox preview pane shows what was
  -- sent rather than a re-render of it. Email only.
  body_html            text,
  encoding             text            not null check (encoding in ('GSM-7', 'UCS-2')),
  segments             smallint        not null check (segments >= 0),
  cost_fils            fils_nonneg     not null,
  status               message_status  not null default 'queued',
  provider_message_id  text,
  attempts             integer         not null default 0 check (attempts >= 0),
  last_failure_reason  text,
  last_failure_detail  text,
  -- When the retry policy says the next attempt may run. Null when nothing is scheduled.
  next_attempt_at      timestamptz,
  queued_at            timestamptz     not null default now(),
  sent_at              timestamptz,
  delivered_at         timestamptz,
  failed_at            timestamptz,
  created_at           timestamptz     not null default now(),
  updated_at           timestamptz     not null default now(),

  -- One vendor id, one message. The DLR handler finds its row by (vendor, provider_message_id), so two
  -- rows sharing one id would send a receipt to an arbitrary one of them — and the symptom is a
  -- delivered flag on a message that was never sent.
  constraint message_provider_id_unique unique (vendor, provider_message_id),

  -- 'sent' means a vendor accepted it and returned an id. Without this a delivered row with no
  -- provider id is storable, which is exactly what a receipt applied to the wrong row looks like.
  constraint message_sent_requires_acceptance check (
    status not in ('sent', 'delivered') or (provider_message_id is not null and sent_at is not null)
  ),
  -- Nothing leaves the system without a counted attempt. This is the constraint behind docs/12 §1's
  -- rule that a stub must never look like it worked: a row that claims to have been sent with zero
  -- attempts is a send path that never called a transport.
  constraint message_sent_counts_an_attempt check (status = 'queued' or attempts >= 1),
  -- A failure with no reason is a failure nobody can act on.
  constraint message_failed_requires_reason check (
    status <> 'failed' or last_failure_reason is not null
  ),
  -- Four transport failures — the message did not leave — plus one delivery failure: it left, a vendor
  -- accepted it, and the network later said it did not arrive. Kept apart because a rate limit and an
  -- absent subscriber are two completely different pieces of work for whoever reads the report, and
  -- closed rather than free text because this column is what a failure breakdown groups by.
  -- MESSAGE_ROW_FAILURE_REASONS in packages/shared/src/messaging.ts is the same list.
  constraint message_failure_reason_known check (
    last_failure_reason is null or last_failure_reason in (
      'provider_rejected',
      'provider_rate_limited',
      'provider_unavailable',
      'provider_error',
      'delivery_reported_failed')
  ),
  constraint message_failed_at_iff_failed check ((status = 'failed') = (failed_at is not null)),
  constraint message_delivered_at_iff_delivered check (
    (status = 'delivered') = (delivered_at is not null)
  ),
  -- A pending retry on a message that already reached its recipient would send it again. The retry
  -- schedule belongs to a queued row and to nothing else.
  constraint message_retry_only_while_queued check (next_attempt_at is null or status = 'queued'),
  -- Segments are an SMS billing unit. An email billed by segment is the Arabic-SMS arithmetic
  -- (70 characters to a segment, not 160) applied to a channel that is not billed that way at all,
  -- and it would land in the same cost report.
  constraint message_segments_billed_on_sms_only check (
    case when channel = 'sms'
      then segments >= 1 and cost_fils >= 1
      else segments = 0 and cost_fils = 0
    end
  ),
  -- Resend requires both parts: an HTML-only transactional email is a deliverability problem, and a
  -- subject line is what makes the message findable afterwards.
  constraint message_email_carries_both_parts check (
    (channel = 'email') = (subject is not null and body_html is not null)
  )
);

comment on table message is
  'One outbound message, from the moment the send choke point accepted it to its terminal state. The '
  'status vocabulary is ours; the vendor''s own word lives on each receipt.';
comment on column message.status is
  'queued -> sent -> delivered | failed, and never backwards: refuse_message_status_regression '
  'enforces it, because an out-of-order DLR is the normal case for a webhook.';

create trigger message_updated_at before update on message
  for each row execute function set_updated_at();

-- The inbox reads newest first, and every send is visible in it.
create index message_inbox_idx on message (queued_at desc);
-- The retry sweep: only the rows that have a next attempt due.
create index message_due_retry_idx on message (next_attempt_at) where next_attempt_at is not null;
-- Cost per template and per day.
create index message_template_cost_idx on message (template_id, sent_at);
-- The frequency cap: promotional messages to one recipient inside a window.
create index message_recipient_window_idx on message (recipient, message_class, queued_at desc);

create or replace function refuse_message_status_regression() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status
     and message_status_rank(new.status) <= message_status_rank(old.status) then
    raise exception
      'message_status_must_not_regress: % -> % on message %. A delivery receipt arriving out of '
      'order, or twice, must not move a message backwards or overwrite a terminal state.',
      old.status, new.status, old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger message_status_must_not_regress
  before update of status on message
  for each row execute function refuse_message_status_regression();

-- Every receipt, including the ones that changed nothing.
--
-- A receipt that is discarded silently is a receipt nobody can use to explain why a message says
-- 'sent' three days later. So an out-of-order one, a duplicate that survived the replay guard, a
-- vendor status we do not recognise and Resend's 'opened' are all recorded with applied = false and
-- the reason they were not applied. There is no audit_event mirror: this is vendor telemetry rather
-- than a human action, and audit_event answers "who did that".
create table message_delivery_receipt (
  id             uuid           primary key default uuid_generate_v7(),
  -- RESTRICT, not CASCADE: the receipt is the evidence for the status, and a test that tried to clean
  -- up by deleting the message would be deleting the evidence. Narrow what a reader can see instead.
  message_id     uuid           not null references message(id) on delete restrict,
  vendor         text           not null check (vendor in ('smsala', 'resend')),
  -- The vendor's own word, verbatim. This is the column a vendor change reads differently.
  vendor_status  text           not null check (vendor_status <> ''),
  -- What our lifecycle made of it. NULL when the vendor sent a word we do not recognise.
  mapped_status  message_status,
  applied        boolean        not null,
  ignored_reason text           check (ignored_reason in (
                                  'vendor_status_unrecognised',
                                  'status_would_not_advance',
                                  'vendor_status_carries_no_lifecycle_change')),
  -- The vendor's free text: 'Absent subscriber', 'Mailbox does not exist'.
  reason         text,
  occurred_at    timestamptz    not null,
  received_at    timestamptz    not null default now(),

  -- The replay guard. A vendor that delivers the same webhook three times — which both of ours do on
  -- a 2xx it did not see — produces one row, and the second and third INSERTs conflict on this rather
  -- than adding two more receipts and three status transitions.
  constraint message_delivery_receipt_replay_unique unique (message_id, vendor_status, occurred_at),
  -- An applied receipt has a mapping and no excuse; an ignored one has an excuse and no mapping to
  -- apply. Without this, applied = true with mapped_status null is storable, and it reads as a
  -- transition nobody can name.
  constraint message_delivery_receipt_applied_needs_mapping check (
    (applied and mapped_status is not null and ignored_reason is null)
    or (not applied and ignored_reason is not null)
  )
);

comment on table message_delivery_receipt is
  'Every delivery receipt a vendor sent, with the vendor''s own status word and what our lifecycle '
  'made of it. Append-only: UPDATE and DELETE raise, because a receipt is the evidence for a status '
  'and a corrected receipt is a new receipt.';

create index message_delivery_receipt_message_idx
  on message_delivery_receipt (message_id, occurred_at);

create or replace function refuse_message_receipt_change() returns trigger
language plpgsql as $$
begin
  raise exception
    'message_delivery_receipt is append-only; % is refused. A vendor that corrects itself sends '
    'another receipt.', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger message_delivery_receipt_no_update
  before update on message_delivery_receipt
  for each row execute function refuse_message_receipt_change();

create trigger message_delivery_receipt_no_delete
  before delete on message_delivery_receipt
  for each row execute function refuse_message_receipt_change();

commit;
