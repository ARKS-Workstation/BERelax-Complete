import type { OutboundMessage } from './port.ts'

/**
 * The local outbox. A diverted message is recorded here and is visible in the admin UI and in
 * screenshots — it is never silently dropped, and it never returns a bare success.
 *
 * docs/12-autonomous-delivery.md §1: "a stub must never look like it works".
 */
export interface OutboxEntry {
  readonly message: OutboundMessage
  readonly reason: string
  readonly recordedAtIso: string
}

export class InMemoryOutbox {
  private readonly entries: OutboxEntry[] = []

  record(message: OutboundMessage, reason: string, recordedAtIso: string): string {
    const ref = `outbox:${this.entries.length + 1}`
    this.entries.push({ message, reason, recordedAtIso })
    return ref
  }

  all(): readonly OutboxEntry[] {
    return [...this.entries]
  }

  get size(): number {
    return this.entries.length
  }
}

/**
 * `createGuardedTransport` USED TO BE HERE, and its removal is C-AUTO-04's subject rather than a tidy-up.
 *
 * It took any `Transport` and returned a `Transport` whose `send` applied a divert decision and then called
 * `inner.send(message)`. That is a second send path, and it is the exact shape this unit exists to make
 * impossible: a message leaving through it passed the staging guard and NOTHING else — no template
 * approval, no sender-identity resolution, no consent, no suppression, no frequency cap and no quiet
 * hours. It was exported from the package barrel, so it was reachable by autocomplete from any feature,
 * and it was reachable from a `Transport` — a shape whose `send` takes a bare message with no
 * idempotency key, so a retry through it would have been a second charge.
 *
 * Nothing in shipped code ever called it. That is why it survived: a dead bypass raises no failure, and
 * `messaging-providers-only-inside-a-transport` could not see it because it forbids reaching a PROVIDER
 * and this reached whatever it was handed. What finds it now is
 * `scripts/check-send-chokepoint.mjs`'s `message-send-outside-the-choke-point` rule, which fired on
 * `args.inner.send(message)` here on the first run it was pointed at the repository — and which would fire
 * again the moment anybody reintroduced it. `chokepoint-surface.test.ts` is the other half: it refuses a
 * barrel export matching a transport-factory name, so putting it back would fail two checks rather than
 * being reviewed.
 *
 * The staging guard itself is unchanged and is not optional. `sendMessage` applies `guardOutbound` after
 * the gate (`send.ts` says why the order matters) and records a divert in this outbox.
 */
