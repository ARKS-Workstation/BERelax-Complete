-- 0101 — the register of every private document, and the fetch that cannot be replayed or lost.
--
-- W-SYS-14. Every statutory document this build writes was written to a path a caller chose:
-- `writeTaxDocumentPdf()` in `@berelax/pdf` takes a `path` and calls `writeFileSync`, so a filed tax
-- invoice — the issuer TRN, the customer, every line and every figure — is readable by anybody who learns
-- the path, and nothing anywhere records a read. Private storage was DEFERRED by M-TILL-12 to M-TILL-13 and
-- M-VAT-11, both of which are now `done` and neither of which ever owned storage, so the capability was
-- owed by nobody.
--
-- Two tables. `private_document` is the register: one row per document that exists in the private bucket,
-- with the class that decides who may read it and the content hash that says which bytes it is.
-- `private_document_fetch` is the record that a copy left the business: one row per authorised fetch,
-- written in the SAME transaction as the authorisation, which is what makes "a download the trail is
-- missing" unrepresentable rather than unlikely.
--
-- ## Why the register is a table and not a column on each producer's row
--
-- The alternative was a `storage_key` and a `content_hash` on `tax_document`, on `vat_return`, on a payslip
-- table and on `obligation_evidence` — which is what `obligation_evidence` already is, and it is why this
-- unit exists. Five producers each with their own private path is five routes, five permission checks and
-- five chances that the sixth producer has none; the deferral chain in the manifest is what that looks like
-- after three units. One register means one route, one permission check read out of the authorisation
-- matrix, and one audit action, and it means the question "what private documents does this business hold"
-- has an answer that is a SELECT rather than a survey.
--
-- ## Why there is no `bucket` column
--
-- Every row here is in the private bucket by definition. A column able to say `public` is a column somebody
-- sets to `public` — and the bucket split is a security boundary rather than an organisational one
-- (docs/08 §6), so the storable value that would be wrong is the whole of the failure. The port refuses to
-- SIGN a public object for the same reason (`[signing-a-public-object]`), which is the other half.
--
-- ## The three refusals, and the layer each one is the only layer for
--
--   * **`ZY111` — a single-use document was fetched twice.** A payslip and a clinical extract are
--     `single_use`: there is no legitimate reason for one link to yield two copies of somebody's wage or
--     their treatment history, and the replay is the whole of how a forwarded link becomes a leak. This is
--     the one place the check can live. A read-then-insert in TypeScript is TWO statements, and two
--     concurrent fetches of one link both pass the read — so the defence has to be inside the same
--     statement as the write, under a lock. The trigger takes `for update` on the register row before it
--     looks, which serialises the fetches of one document; that is 0023's row-locked counter, used as a
--     mutex rather than as a sequence.
--   * **`ZY112` — the register or the fetch log was rewritten.** Both are append-only, and for the same
--     reason stated twice: the audit row names the content HASH, so a register row whose storage key could
--     be repointed would make an audited download name bytes that were never served, and a fetch log that
--     could be edited is not a record of anything. UPDATE and DELETE raise on both.
--   * **`ZY113` — the document class is not one this build knows.** Deny-by-default fails in the WRONG
--     DIRECTION without it: an unclassified document has no permission mapped to it, so it is a document
--     nobody can ever fetch and nobody can ever notice is unfetchable. The closed set is
--     `PRIVATE_DOCUMENT_CLASSES` in `@berelax/core`, restated here where SQL can read it — the one figure in
--     this file that exists in two places, and gate case 129j holds the two equal behaviourally rather than
--     trusting them, which is 0098's arrangement for `settings:write`.
--
-- `ZY111`-`ZY113` from the range this unit was allocated (`ZY111`-`ZY120`); `ZY114` through `ZY120` are
-- unused. Three codes and not one because each has a different runbook answer, which is 0061's argument for
-- having a private code at all: `ZY111` is "mint a new link", `ZY112` is "you cannot — the record stands",
-- `ZY113` is "add the class to the catalogue and to this function, in one commit". A code is identified by
-- all five characters and comes from `packages/db/src/sqlstate-registry.ts` (ADR 0043); the class identifies
-- nothing.
--
-- ## Why the fetch log is not `audit_event`
--
-- It writes an `audit_event` too, in the same transaction, and the two are not redundant. `audit_event` is
-- partitioned, append-only and read by several roles, and its `after` payload is JSON — so "has this nonce
-- been burned" would be a JSON containment query against a partitioned table on the hot path of every
-- download, and the uniqueness the replay defence needs cannot be a constraint on a JSON field at all. This
-- table is the CONSTRAINT; the audit row is the narrative.

begin;

-- ---------------------------------------------------------------------------------------------
-- The class predicate
-- ---------------------------------------------------------------------------------------------
-- `case` rather than `and`, which is 0080's finding and 0087's and 0098's restatement of it: SQL does not
-- guarantee the evaluation order of `and`, so a shape test and a value test in one expression can evaluate
-- in either order.
--
-- NOT strict, for `is_placeholder_text`'s reason: a strict function returns NULL for NULL, and a CHECK whose
-- expression is NULL is SATISFIED — so a strict version would accept every NULL it exists to refuse.
create function private_document_class_is_known(p_document_class text) returns boolean
language sql
immutable
as $$
  select case
           when p_document_class is null then false
           -- The closed set, and it is `PRIVATE_DOCUMENT_CLASSES` in
           -- packages/core/src/documents/private-document.ts. Held equal behaviourally by gate case 129j,
           -- which reads this function's answer for every class the catalogue declares AND for a class it
           -- does not — because a function that answered `true` for everything would satisfy the first half.
           else p_document_class in (
             'tax_invoice',
             'tax_credit_note',
             'vat_return_snapshot',
             'payslip',
             'clinical_extract',
             'compliance_evidence'
           )
         end;
$$;

comment on function private_document_class_is_known(text) is
  'True only for a private document class @berelax/core declares. An unclassified document has no '
  'permission mapped to it, so it is one nobody can fetch and nobody can notice is unfetchable — which is '
  'why an unknown class is refused at the write rather than denied at the read. NOT strict: a strict '
  'function returns NULL for NULL and a CHECK whose expression is NULL is satisfied.';

-- ---------------------------------------------------------------------------------------------
-- The register
-- ---------------------------------------------------------------------------------------------
create table private_document (
  id uuid primary key default gen_random_uuid(),
  document_class text not null,
  /*
    The key inside the PRIVATE bucket. Never in a URL and never in an audit row.

    The signature is over the document id and its class, not over this: a signed storage key would put a
    private-bucket path into a link, and `scripts/check-media.mjs` refuses a private origin appearing in
    source precisely so that no path into that bucket ever travels.
  */
  storage_key text not null,
  content_sha256 text not null,
  bytes integer not null,
  /*
    The media type the bytes were stored as, recorded and deliberately NOT served.

    The route answers `application/octet-stream` with an attachment disposition whatever this says: a filed
    document may be a PDF the renderer produced or a scan an inspector handed over, and rendering an
    untrusted upload inline in the admin origin is the stored-XSS path a Content-Disposition closes. Stored
    anyway because "what did we file" is a question about the object.
  */
  content_type text not null,
  /*
    Whether one link may be followed twice — `replayable` or `single_use`.

    Derived from the class by `@berelax/core` and stored on the row, and the redundancy is deliberate for a
    reason the other derived columns in this schema do not have: the replay check runs inside a trigger, SQL
    cannot read the catalogue, and a trigger that had to join to a second table to learn the policy would be
    a trigger whose answer depended on a row somebody could change. The CHECK below ties it to the class, so
    a row claiming a payslip is replayable is unstorable rather than merely unlikely.
  */
  use_policy text not null,
  /** What this document is ABOUT, so the register can be read by subject rather than only by id. */
  subject_kind text not null,
  subject_id text not null,
  created_at timestamptz not null default now(),
  /** The label of whoever or whatever registered it. Text, not a credential reference — 0075's reason. */
  registered_by text not null,
  constraint private_document_class_is_known
    check (private_document_class_is_known(document_class)),
  constraint private_document_use_policy_matches_class
    check (
      use_policy = case
                     when document_class in ('payslip', 'clinical_extract') then 'single_use'
                     else 'replayable'
                   end
    ),
  -- Blank-hostile rather than merely NOT NULL: `''` is how a required field arrives from a form, a job or a
  -- migration that did not require it, and `btrim` catches the single space somebody types to get past it.
  constraint private_document_storage_key_is_stated check (btrim(storage_key) <> ''),
  constraint private_document_storage_key_is_relative
    check (storage_key not like '/%' and storage_key not like '%..%'),
  constraint private_document_hash_is_a_sha256 check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint private_document_bytes_are_positive check (bytes > 0),
  constraint private_document_subject_is_stated
    check (btrim(subject_kind) <> '' and btrim(subject_id) <> ''),
  constraint private_document_registered_by_is_stated check (btrim(registered_by) <> ''),
  -- One row per object. Registering the same key twice would give one file two ids, two permission answers
  -- and two independent single-use budgets.
  constraint private_document_storage_key_is_unique unique (storage_key)
);

comment on table private_document is
  'The register of every private document this business holds: one row per object in the private bucket, '
  'with the class that decides who may read it and the hash that says which bytes it is. Append-only: '
  'UPDATE and DELETE raise. It is the ONE place every producer — tax invoices, credit notes, VAT return '
  'snapshots, payslips, clinical extracts, compliance evidence — registers what it wrote, so that "what '
  'private documents exist" is a SELECT rather than a survey of five producers.';
comment on column private_document.document_class is
  'One of @berelax/core''s PRIVATE_DOCUMENT_CLASSES. It decides the matrix permission a reader must hold '
  'and whether a link may be followed twice; an unknown class is refused rather than denied later.';
comment on column private_document.storage_key is
  'The key inside the PRIVATE bucket. Never in a URL and never in an audit row: the signature covers the '
  'document id and its class, so no path into that bucket ever travels.';
comment on column private_document.content_sha256 is
  'Which bytes this document IS. The audit row on every download names this and not the storage key, so a '
  'substituted file breaks the claim rather than inheriting it.';
comment on column private_document.use_policy is
  'replayable or single_use, derived from the class by @berelax/core and stored so the replay trigger needs '
  'no join. Tied to the class by private_document_use_policy_matches_class.';

create index private_document_subject_idx on private_document (subject_kind, subject_id);
create index private_document_class_idx on private_document (document_class, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- The fetch log
-- ---------------------------------------------------------------------------------------------
create table private_document_fetch (
  id uuid primary key default gen_random_uuid(),
  private_document_id uuid not null references private_document (id) on delete restrict,
  /*
    The nonce out of the signature that authorised this fetch.

    Stored in the CLEAR, unlike the evidence grant's token digest one table along, and the difference is
    that this is not a credential: the nonce alone opens nothing, because the signature is an HMAC over it
    under a key that is not in the database. What it is, is the identity of the LINK — which is exactly what
    a single-use budget has to be keyed on.
  */
  signature_nonce text not null,
  /** The key version the signature was made under, so a rotation is legible in the log afterwards. */
  signature_key_version text not null,
  fetched_at timestamptz not null default now(),
  /** The authenticated role that fetched it, and the staff reference behind the session. */
  fetched_by_role text not null,
  fetched_by text not null,
  bytes integer not null,
  constraint private_document_fetch_nonce_is_stated check (btrim(signature_nonce) <> ''),
  constraint private_document_fetch_key_version_is_stated
    check (btrim(signature_key_version) <> ''),
  constraint private_document_fetch_by_is_stated
    check (btrim(fetched_by_role) <> '' and btrim(fetched_by) <> ''),
  constraint private_document_fetch_bytes_are_positive check (bytes > 0)
);

comment on table private_document_fetch is
  'One row per authorised fetch of a private document, written in the same transaction as the '
  'authorisation. Append-only: UPDATE and DELETE raise. Two jobs. It is the record that a copy left the '
  'business — including a repeat of the same link for a replayable document, because a second download is '
  'a second copy — and for a single_use document it IS the replay defence: assert_single_use_document_not_'
  'replayed locks the register row and refuses a second row for one nonce.';
comment on column private_document_fetch.signature_nonce is
  'The nonce from the signature, in the clear. Not a credential: alone it opens nothing, because the '
  'signature is an HMAC over it under a key that is not in this database. It is the identity of the LINK, '
  'which is what a single-use budget has to be keyed on.';

-- `(document, nonce)` and not `(nonce)`: the uniqueness that matters is per document, and the lookup the
-- replay trigger makes is exactly this pair.
create index private_document_fetch_nonce_idx
  on private_document_fetch (private_document_id, signature_nonce);
create index private_document_fetch_at_idx on private_document_fetch (fetched_at desc);

-- ---------------------------------------------------------------------------------------------
-- ZY113 — the class, as a sentence
-- ---------------------------------------------------------------------------------------------
-- The CHECK above holds under a restore with `session_replication_role = 'replica'`. This exists for the
-- person: a `23514` naming `private_document_class_is_known` says a constraint was violated, and what
-- somebody needs to read is which class they used, where the catalogue is, and that the two have to move
-- together.
create function assert_private_document_class_known() returns trigger
language plpgsql
as $$
begin
  if not private_document_class_is_known(new.document_class) then
    raise exception
      'ZY113: ''%'' is not a private document class. The closed set lives in PRIVATE_DOCUMENT_CLASSES in '
      'packages/core/src/documents/private-document.ts and is restated in '
      'private_document_class_is_known(); a class in one and not the other is refused here rather than '
      'stored, because an unclassified document has no permission mapped to it — so it is a document '
      'nobody can ever fetch and nobody can ever notice is unfetchable. Add it to BOTH in one commit.',
      new.document_class
      using errcode = 'ZY113';
  end if;
  return new;
end $$;

comment on function assert_private_document_class_known() is
  'Raises ZY113 for a document class outside @berelax/core''s catalogue. The CHECK beside it holds the same '
  'rule under a restore with triggers off; this exists for the sentence a human reads.';

create trigger private_document_class_is_answerable before insert on private_document
  for each row execute function assert_private_document_class_known();

-- ---------------------------------------------------------------------------------------------
-- ZY112 — the register and the log are append-only
-- ---------------------------------------------------------------------------------------------
-- One function for both tables, because it is one rule: the audit row names the content hash, so a register
-- row whose storage key could be repointed would make an audited download name bytes that were never
-- served, and a fetch log that could be edited is not a record of anything. `TG_TABLE_NAME` so the sentence
-- names the table the caller touched.
create function refuse_private_document_rewrite() returns trigger
language plpgsql
as $$
begin
  raise exception
    'ZY112: % is append-only, so the % it was sent is refused. The register is what an audited download '
    'NAMES — a '
    'storage key that could be repointed would make a recorded download name bytes that were never served '
    '— and the fetch log is the record that a copy of a statutory document left the business. Neither has '
    'a correction: register a new document, and let the old row stand.',
    tg_table_name, tg_op
    using errcode = 'ZY112';
end $$;

comment on function refuse_private_document_rewrite() is
  'Raises ZY112 for any UPDATE or DELETE on private_document or private_document_fetch. One function for '
  'two tables because it is one rule, and the message names the table from TG_TABLE_NAME.';

create trigger private_document_is_not_updatable before update on private_document
  for each row execute function refuse_private_document_rewrite();
create trigger private_document_is_not_deletable before delete on private_document
  for each row execute function refuse_private_document_rewrite();
create trigger private_document_fetch_is_not_updatable before update on private_document_fetch
  for each row execute function refuse_private_document_rewrite();
create trigger private_document_fetch_is_not_deletable before delete on private_document_fetch
  for each row execute function refuse_private_document_rewrite();

-- ---------------------------------------------------------------------------------------------
-- ZY111 — a single-use link is single-use
-- ---------------------------------------------------------------------------------------------
-- The lock is the whole mechanism and it is why this is a trigger rather than a `select` in the repository.
-- A read-then-insert in TypeScript is two statements: two concurrent fetches of one link both find no prior
-- row, both insert, and both are served — which is precisely the case a single-use link exists for, because
-- a forwarded link is opened by two people at once. `for update` on the REGISTER row serialises every fetch
-- of that document, so the check and the insert are one critical section. The register row is immutable, so
-- the lock is a mutex and never contends with a writer; that is 0023's row-locked counter used for
-- ordering rather than for a sequence.
--
-- Deliberately NOT a unique index. A partial unique index cannot read another table's `use_policy`, so it
-- would need the policy copied onto every fetch row — a second statement of a fact that can drift, in a
-- schema whose own rule is that it does. And a `23505` from an index says "duplicate key" where what a
-- reader needs is "this link has already been used, by this role, at this time".
--
-- It also catches a MULTI-ROW insert of one nonce, which the read-then-insert version would not: a BEFORE
-- ROW trigger's query sees the rows the same statement has already inserted, so the second `values` tuple
-- finds the first. Measured rather than assumed — gate case 129m drives exactly that statement, because
-- "two rows in one insert" is the shape a batch-recording helper would produce and the one a per-statement
-- guard would miss.
create function assert_single_use_document_not_replayed() returns trigger
language plpgsql
as $$
declare
  v_policy text;
  v_class text;
  v_previous private_document_fetch;
begin
  select document_class, use_policy into v_class, v_policy
    from private_document
   where id = new.private_document_id
     for update;
  -- No row means the foreign key is about to refuse this anyway, and refusing it here first would report a
  -- replay for a document that does not exist.
  if v_policy is null or v_policy <> 'single_use' then
    return new;
  end if;
  select * into v_previous
    from private_document_fetch
   where private_document_id = new.private_document_id
     and signature_nonce = new.signature_nonce
   order by fetched_at
   limit 1;
  if v_previous.id is not null then
    raise exception
      'ZY111: this link to % % has already been used. A % is single-use: it was fetched at % by %, and '
      'there is no legitimate reason for one link to yield two copies of it. Mint a new link — the '
      'signature authorises a FETCH and not a principal, so a fresh one costs nothing and is recorded.',
      v_class, new.private_document_id, v_class, v_previous.fetched_at, v_previous.fetched_by_role
      using errcode = 'ZY111';
  end if;
  return new;
end $$;

comment on function assert_single_use_document_not_replayed() is
  'Raises ZY111 when a second fetch row is written for one nonce against a single_use document. Takes '
  'FOR UPDATE on the register row first, so the check and the insert are one critical section: without the '
  'lock, two concurrent fetches of one forwarded link both find no prior row and both are served, which is '
  'the case a single-use link exists for.';

create trigger private_document_fetch_is_not_a_replay before insert on private_document_fetch
  for each row execute function assert_single_use_document_not_replayed();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 grants the application role select/insert/update/delete on every table created in `public`
-- afterwards, so both tables arrive with all four and the revokes are load-bearing. The door is held twice,
-- 0072's and 0078's arrangement: the trigger refuses for every role, and the grant refuses before a trigger
-- is reached.
--
-- The table-level REVOKE has to come FIRST: a column-list grant does not narrow an existing table-level
-- one, and leaving the revoke out cost 0076 a whole run.
revoke update, delete, truncate on private_document from berelax_app;
revoke update, delete, truncate on private_document_fetch from berelax_app;
-- INSERT stays on both: registering a document and recording a fetch are the two things the application
-- does here, and both are append-only writes the triggers above judge.

commit;
