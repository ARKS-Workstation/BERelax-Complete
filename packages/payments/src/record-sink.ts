import type { GatewayMovementRecord, PaymentRecordSink } from '@berelax/core'

/**
 * The in-memory movement sink every adapter writes to before it returns.
 *
 * ADR 0022 rule 1 in payments shape: *no fake returns success without writing to a visible call log*. The
 * durable version of this is Y-PAY-02's `payment` rows; until those exist the sink is what the admin
 * payments screen and the conformance suite read, and the important property is that it is the SAME sink
 * for the real till adapter and for the fake gateway. A log only the fakes wrote to would be a log nobody
 * could reconcile the cash against, which is ADR 0022's argument for the manual adapter writing to it too.
 *
 * Deliberately not capped. `settings-store.itest.ts` lost three recorded changes to a capped reader — both
 * sides of a subtraction pinned at the limit — and a sink a conformance rule counts movements in is exactly
 * that shape. A screen that wants the last twenty slices what it reads; the sink itself keeps everything it
 * was given, in call order.
 */
export function createRecordSink(): PaymentRecordSink {
  const movements: GatewayMovementRecord[] = []
  return {
    record(movement) {
      movements.push(movement)
    },
    all() {
      return [...movements]
    },
  }
}
