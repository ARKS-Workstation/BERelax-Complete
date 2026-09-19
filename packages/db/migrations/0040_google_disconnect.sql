-- 0040 — disconnect: the refresh token becomes erasable, and the ORDER is written into the schema.
--
-- docs/10 §5 states the offboarding step as one clause: *"disconnect in admin (revokes at Google and
-- zeroises the stored token)"*. Revoke first, zeroise second — and this file is what stops the two
-- halves being reordered or half-done later, because the ordering is the whole substance of the unit
-- and a comment does not survive a refactor.
--
-- The two half-failures, and which one this schema is built around:
--
--   * **Zeroise, then the revoke fails.** The grant is still live at Google and we have destroyed the
--     only credential that could kill it. Nothing in this system can recover: the token is gone, a new
--     consent mints a *different* grant, and the old one keeps full authority over the business's
--     Google presence — the scope that reads reviews also rewrites the address and the hours (§3).
--     That is unrecoverable, and `google_connections_revoke_retry_keeps_its_token` below makes it
--     unrepresentable.
--   * **Revoke, then the zeroisation fails.** A dead token sits encrypted at rest. Worse than nothing
--     and better than the above: the credential is worthless, the operation is idempotent (Google
--     answers a second revoke of the same token with `invalid_token`, which the code reads as
--     *already dead*), and the retry path simply runs again.
--
-- So: the five refresh-token columns become NULLABLE, because until now `refresh_token_ct not null`
-- made zeroisation impossible — the only way to "delete" a token was to overwrite it with another
-- ciphertext, which is not deletion. Three NAMED constraints then fence the new nullability:
--
--   1. `google_connections_refresh_token_complete` — five columns or none, the sibling of 0016's
--      `google_connections_access_token_complete`. A partial wipe is refused rather than leaving a row
--      whose ciphertext is present and whose wrapped key is gone: that row cannot be opened, cannot be
--      re-wrapped, and cannot be distinguished from corruption.
--   2. `google_connections_live_grant_has_a_refresh_token` — only a terminal status may hold no token.
--      `needs_reauth` is the state this protects: a connection whose grant looks dead to us may still
--      be live at Google (an `invalid_grant` on ONE refresh is not proof the grant is gone), and a
--      `needs_reauth` row with no ciphertext is a grant nothing can ever revoke.
--   3. `google_connections_revoke_retry_keeps_its_token` — a row parked in `revoke_failed` MUST still
--      carry its ciphertext. That is the retry's only credential. Zeroising it would turn a retryable
--      failure into the unrecoverable one above, silently, and the tempting "tidy up the tokens on
--      disconnected rows" migration is exactly how it would happen.
--
-- No column is added and no table is created: the disconnect state is `status='disconnected'` with
-- `status_reason` in ('manual','revoke_failed'), both of which 0016 already models. Disconnecting is a
-- status change, never a row delete — 0020 says so on `google_reviews.connection_id`, which is
-- ON DELETE RESTRICT precisely so that a review with a drafted reply cannot be cascaded away by an
-- offboarding.

begin;

-- Was NOT NULL since 0016, where the only writes were insert-a-consent and replace-a-consent and
-- nothing could legitimately erase a token. Dropping it is what makes zeroisation expressible.
alter table google_connections
  alter column refresh_token_ct drop not null,
  alter column refresh_token_nonce drop not null,
  alter column refresh_token_wrapped_key drop not null,
  alter column refresh_token_kid drop not null,
  alter column refresh_token_aad_fp drop not null;

-- 1. Five columns or none of them. The mirror of 0016's access-token check, and the reason a "wipe the
--    ciphertext but keep the kid for the audit trail" shortcut cannot be taken: a kid without a
--    ciphertext tells the re-wrap job there is something to move and gives it nothing to move.
alter table google_connections
  add constraint google_connections_refresh_token_complete check (
    (refresh_token_ct is null and refresh_token_nonce is null
      and refresh_token_wrapped_key is null and refresh_token_kid is null
      and refresh_token_aad_fp is null)
    or
    (refresh_token_ct is not null and refresh_token_nonce is not null
      and refresh_token_wrapped_key is not null and refresh_token_kid is not null
      and refresh_token_aad_fp is not null)
  );

-- 2. Only a terminal status may hold no refresh token. An `active` row with no credential is a
--    connection every consumer resolves and none can use; a `needs_reauth` row with no credential is a
--    grant that may still be live at Google and that nothing in this system can ever revoke.
alter table google_connections
  add constraint google_connections_live_grant_has_a_refresh_token check (
    refresh_token_ct is not null or status in ('disconnected', 'revoked')
  );

-- 3. The ordering rule, as a constraint. `revoke_failed` means *we marked it disconnected and Google
--    did not confirm the revocation*, so the stored ciphertext is the retry's only way to finish the
--    job. Erasing it is the unrecoverable half-failure; the database refuses it.
alter table google_connections
  add constraint google_connections_revoke_retry_keeps_its_token check (
    status_reason is distinct from 'revoke_failed' or refresh_token_ct is not null
  );

comment on column google_connections.refresh_token_ct is
  'Envelope-encrypted refresh token. NULLABLE since 0040: a disconnect revokes at Google and then '
  'zeroises all five columns together. NULL means there is no credential here, never that the grant '
  'was never stored — google_connection_events carries that history.';
comment on column google_connections.status_reason is
  'invalid_grant | scope_removed | manual | revoke_failed | testing_expiry | ... . 0040: manual is a '
  'completed disconnect (token revoked at Google and zeroised here); revoke_failed is a disconnect '
  'whose revocation Google did not confirm, so the ciphertext is retained for the retry and the '
  'constraint google_connections_revoke_retry_keeps_its_token enforces that.';

commit;
