#!/usr/bin/env node
/**
 * The catalogue/CMS boundary, and the two other lines the CMS must not cross.
 *
 * ADR 0019 draws the boundary: the catalogue owns price, duration, bookability and the required skill; the
 * CMS owns narrative and SEO copy. The failure it is drawn against is not a misunderstanding — it is
 * convenience. A treatment page wants a price beside the prose, the prose is in the CMS, and adding
 * `price_from` to the narrative is one field and saves a join. Then there are two prices, the owner
 * changes one of them, and the page and the till disagree in front of a customer.
 *
 * Each violation is reported with its **rule name** first, so `scripts/test-gates.mjs` can assert that a
 * known-bad fixture was rejected by the rule written for it. A bare non-zero exit is not enough: a
 * fixture can be rejected by an unrelated rule while the one under test has quietly stopped matching
 * anything, and the gate then reports PASS forever (ADR 0003).
 *
 * ## The rules
 *
 * **1. `no-catalogue-field-in-cms`.** No CMS field may be named for something the catalogue owns —
 * `price`, `duration`, `bookable`, `vat` and the spellings somebody would actually write (`price_from`,
 * `duration_minutes`, `is_bookable`, `vat_rate`).
 *
 * **2. `catalogue-reference-must-be-a-plain-uuid`.** `catalogue_service_id` and `therapist_id` are a UUID
 * in a plain text column. A Payload `relationship` is a foreign key, and a foreign key across this line
 * couples two schemas that are migrated on separate cycles — see `packages/db/migrations/0023`.
 *
 * **3. `therapist-narrative-carries-no-name`.** A therapist has no display name until an admin sets one,
 * and the place it is set is the employee record. A second home for it is the one that reaches a public
 * page unapproved.
 *
 * **4. `payload-admin-must-not-load-the-site-stylesheet`.** `app/globals.css` clears Tailwind's colour,
 * spacing, radius, breakpoint and font namespaces with `: initial` and defines ours; Payload's admin is
 * built on its own custom properties and its own reset. Loaded together, whichever lands second wins. The
 * `(payload)` route group is the isolation, and this rule is what keeps it one.
 *
 * ## Two passes, and why both
 *
 * The **generated Payload config** is the authoritative subject: it is what the admin serves, after
 * Payload and the Lexical editor have added their own fields, and it is what the acceptance line asks
 * about. It is also built from six descriptor files, so a mistake in a descriptor is only visible there
 * once the config loads at all.
 *
 * The **source pass** over the descriptor files is therefore not redundant. It reports the file and line,
 * it runs even when the config cannot be built, and it is the surface a known-bad fixture can be dropped
 * onto — which is the difference between a rule that has been seen to fire and one that has not.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  boundaryViolations,
  isCatalogueOwnedFieldName,
  isCrossBoundaryReference,
  isNameShapedFieldName,
} from '../packages/cms/src/boundary.ts'

const MODEL_DIRS = [
  'packages/cms/src/collections',
  'packages/cms/src/globals',
  'apps/web/src/collections',
  'apps/web/src/globals',
]
const APP_DIR = 'apps/web/app'
const PAYLOAD_GROUP = '(payload)'
const SITE_STYLESHEET = 'globals.css'
const ADMIN_STYLESHEETS = ['@payloadcms/next/css', '@payloadcms/ui/scss']

const violations = []
let fieldsScanned = 0
let filesScanned = 0

// --- pass 1: the descriptor sources ------------------------------------------------------------
/**
 * A field literal, in either property order.
 *
 * Deliberately coarse: it finds `{ name: 'x', type: 'y' }` however it is wrapped or indented, and it does
 * not try to understand nesting. Attribution to a collection is by FILE — one collection per file, which
 * is why `packages/cms/src/collections` is one file per slug — because rule 3 applies to one collection
 * and a rule that guessed which fields belonged to it would err in the direction of passing.
 */
const FIELD_LITERAL =
  /name:\s*'([A-Za-z0-9_]+)'\s*,\s*type:\s*'([A-Za-z0-9]+)'|type:\s*'([A-Za-z0-9]+)'\s*,\s*name:\s*'([A-Za-z0-9_]+)'/g
const SUBJECT_SLUG = /slug:\s*'([a-z0-9_]+)'/

const lineOf = (text, index) => text.slice(0, index).split('\n').length

function scanModelFile(file) {
  const text = readFileSync(file, 'utf8')
  filesScanned += 1
  const slug = text.match(SUBJECT_SLUG)?.[1] ?? ''

  for (const match of text.matchAll(FIELD_LITERAL)) {
    const name = match[1] ?? match[4] ?? ''
    const type = match[2] ?? match[3] ?? ''
    if (name === '') continue
    fieldsScanned += 1
    const at = `${file}:${lineOf(text, match.index)}`

    if (isCatalogueOwnedFieldName(name)) {
      violations.push(
        `${at}  [no-catalogue-field-in-cms] field '${name}' — price, duration, bookability and VAT ` +
          'belong to the catalogue (B-CAT-03) and are read from it at render time. A second copy in the ' +
          'CMS is the one that goes stale.',
      )
    }

    if (isCrossBoundaryReference(name) && type !== 'uuidRef' && type !== 'text') {
      violations.push(
        `${at}  [catalogue-reference-must-be-a-plain-uuid] field '${name}' is declared '${type}' — a ` +
          'cross-boundary reference is a UUID in a plain text column with no foreign key, because the ' +
          'catalogue and the CMS schemas are migrated on separate cycles.',
      )
    }

    if (slug === 'therapist_narrative' && isNameShapedFieldName(name)) {
      violations.push(
        `${at}  [therapist-narrative-carries-no-name] field '${name}' — a therapist has no display ` +
          'name until an admin sets one, and the place it is set is the employee record.',
      )
    }
  }
}

function* filesIn(dir, extensions) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* filesIn(full, extensions)
    else if (extensions.some((extension) => entry.name.endsWith(extension))) yield full
  }
}

for (const dir of MODEL_DIRS) {
  try {
    statSync(dir)
  } catch {
    continue
  }
  for (const file of filesIn(dir, ['.ts'])) scanModelFile(file)
}

// --- pass 2: the two stylesheets stay apart ----------------------------------------------------
const IMPORT_SPECIFIER = /(?:from\s*|import\s*|@import\s*)['"]([^'"]+)['"]/g

let appFilesScanned = 0
for (const file of filesIn(APP_DIR, ['.ts', '.tsx', '.css', '.scss'])) {
  const text = readFileSync(file, 'utf8')
  appFilesScanned += 1
  const inPayloadGroup = file.includes(PAYLOAD_GROUP)

  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1] ?? ''
    const at = `${file}:${lineOf(text, match.index)}`

    if (inPayloadGroup && specifier.endsWith(SITE_STYLESHEET)) {
      violations.push(
        `${at}  [payload-admin-must-not-load-the-site-stylesheet] imports '${specifier}' — globals.css ` +
          "clears Tailwind's colour, spacing, radius and font namespaces with ': initial' and defines " +
          "ours; Payload's admin brings its own. Whichever lands second wins, and the symptom is an " +
          'admin with no spacing scale.',
      )
    }

    if (!inPayloadGroup && ADMIN_STYLESHEETS.some((sheet) => specifier.startsWith(sheet))) {
      violations.push(
        `${at}  [payload-admin-must-not-load-the-site-stylesheet] imports '${specifier}' outside the ` +
          `${PAYLOAD_GROUP} route group — the admin's stylesheet belongs to the admin's document, and on ` +
          "a public page it overrides the site's reset.",
      )
    }
  }
}

// --- pass 3: the generated Payload config ------------------------------------------------------
let configFields = 0
let configSubjects = 0
try {
  const module = await import('../apps/web/payload.config.ts')
  const sanitized = await module.default
  const subjects = [
    ...sanitized.collections.map((collection) => ({
      slug: collection.slug,
      fields: collection.fields,
    })),
    ...sanitized.globals.map((global) => ({ slug: global.slug, fields: global.fields })),
  ]
  configSubjects = subjects.length
  for (const subject of subjects) configFields += subject.fields.length

  for (const violation of boundaryViolations(subjects)) {
    violations.push(
      `apps/web/payload.config.ts  [${violation.rule}] ${violation.where}: ${violation.message}`,
    )
  }
} catch (error) {
  // Not a skip. A config that cannot be built is a config nothing has checked, and reporting success on
  // it is the ADR 0002 failure — a green tick over zero modules.
  console.error('Could not build the Payload config, so its fields were never examined:\n')
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exit(1)
}

// --- report -----------------------------------------------------------------------------------
if (fieldsScanned === 0 || configFields === 0 || appFilesScanned === 0) {
  console.error(
    'The CMS boundary check examined nothing and is refusing to report success ' +
      `(${fieldsScanned} declared field(s), ${configFields} generated field(s), ` +
      `${appFilesScanned} app file(s)).`,
  )
  process.exit(1)
}

if (violations.length > 0) {
  console.error('CMS boundary violations:\n')
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(`\n${violations.length} violation(s).`)
  process.exit(1)
}

console.log(
  `The catalogue boundary holds: ${fieldsScanned} declared field(s) across ${filesScanned} model ` +
    `file(s), ${configFields} field(s) across ${configSubjects} collection(s) and global(s) in the ` +
    `generated Payload config, and ${appFilesScanned} app file(s) with the two stylesheets kept apart.`,
)
