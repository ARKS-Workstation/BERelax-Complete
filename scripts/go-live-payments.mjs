#!/usr/bin/env node
/**
 * The payments go-live check: can this business take a card yet, and if not, what is missing.
 *
 * Y-PAY-10. An acquirer does not ask whether the code works. It asks for a merchant category code
 * confirmed in writing and for a public website carrying a specific set of pages — the refund and
 * cancellation policy, the privacy policy, prices in the settlement currency, contact details and a
 * physical address — and it checks them by looking. docs/05 names no acquirer and `Y7-mcc` is open, so
 * this script is the list and the verdict rather than an integration.
 *
 * ## It is THIN on purpose
 *
 * The list and the judgement are `PAYMENTS_GO_LIVE_PREREQUISITES` and `paymentsGoLiveVerdict` in
 * `@berelax/core`, so both are testable with no database and no server — and
 * `apps/web/src/payments-go-live.test.ts` holds every `route` in the list against the route registry.
 * A check whose judgement lives in a script is a judgement no test reaches, which is the shape
 * `ALERT_REGISTRY` was moved out of for the same reason. What is here is two queries and the printing.
 *
 * ## It is NOT in `pnpm verify`, deliberately
 *
 * It exits non-zero today, and it is supposed to: two of the five prerequisites have no public page in
 * this build at all. Putting it in `verify` would make every commit fail on a business fact nobody can
 * fix in code, and the first response to a check like that is to delete it. So it is run by a person
 * before going live, which is the only moment its answer matters.
 *
 * ## What it does not do
 *
 * It does not fetch the site. The registry is the one declaration of what this application serves,
 * held to the filesystem in both directions by its own test, and `publication_record` is the one record
 * of what has been published on each surface. A fetch would be a third answer, would need a running
 * server, and would report a 200 for a page that says nothing — which is exactly what
 * `publication_record` exists to distinguish.
 */
import postgres from 'postgres'
import { ROUTES } from '../apps/web/src/routes/registry.ts'
import {
  PAYMENTS_GO_LIVE_PREREQUISITES,
  paymentsGoLiveVerdict,
} from '../packages/core/src/payments/go-live.ts'

const url = process.env['DATABASE_URL'] ?? process.env['TEST_DATABASE_URL']
if (!url) {
  console.error('DATABASE_URL or TEST_DATABASE_URL is required for the payments go-live check.')
  process.exit(1)
}

const sql = postgres(url, { max: 2 })
let verdict

try {
  // The newest record per surface, in one statement. `seq` and not `recorded_at`: that instant comes
  // from an injected clock and two records written under a frozen one share it exactly, which is
  // `publicationPosition`'s own stated reason.
  const records = await sql`
    select surface, state from (
      select surface, state, row_number() over (partition by surface order by seq desc) as rn
        from publication_record
    ) ranked where rn = 1
  `
  const publicationState = new Map(records.map((row) => [row['surface'], row['state']]))

  const columns = [
    ...new Set(
      PAYMENTS_GO_LIVE_PREREQUISITES.flatMap((item) =>
        item.premisesColumn === null ? [] : [item.premisesColumn],
      ),
    ),
  ]
  const premisesContent = new Map()
  if (columns.length > 0) {
    // `is_placeholder_text()` and not a null check: migration 0026's whole point is that a provisional
    // value carries a marker, so an address reading `[confirm]` is present and useless.
    const [row] = await sql`
      select address_line_1, is_placeholder_text(address_line_1) as address_is_placeholder
        from premises order by id limit 1
    `
    for (const column of columns) {
      premisesContent.set(
        column,
        row !== undefined && row['address_is_placeholder'] !== true && row[column] !== null,
      )
    }
  }

  const [entity] = await sql`
    select mcc,
           to_char(mcc_confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as confirmed_at,
           mcc_confirmed_by
      from legal_entity order by id limit 1
  `

  verdict = paymentsGoLiveVerdict({
    servedRoutes: ROUTES.map((route) => route.path),
    publicationState,
    premisesContent,
    mcc: {
      mcc: entity?.['mcc'] ?? null,
      confirmedAtIso: entity?.['confirmed_at'] ?? null,
      confirmedBy: entity?.['mcc_confirmed_by'] ?? null,
    },
  })
} finally {
  await sql.end({ timeout: 5 })
}

const WIDTH = 13
console.log('Payments go-live prerequisites:\n')
for (const item of verdict.items) {
  console.log(`  ${item.state.toUpperCase().padEnd(WIDTH)}${item.label} — ${item.detail}`)
}

if (!verdict.ok) {
  console.error(
    `\n${verdict.unmet.length} prerequisite(s) not met: ${verdict.unmet.join(', ')}. This business ` +
      'cannot be taken live on a card gateway yet, and that is a statement about the acquirer’s ' +
      'requirements rather than about this code: the manual adapter remains the only live path and it ' +
      'takes cash, the in-salon card machine and a bank transfer. Nothing here can be fixed by a deploy.',
  )
  process.exit(1)
}

console.log(
  `\nEvery prerequisite is met: ${PAYMENTS_GO_LIVE_PREREQUISITES.length} public-site item(s) ` +
    'published and a merchant category code confirmed in writing. A real provider may now be selected ' +
    'in production.',
)
