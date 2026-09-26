import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * No outbox idempotency key is derived from a statutory display number.
 *
 * ## Why this exists, and why it is a scan rather than a review note
 *
 * `outbox_event.idempotency_key` is UNIQUE and `publishEvent` resolves a collision with `on conflict do
 * nothing`, returning null into call sites that discard it. So a key that can repeat does not fail — it
 * silently drops the second event, and the only way to notice is to go looking for a row that was never
 * written.
 *
 * A display number CAN repeat. `document_number_display` (migration 0013) embeds `period_key`, so an
 * `annual` series cannot repeat a number across years and the business is safe; the counter restarting
 * against an EMPTY period key is what breaks it, and that is what a TRUNCATE of the document table does.
 * Both suites that cover these documents do exactly that in `beforeEach`, so every document after the
 * first in each file was reusing a key and losing its event.
 *
 * `ec561e7` fixed two call sites — `invoice.issued` and `credit_note.issued` — and MISSED two more:
 * `payment.recorded`, written in the same transaction as `invoice.issued` and therefore leaving the pair
 * keyed inconsistently, and `payment.refunded`, which keyed on a display number plus a refund ordinal.
 * The first was found by a unit whose work is unrelated, 90 minutes later, from a red test in a file
 * nobody had touched. This test is what that fix should have shipped with: it makes the NEXT incomplete
 * sweep fail in the same commit rather than in somebody else's verify.
 *
 * A row id is the right key because it is the identity of the fact "this thing happened": unique for
 * ever, never reset, immutable. A display number is a label for people to read, and it belongs in the
 * payload, where every one of these events already carries it.
 */
const ROOTS = ['packages', 'apps']
const KEY_FROM_DISPLAY_NUMBER = /idempotencyKey:\s*`[^`]*\$\{[^}]*[dD]isplayNumber[^}]*\}/

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path))
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(path)
    }
  }
  return out
}

/**
 * This file is excluded from its own corpus, and that is not a convenience.
 *
 * The control below contains the forbidden shape as a string literal — it has to, or it could not prove
 * the pattern still matches — so a scanner that reads itself reports itself. That is the self-match trap
 * this repository has now hit in three different shapes: a `/proc` scan matching its own `grep`, a
 * chokepoint rule condemning its own declaration, and this.
 */
const SELF = join('packages', 'db', 'src', 'outbox-keys.test.ts')

const files = ROOTS.flatMap((root) => sourceFiles(root)).filter((file) => file !== SELF)

describe('every outbox idempotency key is a row id, not a statutory number', () => {
  it('scans a corpus big enough to contain the call sites, so an empty result means something', () => {
    // ADR 0002: a scan that examined nothing passes. The floor is well under the real count and well
    // over zero, and the second assertion proves the corpus actually holds `publishEvent` callers.
    expect(files.length).toBeGreaterThan(500)
    const publishers = files.filter((f) => readFileSync(f, 'utf8').includes('idempotencyKey:'))
    expect(publishers.length).toBeGreaterThan(5)
  })

  it('finds no key built from a display number', () => {
    // LINE by line, not whole-file. `[^`]*` does not stop at a newline, so against the whole text it
    // pairs an `idempotencyKey:` on one line with a `${…displayNumber…}` fifty lines below it and reports
    // a file that is perfectly correct — which is what the first version of this test did to
    // `manual-payment.ts`. The pattern is about one line because the shape it forbids is on one line.
    const offenders = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (KEY_FROM_DISPLAY_NUMBER.test(line) ? [`${file}:${i + 1}`] : [])),
    )
    expect(
      offenders,
      'an outbox key built from a statutory display number silently drops its event when the ' +
        'numbering counter restarts — use the row id and keep the display number in the payload',
    ).toEqual([])
  })

  it('the control: the pattern DOES match the shape it forbids', () => {
    // Without this the case above passes when the regex stops matching anything, which is the way a scan
    // like this dies — quietly, with a green tick.
    expect(
      KEY_FROM_DISPLAY_NUMBER.test('idempotencyKey: `invoice.issued:${issued.displayNumber}`'),
    ).toBe(true)
    expect(
      KEY_FROM_DISPLAY_NUMBER.test(
        'idempotencyKey: `payment.refunded:${settlement.displayNumber}:${refundNo}`',
      ),
    ).toBe(true)
    // And does not match the corrected shape, so the rule is about the display number and not about
    // interpolation in general.
    expect(KEY_FROM_DISPLAY_NUMBER.test('idempotencyKey: `invoice.issued:${issued.id}`')).toBe(
      false,
    )
  })
})
