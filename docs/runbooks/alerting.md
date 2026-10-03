# Runbook — the alert ladder

Every entry in `packages/shared/src/alerts/registry.ts` names a heading in this file, and
`pnpm alerts` fails the build if one of them does not exist. So this is the procedure, not a summary of
one: if a section here is wrong, the response to that alert is wrong.

**What this file is not.** It is not the runbook set. H-HARD-06 owns that, and this is the subset the
alert registry needs in order to be checkable at all — one heading per alert, written by the unit that
raised the alert, at the only moment when the person who knows what the alert means is still looking at
it.

**Read this first.**

- **An alert is a measurement, not a row.** None of these alerts is stored. Each one is a query over
  rows that already exist, re-run every fifteen minutes by `agent.watchdog`, so every one of them
  **clears by itself** when the condition goes away. There is nothing to acknowledge and nothing to
  close. What IS stored is the *notification*: one `outbox_event` per incident, deduplicated by
  `idempotency_key`, so you will be told once per incident and not once per pass.
- **Nothing here is delivered to a phone.** `AlertRoute.audience` is a list of roles and `surface` is a
  screen in this application. Pushing an alert to a person is R-REP-08 and is not built; there is no
  on-call address on file (OPEN-QUESTIONS `Y13-oncall`). Until then an alert is read by somebody
  looking, which is a limitation and not a design.
- **No alert here has a service-level objective.** Each registry entry carries the SHAPE of one — what
  is measured, over which `table.column` inputs, across what window — and no target, because this build
  has no production traffic and no measured baseline (`Y13-alert-slos`). Do not quote a figure from this
  file as an objective; there is none to quote.
- **Four things are not defended at all**, and they are written out in `UNDEFENDED_BY_DESIGN` in the
  registry rather than here, so that the exception sits beside the alert somebody would otherwise
  believe. Read it before telling anybody an exposure is covered.

---

## A bulk export of the client list

**What fired.** A row in `rights_export` covering two or more data subjects, inside the last 24 hours.
docs/06 §D4 is explicit that this is the realistic breach for this business: somebody inside it taking
the client list, not an attacker outside it.

**What is true before you start.** The export already happened. This alert is a detection control and
there is no prevention control behind it — `rights_export.alerted` is tied to `subject_count` by a CHECK
in migration 0085, so a bulk export cannot even be *recorded* as un-alerted, and that is the whole of
what the schema guarantees. Nothing refused it and nothing can.

### Confirm

```
select id, exported_at, purpose, subject_count, row_count, actor_kind, actor_label
  from rights_export
 where exported_at > now() - interval '24 hours'
 order by subject_count desc;
```

`purpose` is required and non-empty — `exportSubjectData` refuses an export without one — so every row
has a stated reason. Read it first.

### Decide

1. **Was it a rights request?** A subject-access export covers ONE subject. Two or more is a different
   act whatever the purpose says. Cross-check `rights_request_id` against the request it claims.
2. **Who ran it?** `actor_label` for a staff actor is the internal handle, never a person's name
   (ADR 0020, `Y12-names`). The corresponding `audit_event` row — `privacy.subject_data_exported`,
   `operation = 'export'` — carries the request id and the IP.
3. **If it was not authorised**, the data is gone and the response is a disclosure response, not a
   technical one. H-HARD-07's incident register is where that is recorded, and filing an incident of
   class `personal_data_breach` is what starts the notification clock.

### What this does not tell you

- **A read is not an export.** Somebody paging through the client list screen writes `operation = 'read'`
  rows and never appears here. `audit_event` records reads (`packages/db/src/audit.ts`), so the trail
  exists; this alert does not watch it, because the volume of ordinary reads has no threshold anybody
  has measured.
- **`psql` writes nothing at all.** See `direct-sql-bypasses-the-application`.
- **An export by the owner is alerted to the owner.** See `owner-reads-everything`. There is no second
  principal in this business to route it to.

---

## The outbox has stopped draining

**What fired.** The oldest unpublished `outbox_event` is older than `alerts.outbox_lag_seconds`. A
domain effect has stopped happening: a confirmation, a reminder, a review request, a Google revocation
retry.

### Confirm

```
select id, occurred_at, event_type, attempts, last_error
  from outbox_event
 where published_at is null
   and aggregate_type <> 'operational_alert'
 order by occurred_at
 limit 20;
```

`aggregate_type <> 'operational_alert'` is in the measurement too, and it is not a convenience: an alert
is published into this table, so an alert event waiting for its first drain would be counted as backlog
and the alarm would feed itself.

### Decide

1. **`attempts` climbing with a `last_error`** — one handler is throwing. `drainOutbox` marks an event
   published only once every interested handler has succeeded, so one broken consumer holds the event and
   does not block the others' delivery. Read `last_error`, fix the handler.
2. **`attempts` at zero** — nothing has claimed it. The worker is not running, or it is running and not
   reaching this queue. Check `agent_heartbeat.last_success_at` for `agent_watchdog`: if that is stale
   too, the worker is the problem and no alert in this file is being evaluated at all.
3. **Events with no interested handler publish immediately** and never appear here. An event type nobody
   consumes is not a backlog.

### What this does not tell you

Whether the worker is running. If it is not, this alert does not fire — see
`the-pass-cannot-report-its-own-absence`. The absence of alerts and a quiet system look identical from
inside.

---

## Messages are delayed

**What fired.** More `message` rows are in `status = 'queued'` than `alerts.send_backlog_messages`.
Nothing has accepted them: migration 0035's CHECK makes `sent` and `delivered` require a provider id and
a `sent_at`, so queued means exactly "no vendor has taken this".

This is the one alert with a **screen** rather than a notification. Every admin document carries the
banner, because the person who needs it is a receptionist about to tell a client their confirmation has
gone out.

### Confirm

```
select channel, vendor, count(*), min(queued_at)
  from message
 where status = 'queued'
 group by channel, vendor
 order by min(queued_at);
```

### Decide

1. **One vendor, climbing** — the transport is refusing or timing out. Check that vendor's adapter and
   the provider mode: outside production `SMS_PROVIDER` and `EMAIL_PROVIDER` are refused as `real`
   (ADR 0005), so a non-production deployment that expects to send is misconfigured rather than broken.
2. **Both vendors** — this is the outbox, not the transports. Go to *The outbox has stopped draining*.
3. **Failed messages are deliberately NOT counted here.** A failure has a reason on the row and its own
   screen. Adding them would make the banner say "delayed" about something that will never arrive.

### What this does not tell you

Whether anything was *received*. A delivery receipt is a separate fact on
`message_delivery_receipt`; this is about the queue in front of the vendor.

---

## An agent is failing every run

**What fired.** An enabled agent's `agent_heartbeat.consecutive_failures` has reached
`alerts.job_consecutive_failures`. This is the "running and failing" shape of failure, which needs a
stack trace. The other shape — not running at all — is the watchdog's own 2x-interval alert and is a
different page.

### Confirm

```
select h.agent_key, h.consecutive_failures, h.last_outcome, h.last_error,
       h.last_run_at, h.last_success_at
  from agent_heartbeat h join agent_definition d using (agent_key)
 where d.enabled and h.consecutive_failures > 0
 order by h.consecutive_failures desc;
```

Then the attempts themselves, including the ones that aborted before their body ran:

```
select started_at, finished_at, outcome, cost_fils, error
  from agent_run where agent_key = :key order by started_at desc limit 20;
```

### Decide

1. **`outcome = 'budget_exceeded'`** — the agent did not fail, it was stopped. Raise
   `agent_definition.budget_fils_per_run` or accept the stop; a partial `cost_fils` is recorded even on a
   run that aborted, so the month's bill stays explainable.
2. **`outcome = 'stopped_by_kill_switch'`** — somebody turned it off on purpose.
3. **`outcome = 'failed'`** — read `error`. The streak resets on the first success; there is nothing to
   clear by hand.

### What this does not tell you

A *rate*. `agent_heartbeat` records the streak and the last outcome, not a count of attempts, so there is
no denominator and this alert is a streak rather than a percentage. That is deliberate: a rate computed
from `agent_run` rows would be a second answer to "is this agent healthy" than the heartbeat gives.

---

## Repeated sign-in failures on one account

**What fired.** One `staff_credential` has been refused more than
`alerts.auth_failures_per_credential` times in the last hour. It is either somebody locked out of their
own account or somebody guessing, and both need answering.

### Confirm

```
select entity_id as credential_id, count(*), min(occurred_at), max(occurred_at)
  from audit_event
 where action = 'staff_session.refused' and operation = 'denied'
   and occurred_at > now() - interval '1 hour'
 group by entity_id order by count(*) desc;
```

Then whether any attempt in that window succeeded:

```
select occurred_at, action, operation, ip_address, request_id
  from audit_event
 where entity_type in ('staff_credential', 'staff_session')
   and occurred_at > now() - interval '1 hour'
 order by occurred_at;
```

### Decide

1. **A `staff_session.started` row in the same window** — somebody got in. Treat the earlier refusals as
   the preamble to an access you did not authorise until you have confirmed otherwise with the account
   holder. H-HARD-07's incident register is where that is recorded.
2. **No success** — probably the account holder. Resetting a credential is
  [docs/runbooks/admin-access.md](admin-access.md), which is deployment work with a record of who did
  it; there is no self-service reset in this build.
3. The row's actor is `system` with the label `admin sign-in`, never the account holder. A refused
   attempt has no authenticated principal, and `audit_event` is append-only (ADR 0008), so attributing
   somebody else's guess to the account holder could not be corrected afterwards.

### What this does not tell you

- **Attempts against handles that do not exist.** They write nothing, deliberately: there is no account
  to alert anybody about, and the alternative is putting arbitrary unauthenticated input into the trail
  as an entity id.
- **How many attempts anybody may make.** Nothing throttles the sign-in route. See
  `refused-sign-ins-are-unmetered`; the limit is H-HARD-01's and is not built.

---

## A blocking obligation is overdue

**What fired.** An `obligation_instance` with `status = 'open'` whose `obligation.is_blocking` is true,
due before the current **trading** date. Something the business is not permitted to do without that
obligation is being done.

`is_blocking` is a GENERATED column derived from `blocking_effect` (migration 0052), not a boolean
anybody can switch off — that migration's header records why. The comparison is against the trading date
and never `current_date`: trading runs 11:00–02:00, so at 01:30 the business is still working the
previous trading date and an obligation due that date is not yet overdue.

### Confirm

The compliance calendar screen is the answer here rather than a query — it already separates the two
counts this alert must never add together, and the alert reads the same `complianceAsOf` date the screen
does.

```
select o.key, o.title, o.blocking_effect, i.due_on, i.status
  from obligation_instance i join obligation o on o.id = i.obligation_id
 where i.status = 'open' and o.is_blocking
 order by i.due_on;
```

### Decide

1. **`blocking_effect`** says what is already blocked. Read it before anything else; the consequence is
   an enum precisely so that "blocking" is never a word on its own.
2. **An `is_unverified` obligation is a different problem.** "Nobody has confirmed this duty exists" and
   "this duty is overdue" have different remedies — a lawyer and a renewal — and the calendar screen
   keeps the counts apart for that reason. This alert reads only the second.
3. Completing an instance needs a role and a label (`obligation_instance_completion_has_an_actor`), so
   there is no way to close one anonymously.

### What this does not tell you

Any licence number, permit number or TRN. None is on file (`Y1-licence`, `Y1-trn`), the obligation table
holds none, and neither this alert's payload nor the screen prints one.
