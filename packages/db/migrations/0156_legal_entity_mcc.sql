-- 0156 — the merchant category code, recorded in writing or not at all.
--
-- Y-PAY-10. The acquirer's prerequisites for going live are an MCC confirmed in writing and a public site
-- carrying its required pages; neither exists. docs/05 names no acquirer, `Y7-mcc` is open, and
-- `PENDING['card-gateway']` is what the registry resolves `PAYMENT_PROVIDER=real` to today. So this
-- migration is a SHAPE and a REFUSAL, and three decisions make it one rather than a guess.
--
-- 1. **THE MCC IS NULL AND THERE IS NO DEFAULT.** A merchant category code decides which acquirer will
--    take this business at all, what it is charged, and — the part that matters here — what a cardholder's
--    bank statement says the money went to. Picking one would be this build deciding how a customer's
--    spa visit appears on a shared bank statement, which is a privacy consequence it has no standing to
--    choose. `legal_entity_mcc_is_not_a_placeholder` additionally refuses a provisional-looking value
--    through `is_placeholder_text()` (0026), so the column cannot be filled with a marker and then read
--    as configured (brief rule 15).
--
-- 2. **A CONFIRMATION IS THREE FACTS OR NONE.** `legal_entity_mcc_confirmation_is_whole` requires the
--    code, the instant and who recorded it to move together. An MCC with no `confirmed_at` is a number
--    somebody typed; a `confirmed_at` with no code is a confirmation of nothing; and either without a
--    recorder is a fact with nobody behind it — which is the one question an acquirer dispute asks.
--
-- 3. **ZY771 IS THE STRUCTURAL HALF OF THE GO-LIVE GATE, AND IT IS SCOPED TO THE GATEWAY.** The
--    application refuses `PAYMENT_PROVIDER=real` outside production (ADR 0005) and `createPaymentGateways`
--    refuses it again unless the MCC is confirmed, and both of those are code somebody can edit. This
--    trigger is the layer that holds when they are: a `payment_intent` against any gateway other than the
--    two this build ships cannot be recorded at all while `mcc_confirmed_at` is null.
--
--    SCOPED, and the scope is the whole reason it is safe. A blanket refusal would stop the manual till
--    adapter and the card fake — the only two payment paths that work today — so the rule names the two
--    gateways that are not a live acquirer and refuses everything else. A third gateway is therefore a
--    diff somebody has to justify, which is the difference between a gate and a convention.
--
-- **The statement descriptor is NOT a column here.** It is an F09 `app_setting` carrying
-- `provisional: true` against `Y7-descriptor`, because a provisional value has to be able to say that it
-- is one and reach the Unconfirmed Assumptions panel — which a column on this singleton cannot, since
-- `legal_entity` carries no provenance trio. The MCC reaches that panel through
-- `unconfirmedAssumptionRows`, which gains a branch for `mcc_confirmed_at is null` rather than relying on
-- `is_placeholder_text`: an absent value is not a placeholder, and the panel's existing singleton clause
-- would not have seen it.

alter table legal_entity
  add column mcc text,
  add column mcc_confirmed_at timestamptz,
  add column mcc_confirmed_by text;

comment on column legal_entity.mcc is
  'The acquirer''s merchant category code for this business, as four digits. NULL, and there is no '
  'default: an MCC decides what a cardholder''s bank statement says the money went to, which is a '
  'privacy consequence this build has no standing to choose. Y7-mcc.';

comment on column legal_entity.mcc_confirmed_at is
  'When the MCC was confirmed IN WRITING by the acquirer. NULL until it is. While it is null, ZY771 '
  'refuses a payment intent against any gateway but the manual till and the card fake, and '
  'createPaymentGateways refuses PAYMENT_PROVIDER=real.';

comment on column legal_entity.mcc_confirmed_by is
  'Who recorded the confirmation, as a label. Not a credential reference and never an invented name '
  '(ADR 0020): the question an acquirer dispute asks is who said so.';

alter table legal_entity
  add constraint legal_entity_mcc_is_four_digits
    check (mcc is null or mcc ~ '^[0-9]{4}$'),
  add constraint legal_entity_mcc_is_not_a_placeholder
    check (mcc is null or not is_placeholder_text(mcc)),
  add constraint legal_entity_mcc_confirmed_by_is_stated
    check (mcc_confirmed_by is null or btrim(mcc_confirmed_by) <> ''),
  add constraint legal_entity_mcc_confirmation_is_whole
    check (
      (mcc is null) = (mcc_confirmed_at is null)
      and (mcc is null) = (mcc_confirmed_by is null)
    );

-- ---------------------------------------------------------------------------------------------
-- `mcc_confirmed()` — one reading of the fact, for SQL and for the trigger
-- ---------------------------------------------------------------------------------------------
-- A function and not an inline subquery repeated in two places, for the reason `is_placeholder_text`
-- exists: a second spelling of "is the MCC on file" is a second answer the day one of them is reworded,
-- and the symptom would be a gate that is open on one path and shut on the other.
create or replace function mcc_confirmed()
returns boolean
language sql
stable
as $$
  select exists (select 1 from legal_entity where mcc_confirmed_at is not null)
$$;

comment on function mcc_confirmed() is
  'True when the singleton legal entity carries an MCC confirmed in writing. STABLE rather than '
  'IMMUTABLE because it reads a table, so it may not appear in a CHECK - which is why ZY771 is a '
  'trigger. One reading of the fact, for the trigger and for any report that needs it.';

-- ---------------------------------------------------------------------------------------------
-- ZY771 — a live gateway may not be reached until the MCC is on file
-- ---------------------------------------------------------------------------------------------
create or replace function refuse_intent_without_confirmed_mcc()
returns trigger
language plpgsql
as $$
begin
  -- The two gateways this build SHIPS. Anything else is an acquirer nobody has signed with, and the
  -- names are spelled here rather than read from a table because there is no table of gateways: there is
  -- one manual adapter and one fake, both constructed in packages/payments/src/registry.ts.
  if new.gateway in ('manual-till', 'fake-card-gateway') then
    return new;
  end if;
  if mcc_confirmed() then
    return new;
  end if;
  raise exception
    'A payment intent may not be recorded against gateway "%" while legal_entity.mcc_confirmed_at is '
    'null. An acquirer''s merchant category code arrives in one agreement with the pricing and the '
    'settlement terms, and none of the three exists (Y7-mcc, Y7-card-fee). The two gateways this build '
    'ships are the manual till and the card fake; a third is a live acquirer, and taking a card through '
    'one before the MCC is on file is how a transaction ends up categorised by whatever the processor '
    'assumed. Record the confirmation on legal_entity - the code, the instant and who said so - and this '
    'refusal lifts.',
    new.gateway
    using errcode = 'ZY771';
end;
$$;

comment on function refuse_intent_without_confirmed_mcc() is
  'ZY771. The structural half of the go-live gate: the config refusal and the registry refusal are both '
  'code somebody can edit, and this holds when they are. SCOPED to the gateway, because a blanket '
  'refusal would stop the manual till and the card fake - the only two payment paths that work today.';

create trigger payment_intent_needs_a_confirmed_mcc
  before insert on payment_intent
  for each row execute function refuse_intent_without_confirmed_mcc();
