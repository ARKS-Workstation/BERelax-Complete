# ADR 0008 — unit of work, and exactly-once *per handler*

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** F06

## The unit of work

Every mutation runs inside `withUnitOfWork(sql, actor, fn)`, which provides one transaction, one
audit writer and one event publisher.

The point is that **the state change, its audit row and its domain event share a transaction.** Any
two committing without the third is a bug that is very hard to find later, precisely because the
evidence of it is the record that is missing. A test asserts that a rollback discards the audit row
*and* the event together, and that a commit persists both.

## Exactly-once is a property of a table, not of the queue

The outbox gives **at-least-once** delivery: a worker can crash after dispatching a handler but
before marking the row published, and the next worker will dispatch again.

"Exactly once per handler" therefore comes from `outbox_delivery`, whose primary key is
`(event_id, handler)`. The worker **claims the pair before calling the handler**; a primary-key
conflict means another worker already delivered it, so this attempt is skipped rather than duplicating
the side effect. Concurrency is safe because the batch claim uses `for update skip locked`, so several
workers drain the same backlog without blocking or colliding — tested with four concurrent drainers
over twelve events, asserting exactly twelve deliveries.

A useful consequence of keying on handler *name*: a handler deployed later starts with no rows and
receives events it has not yet seen. Renaming a handler therefore replays history to it, which is
occasionally what you want and should never be accidental.

## One broken consumer must not block the others

A handler that throws has its claim released and the error recorded against `outbox_event`, leaving
the event unpublished for retry. Other handlers on the same event still receive it, and the event is
only marked published once **every** interested handler has succeeded. Tested both ways: a flaky
handler succeeds on its second drain, and a permanently broken handler does not stop a healthy one.

## Reads are audited, not just writes

`AuditWriter.recordSensitiveRead` and `recordExport` exist because the realistic breach here is an
insider reading or exporting the client list, not an external attacker
([docs/06 §D4](../06-blind-spots-and-risks.md)). A trail that records only mutations cannot answer
*"who opened whose clinical notes"*. Exports record their row count, and migration 0005 indexes them
separately so an unusually large one is cheap to find.

Audit actions must be namespaced (`booking.reschedule`), enforced by a validation error, because an
un-namespaced trail is not queryable and the constraint is impossible to add retroactively.

## A constraint on how audit is tested, discovered the hard way

`audit_event` is append-only via `DO INSTEAD NOTHING` rules, so **it cannot be cleaned between
tests** — a `DELETE` in an `afterEach` silently does nothing. A test that passed in isolation failed
under `pnpm verify` because a previous test's audit row leaked into its assertion.

The fix is not to weaken the append-only rule. Every audit assertion uses an action **unique to its
own run**. This is a permanent constraint on testing this table, and it is recorded here rather than
in a comment in one file, because every future unit that audits will hit it.

It is also a small argument for the append-only design: the rule was strong enough to defeat a
cleanup the test author assumed would work.
