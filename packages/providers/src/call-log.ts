/**
 * The visible provider call log.
 *
 * docs/12 §1: *a stub must never look like it works*. The rule this enforces is narrower and
 * checkable: **no fake returns success without writing a record here.** A conformance test walks
 * every registered fake and asserts it — so a future fake that quietly returns `{ ok: true }` fails
 * the build rather than passing a demo.
 *
 * It is also the thing that makes the system demoable with no credentials. The admin Messages inbox,
 * the review autoresponder's draft queue and the payment reconciliation screen all read this log; a
 * screenshot of the system working is a screenshot of what it would have sent.
 *
 * In-memory here. The durable store arrives with the admin UI; the interface is what matters now, so
 * that swap is a wiring change.
 */

export type CallOutcome = 'success' | 'failure'

export interface ProviderCall {
  readonly sequence: number
  /** `smsala`, `resend`, `google-business-profile`, … */
  readonly provider: string
  /** The method called, as the real API names it: `send`, `updateReply`, `refresh`. */
  readonly operation: string
  readonly outcome: CallOutcome
  readonly occurredAtIso: string
  /**
   * What the call would have done, in a form a human can read on a screen.
   *
   * Never the raw request: a recipient's phone number and a message body are personal data, and this
   * log is shown in screenshots. Summaries name what matters and elide the rest.
   */
  readonly summary: string
  /** Structured detail for assertions and for the admin detail pane. */
  readonly detail: Readonly<Record<string, unknown>>
}

export interface CallLog {
  record(entry: Omit<ProviderCall, 'sequence' | 'occurredAtIso'>): ProviderCall
  all(): readonly ProviderCall[]
  /** Calls made by one provider, oldest first. */
  forProvider(provider: string): readonly ProviderCall[]
  clear(): void
  readonly size: number
}

/**
 * @param now Injected, because nothing in this codebase reads the clock directly — a log whose
 * timestamps come from `Date.now()` cannot be asserted against, and the screenshot harness needs
 * byte-identical output across runs.
 */
export function createCallLog(now: () => string): CallLog {
  const entries: ProviderCall[] = []
  return {
    record(entry) {
      const call: ProviderCall = {
        ...entry,
        sequence: entries.length + 1,
        occurredAtIso: now(),
      }
      entries.push(call)
      return call
    },
    all() {
      return [...entries]
    },
    forProvider(provider) {
      return entries.filter((entry) => entry.provider === provider)
    },
    clear() {
      entries.length = 0
    },
    get size() {
      return entries.length
    },
  }
}
