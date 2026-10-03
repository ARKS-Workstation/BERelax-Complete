import { BREACH_NOTIFICATION_HOURS_SETTING_KEY } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import type { Sql } from '../connection.ts'
import { readBreachNotificationHours } from './pdpl.ts'

/**
 * The breach-period reader refuses a value it cannot use. It does NOT fall back.
 *
 * This is a unit test with a stubbed `sql` rather than an integration one, because the behaviour under
 * test is what happens when the stored row is WRONG — and the schema will not let `writeSetting` store
 * a wrong one, which is correct and makes the case unreachable through the real path. A stub is the only
 * way to exercise the row a direct `psql` edit, a restore from an older dump or a future migration could
 * leave behind.
 *
 * `readSetting` does two things: it looks the key up in the F09 registry (which throws on an undeclared
 * one) and then runs one query. The stub answers that query, so the registry lookup is real.
 */
function sqlReturning(value: unknown): Sql {
  const stub = (() => Promise.resolve(value === undefined ? [] : [{ value }])) as unknown as Sql
  return stub
}

describe('readBreachNotificationHours', () => {
  it('returns a stored whole number of hours', async () => {
    await expect(readBreachNotificationHours(sqlReturning(24))).resolves.toBe(24)
  })

  it('falls back to the DECLARED default when no row exists, which is not the same as a fallback', async () => {
    // `readSetting`'s own behaviour and the right one: a freshly migrated database has no `app_setting`
    // row and must behave exactly like a seeded one. The declared default is a figure in the registry
    // carrying its `provisional` flag and its open question — which is the opposite of this module
    // inventing one when it cannot read what is there.
    await expect(readBreachNotificationHours(sqlReturning(undefined))).resolves.toBe(72)
  })

  it.each([['seventy-two'], [72.5], [0], [-1], [{ hours: 72 }]])(
    'refuses %s rather than substituting the build guess',
    async (stored) => {
      // A fallback here would restore the build's guess over a figure somebody had deliberately
      // changed, silently, on a statutory deadline — and the deadline is the one number in this build
      // whose being quietly wrong means a missed notification.
      await expect(readBreachNotificationHours(sqlReturning(stored))).rejects.toThrow(
        /BreachPeriodUnreadable/,
      )
    },
  )

  it("cannot tell a stored null from an absent row, which is readSetting's shape and is recorded here", async () => {
    /*
      A finding rather than a design: `readSetting` ends in `rows[0]?.value ?? def.defaultValue`, and `??`
      treats a stored SQL null exactly like a missing row. So a row somebody cleared reads as the
      declared default, and this reader never sees it.

      It is written down rather than worked around because the alternative is worse in both directions.
      Distinguishing them here would mean this module querying `app_setting` itself instead of going
      through the one read path — a second reader, with its own view of what a setting is. And making
      `readSetting` distinguish them is a change to every caller in the build, for a state the schema
      cannot produce: `writeSetting` validates against the declared schema, and this key's schema refuses
      null. The reachable way in is a direct `psql` edit or a restore from an older dump, and the honest
      statement is that in that case the figure silently reverts to the build's guess.

      The gap is narrow and it is the one place in this unit where a provisional figure can be in force
      without appearing to be. `Y1-breach-clock` says so.
    */
    await expect(readBreachNotificationHours(sqlReturning(null))).resolves.toBe(72)
  })

  it('names the key and the open question in the refusal, because the fix is a settings change', async () => {
    // `.then(() => undefined, (e) => e)` rather than `.catch(e => e as Error)`: the catch form widens
    // the awaited type to `number | Error`, so `error.message` does not typecheck — and casting it would
    // make a resolved promise read as an error with an undefined message, which is a test that passes
    // when the refusal stops happening.
    const error = await readBreachNotificationHours(sqlReturning('seventy-two')).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
    )
    expect(error, 'an unreadable period must refuse rather than resolve').not.toBeNull()
    expect(error?.message).toContain(BREACH_NOTIFICATION_HOURS_SETTING_KEY)
    expect(error?.message).toContain('Y1-breach-clock')
  })
})
