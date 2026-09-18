import type { OutboundMessage, SendOutcome, Transport } from './port.ts'

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
 * Wraps a transport so no send can bypass the guard. Features depend on this type, never on a
 * raw Transport — which is why `Transport.send` is documented as never being called directly.
 */
export function createGuardedTransport(args: {
  readonly inner: Transport
  readonly decide: (
    message: OutboundMessage,
  ) => { kind: 'deliver' } | { kind: 'divert'; reason: string }
  readonly outbox: InMemoryOutbox
  readonly now: () => string
}): Transport {
  return {
    channel: args.inner.channel,
    async send(message: OutboundMessage): Promise<SendOutcome> {
      const decision = args.decide(message)
      if (decision.kind === 'divert') {
        const outboxRef = args.outbox.record(message, decision.reason, args.now())
        return { kind: 'diverted', reason: decision.reason, outboxRef }
      }
      return args.inner.send(message)
    },
  }
}
