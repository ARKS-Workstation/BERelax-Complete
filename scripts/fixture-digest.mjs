#!/usr/bin/env node
/**
 * The fixture salon's fingerprint, committed so a change to it is visible in a diff.
 *
 * The generator is deterministic, which is worth nothing on its own — what matters is knowing when
 * its output *changes*. Every committed screenshot, every visual-regression baseline and every
 * expected report is taken against one particular dataset. A one-line edit to the generator can
 * silently invalidate all of them, and the symptom is a gallery that diffs everywhere with no
 * apparent cause.
 *
 * So the digest is committed. Changing the fixture is allowed and sometimes necessary; changing it
 * *without noticing* is not. `--emit` rewrites the file, and the diff is the notice.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { salonReport } from '../packages/fixtures/src/reports.ts'
import { generateSalon } from '../packages/fixtures/src/salon.ts'
import { digest } from '../packages/fixtures/src/serialise.ts'

const TARGET = join(import.meta.dirname, '..', 'packages', 'fixtures', 'fixture-digest.json')

const salon = generateSalon()
const report = salonReport(salon)

const fingerprint = {
  seed: salon.seed,
  generatedForIso: salon.generatedForIso,
  counts: {
    services: salon.services.length,
    rooms: salon.rooms.length,
    therapists: salon.therapists.length,
    customers: salon.customers.length,
    shifts: salon.shifts.length,
    appointments: salon.appointments.length,
    historical: salon.appointments.filter((a) => a.state !== 'booked').length,
    forward: salon.appointments.filter((a) => a.state === 'booked').length,
    packages: salon.packages.length,
    invoices: salon.invoices.length,
    lockedInvoices: salon.invoices.filter((invoice) => invoice.locked).length,
  },
  totals: report.totals,
  datasetDigest: digest(salon),
  reportDigest: digest(report),
}

const content = `${JSON.stringify(fingerprint, null, 2)}\n`

if (process.argv.includes('--emit')) {
  writeFileSync(TARGET, content)
  console.log(
    `wrote packages/fixtures/fixture-digest.json — ${fingerprint.datasetDigest.slice(0, 16)}…`,
  )
  process.exit(0)
}

let current = null
try {
  current = readFileSync(TARGET, 'utf8')
} catch {
  console.error(
    'FAIL  packages/fixtures/fixture-digest.json does not exist — run `pnpm fixtures:emit`',
  )
  process.exit(1)
}

if (current === content) {
  console.log(
    `PASS  fixture salon unchanged — ${fingerprint.counts.appointments} appointments, ` +
      `digest ${fingerprint.datasetDigest.slice(0, 16)}…`,
  )
  process.exit(0)
}

console.error(
  'FAIL  the fixture salon has changed.\n' +
    '      Every committed screenshot and visual baseline was taken against the old one.\n' +
    '      If the change is intended, run `pnpm fixtures:emit` and regenerate the gallery.',
)
process.exit(1)
