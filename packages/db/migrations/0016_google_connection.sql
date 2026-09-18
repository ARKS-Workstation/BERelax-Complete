-- 0016 — the Google connection: one grant per Google account, not a singleton.
--
-- docs/10 §2. The brief assumed one grant. This models one-to-many, for a case that is ordinary in an
-- operating business: the account that owns the Business Profile listing is frequently NOT the account
-- verified on the Search Console property. The listing was claimed on one Gmail years ago, the website
-- was built by someone else. A singleton row discovers that on launch day and forces a reshape of the
-- most security-sensitive table in the system while it is live.
--
-- Three rules this file enforces rather than documents:
--
--   1. `google_sub` is the identity key. UNIQUE(google_sub), and NOTHING is unique on google_email —
--      an email address is a display label a user can change, and keying on it means a renamed Google
--      account silently becomes a second connection while the first keeps being refreshed.
--   2. Tokens are envelope-encrypted, never plaintext. The refresh token is a durable bearer
--      credential for control of the business's Google presence: the scope that reads reviews also
--      rewrites the address and opening hours. `refresh_token_kid` carries the KEK version so a key
--      rotation is a background re-wrap of a few dozen bytes per row, not a forced re-consent.
--   3. The event log is append-only and mirrored into audit_event in the same transaction. A
--      connection that broke and nobody can say when is the failure docs/07 §6 exists to design out.

begin;

-- One row per consented Google account.
create table google_connections (
  id                        uuid        primary key default uuid_generate_v7(),
  -- The stable subject from the id_token. THE identity key: matching sub on reconnect is a re-auth of
  -- this connection, a different sub is a new grant (G-CONN-02).
  google_sub                text        not null unique,
  -- Display only. Deliberately carries no unique index, no primary key and no single-row check: two
  -- active connections may share an email address, and the same address may return under a new sub.
  google_email              text        not null,
  -- What Google RETURNED, never what was requested. A consent screen where the owner unticks one
  -- product returns fewer scopes with an otherwise successful exchange, and storing the request would
  -- leave the system convinced it has an access it does not have.
  granted_scopes            text[]      not null,
  -- Envelope encryption, the same scheme as clinical payloads (0008): AES-256-GCM ciphertext, a
  -- per-row data key wrapped by the KEK, and the AAD fingerprint binding this ciphertext to this row
  -- so a token cannot be transplanted onto another connection even by someone who can UPDATE.
  refresh_token_ct          bytea       not null,
  refresh_token_nonce       bytea       not null,
  refresh_token_wrapped_key bytea       not null,
  -- NOT NULL on purpose: a row whose key version is unknown cannot be re-wrapped, so one nullable
  -- kid would make the rotation job unable to finish and unable to say why.
  refresh_token_kid         text        not null,
  refresh_token_aad_fp      text        not null,
  -- The cached access token: an hour of full authority over the listing, so it is encrypted too.
  access_token_ct           bytea,
  access_token_nonce        bytea,
  access_token_wrapped_key  bytea,
  access_token_kid          text,
  access_token_aad_fp       text,
  access_expires_at         timestamptz,
  -- The state of the GRANT. The vocabulary shown to a human is derived from this plus capability
  -- health and token age, and lives in one function in packages/core (docs/07 §6).
  status                    text        not null default 'active'
                              check (status in ('active','needs_reauth','revoked','disconnected')),
  -- invalid_grant | scope_removed | manual | testing_expiry | admin_policy_enforced | ... Left as free
  -- text because the set of reasons Google invents is not ours to close.
  status_reason             text,
  -- When consent was granted. Load-bearing while the OAuth consent screen is in Testing status: the
  -- refresh token dies seven days after THIS instant, and the settings panel shows that date rather
  -- than waiting for the bomb (docs/10 §4).
  consent_at                timestamptz not null default now(),
  -- Last successful authenticated call. "Connected" with no recency is exactly how silent failure hides.
  last_ok_at                timestamptz,
  last_checked_at           timestamptz,
  created_by                uuid,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  -- An access token is five columns or none of them. A half-written cache decrypts to a wrong-key
  -- error on a path nobody exercises until the token is actually needed.
  constraint google_connections_access_token_complete check (
    (access_token_ct is null and access_token_nonce is null and access_token_wrapped_key is null
      and access_token_kid is null and access_token_aad_fp is null and access_expires_at is null)
    or
    (access_token_ct is not null and access_token_nonce is not null and access_token_wrapped_key is not null
      and access_token_kid is not null and access_token_aad_fp is not null and access_expires_at is not null)
  )
);

comment on table google_connections is
  'One row per consented Google account. NOT a singleton: the account owning the Business Profile '
  'listing is frequently not the account verified on the Search Console property (docs/10 SS2).';
comment on column google_connections.google_sub is
  'The identity key. Never the email address, which a user can change.';
comment on column google_connections.google_email is
  'Display only. Intentionally not unique — two active connections may share it.';
comment on column google_connections.refresh_token_kid is
  'KEK version. Rotation is a background re-wrap of the wrapped data key, not a re-consent.';

create index google_connections_status_idx on google_connections (status);
-- The health check reads the least recently verified connection first, so a stale one is found in one
-- index scan rather than by walking the table.
create index google_connections_last_ok_idx on google_connections (last_ok_at nulls first);

create trigger google_connections_updated_at before update on google_connections
  for each row execute function set_updated_at();

-- What each connection can actually do, and against which Google resource.
--
-- Deliberately NOT unique on (connection_id, capability): one account may be verified on several
-- Search Console properties and manage several locations, so several rows share a capability and
-- exactly one of them is the primary. A unique (connection_id, capability) would model the wrong
-- business and make the primary flag meaningless.
create table google_capabilities (
  id            uuid        primary key default uuid_generate_v7(),
  connection_id uuid        not null references google_connections(id) on delete cascade,
  capability    text        not null
                  check (capability in ('gbp_reviews','gbp_location','gbp_performance','gsc')),
  -- {account, location, placeId} for Business Profile, {siteUrl} for Search Console. jsonb because
  -- the shape differs per capability and a column per API would be a migration per API.
  resource_ref  jsonb,
  -- Per-capability health, so "Google is connected but review replies are failing" is expressible.
  -- permission_missing is the launch-day normal: Business Profile access is granted by application
  -- review, not by enabling an API, so a valid token with zero quota is the expected state for weeks.
  health        text        not null default 'unknown'
                  check (health in ('ok','permission_missing','not_verified','quota_zero','unknown')),
  verified_at   timestamptz,
  -- `primary` is reserved in SQL, hence the prefix. This is the row a consumer gets when it asks for
  -- the capability without naming a resource.
  is_primary    boolean     not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table google_capabilities is
  'Many rows per (connection_id, capability) are legitimate — several GSC properties, several '
  'locations. At most one of them may be primary, enforced by a partial unique index.';

-- At most one primary per (connection_id, capability). A second primary would make "reply to this
-- review" ambiguous, and the ambiguity resolves differently per query plan — which is how a reply
-- reaches the wrong listing.
create unique index google_capability_one_primary
  on google_capabilities (connection_id, capability)
  where is_primary;

-- The same resource must not be registered twice under one capability. NULLS NOT DISTINCT so a second
-- resource-less row is caught too: without it, two 'gbp_reviews' rows with no resource_ref coexist and
-- the health check updates whichever one it happened to read.
create unique index google_capability_resource_unique
  on google_capabilities (connection_id, capability, resource_ref) nulls not distinct;

create index google_capabilities_connection_idx on google_capabilities (connection_id);

create trigger google_capabilities_updated_at before update on google_capabilities
  for each row execute function set_updated_at();

-- Append-only history of everything that happened to a connection.
create table google_connection_events (
  id            bigint      generated always as identity primary key,
  -- A plain uuid, deliberately NOT a foreign key — the same choice audit_event makes, for the same
  -- two reasons. An event may precede any connection row (a Workspace admin policy refusal happens at
  -- authorisation, before a token exists, and that is precisely the event somebody will go looking
  -- for). And an append-only log with a foreign key to a mutable table is a contradiction: the delete
  -- either fails or rewrites history, and history that a delete can rewrite is not history.
  connection_id uuid,
  google_sub    text,
  event         text        not null check (event in (
                  'connected','reconnected','refreshed','refresh_failed','reauth_required',
                  'revoked','disconnected','scopes_changed','capability_changed',
                  'health_check_ok','health_check_failed','token_rewrapped')),
  -- Mirrors audit_event's own vocabulary so the mirrored row is faithful rather than always 'system'.
  actor_kind    text        not null default 'system'
                  check (actor_kind in ('staff','customer','system','agent')),
  actor_label   text,
  detail        jsonb       not null default '{}'::jsonb,
  occurred_at   timestamptz not null default now(),
  -- A token must never appear in a row: rows reach query logs, pg_stat_statements, backups and
  -- pg-boss job payloads. The rule is worth a constraint rather than a code review, because the
  -- tempting debugging line is exactly `detail := jsonb_build_object('token', ...)` at 2am.
  constraint google_connection_events_no_token check (
    not (detail ?| array['refresh_token','access_token','refreshToken','accessToken','token'])
  )
);

comment on table google_connection_events is
  'Append-only: UPDATE and DELETE raise. Every insert is mirrored into audit_event in the same '
  'transaction, because a pg-boss job failure is not evidence of failure — nobody reads pgboss.job.';

create index google_connection_events_connection_idx
  on google_connection_events (connection_id, occurred_at desc);
create index google_connection_events_event_idx
  on google_connection_events (event, occurred_at desc);

-- Append-only, and it RAISES rather than silently doing nothing.
--
-- The older append-only tables here use `create rule ... do instead nothing`, which reports success
-- to the caller. For this table that is the wrong trade: the code that would UPDATE an event row is
-- code that believes it is correcting history, and it must be told it cannot rather than left
-- believing it did.
create or replace function refuse_google_connection_event_change() returns trigger
language plpgsql as $$
begin
  raise exception
    'google_connection_events is append-only; % is refused. Append a new event instead.', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger google_connection_events_no_update
  before update on google_connection_events
  for each row execute function refuse_google_connection_event_change();

create trigger google_connection_events_no_delete
  before delete on google_connection_events
  for each row execute function refuse_google_connection_event_change();

-- Mirrored into the global audit log, in the same transaction as the event.
--
-- Two logs for one fact is not duplication: this table is what the owner's connection panel renders,
-- audit_event is what an investigation reads across every entity in the system. A mirror written by
-- the application would be skipped on exactly the path that matters — the error path.
create or replace function mirror_google_connection_event() returns trigger
language plpgsql as $$
begin
  insert into audit_event (
    occurred_at, actor_kind, actor_label, action, entity_type, entity_id, operation, after_state
  ) values (
    new.occurred_at,
    new.actor_kind,
    new.actor_label,
    'google_connection.' || new.event,
    'google_connection',
    -- The sub when there is no connection row yet, so the event is still findable by identity.
    coalesce(new.connection_id::text, new.google_sub),
    'create',
    new.detail
  );
  return null;
end;
$$;

create trigger google_connection_events_mirror_audit
  after insert on google_connection_events
  for each row execute function mirror_google_connection_event();

commit;
