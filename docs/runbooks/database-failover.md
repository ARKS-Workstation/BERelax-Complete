---
id: database-failover
title: Database failover: there is no standby, and what to do instead
unit: H-HARD-06
trigger_kind: manual
trigger: The database is unreachable or is refusing connections, and the application is answering errors to every request rather than serving.
first_action_heading: 1-establish-which-of-the-three-it-is
first_action: Find out whether the server is down, the database is up and refusing this credential, or the pool is exhausted, because the three have different answers and only one of them is a failover.
owner: owner
escalation: There is no standby and no second person; escalation is the hosting provider's own support path for the instance, and this document cannot name one because no provider is configured in this repository.
alerts: (none)
env: DATABASE_URL
---

# Runbook — database failover

## Read this first: there is no standby

**This build has one database and no replica.** `packages/db/src/connection.ts` takes one `DATABASE_URL`
and there is no second URL anywhere in the configuration: `packages/config/src/env.ts` declares
`DATABASE_URL` once, with no `*_REPLICA`, no `*_STANDBY` and no read/write split. So there is nothing to
fail over **to**, and a runbook that described a failover procedure would be describing a system that
does not exist.

That is a limitation and not a design, and it is recorded as one. What this document is for is the three
things that actually happen, told apart, because only one of them is about the database being gone.

## 1. Establish which of the three it is

```
psql "$DATABASE_URL" -c 'select 1'
```

| What you get | What it is | Where to go |
|---|---|---|
| `could not connect to server` | The server is not running or not reachable. | Section 2. |
| `password authentication failed` or `permission denied for database` | The server is up and the credential is wrong or has been rotated. | Section 3. |
| `sorry, too many clients already` | The server is up and the connections are used up. | Section 4. |
| `select 1` returns and the application still errors | Not the database. Read the application's own errors. | Not this runbook. |

A `select 1` and not a connection from the application, deliberately: the application's failure includes
its own configuration, its pool and its startup validation, and three of the four rows above are
indistinguishable through it.

## 2. The server is not reachable

There is no automatic answer here and this document will not invent one. In order:

1. **Confirm it is the server and not the network**, from a second place if you have one.
2. **If the instance can be restarted, restart it.** A PostgreSQL that stopped cleanly comes back with
   every committed transaction; nothing is lost and nothing has to be restored.
3. **If the instance cannot be recovered, this becomes a restore**, and the procedure is
   [the restore runbook](restore.md) — which is the honest consequence of having no standby: the
   recovery path for a lost database is the backup, with everything
   [the restore runbook](restore.md) says about what a restore undoes.
4. **Record the window.** Whatever happens next, the interval the database was unreachable is the
   interval in which bookings were not taken and messages were not sent. The outbox is durable, so
   anything enqueued before the failure is still there; anything a customer tried to do during it is
   not anywhere.

## 3. The credential is refused

Almost always a rotation that was applied in one place. `docs/runbooks/key-rotation.md` owns the
procedure; the thing to check first is that the application and the worker are reading the same
`DATABASE_URL`, because they are configured separately and a rotation applied to one of them presents as
an intermittent failure rather than an outage.

The application role is `berelax_app` and it is deliberately not the owner: it cannot `UPDATE` the
journal, cannot write `staff_credential`, and cannot create a schema. A `permission denied` naming one of
those is **the system working**, not a credential problem — see
[the admin access runbook](admin-access.md) section 5.

## 4. The connections are used up

`sorry, too many clients already` with nothing else wrong is usually several test suites or several
worktrees against one server, and it is the one failure in this table that is routinely nobody's fault
(`docs/CONTRIBUTING-AGENT-BRIEF.md` rule 1 says so). On a deployment it means the pool is sized above
what the server allows.

```
psql "$DATABASE_URL" -c 'select count(*), state from pg_stat_activity group by state'
```

Idle-in-transaction connections are the ones worth looking at: a handler that opened a transaction and
never finished holds locks as well as a connection.

## What would be needed for a real failover

Stated so the cost of not having it is visible rather than implied:

- **A standby instance with streaming replication**, which is a hosting feature and not a code change.
- **A second URL in the configuration**, plus a decision about whether the application reads from the
  standby — which is a correctness decision and not a performance one, because this schema relies on
  read-your-writes inside a transaction in several places.
- **A promotion procedure**, and the one thing a document cannot supply: somebody to run it, or
  something that runs it automatically. There is neither (`Y13-oncall`).

Until those exist, the recovery time for a lost database is however long a restore takes plus however
long it takes somebody to notice, and neither figure is committed to anywhere
([OPEN-QUESTIONS](../OPEN-QUESTIONS.md) `Y13-rpo-rto`).
