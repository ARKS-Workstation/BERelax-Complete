-- 0015 — the one privileged path that may change a template's message class.
--
-- 0014 makes message_class immutable on a row. That leaves a real need unserved: a template
-- occasionally IS misclassified, and the answer cannot be "never fix it". The answer is that fixing
-- it produces a NEW VERSION whose variants start unapproved.
--
-- Doing it as a function rather than as a convention matters. A convention is three statements a
-- person runs in order, and the third one — resetting approval — is the one that gets skipped at
-- 9pm. Skipping it would let a template that is now promotional inherit the approval it was granted
-- as transactional, which is precisely the laundering the immutability rule exists to prevent.

begin;

create or replace function reclassify_template(
  p_template_key text,
  p_new_class    message_class,
  p_purpose      text
) returns uuid
language plpgsql as $$
declare
  v_current   message_template;
  v_new_id    uuid;
begin
  select * into v_current
  from message_template
  where template_key = p_template_key and is_current
  for update;

  if not found then
    raise exception 'No current template with key %', p_template_key
      using errcode = 'no_data_found';
  end if;

  if v_current.message_class = p_new_class then
    raise exception 'Template % is already %', p_template_key, p_new_class
      using errcode = 'restrict_violation';
  end if;

  update message_template set is_current = false where id = v_current.id;

  insert into message_template (template_key, version, message_class, purpose, is_current)
  values (p_template_key, v_current.version + 1, p_new_class, p_purpose, true)
  returning id into v_new_id;

  -- Bodies carry over; approval does not. The words may be identical and the permission is not.
  insert into message_template_variant
    (template_id, channel, locale, category, approval_state, customer_care_window,
     subject, body, variables, encoding, segments, cost_fils)
  select v_new_id, channel, locale, category, 'pending', customer_care_window,
         subject, body, variables, encoding, segments, cost_fils
  from message_template_variant
  where template_id = v_current.id;

  return v_new_id;
end;
$$;

comment on function reclassify_template(text, message_class, text) is
  'The only path that changes a template''s class. Creates a new version and resets every variant to '
  'pending, so an approval granted to a transactional template cannot be inherited by a promotional '
  'one carrying the same words.';

commit;
