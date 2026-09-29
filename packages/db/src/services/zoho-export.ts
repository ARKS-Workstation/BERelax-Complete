import { createHash } from 'node:crypto'
import { AppError } from '@berelax/shared'
import type { UnitOfWork } from '../tx.ts'
import { type VatReturnForFiling, vatReturnForFiling } from './vat-return-signoff.ts'

/**
 * The one-way export of a signed VAT return, for an accountant to carry into Zoho Books.
 *
 * M-VAT-09. ADR 0017 and docs/01 decision 13: this codebase has **no capability to file a return** —
 * *"absent, not disabled, because a future maintainer will eventually switch a flag on"*. ADR 0052 records
 * what makes that structural rather than stated, and this module is the thing the absence is drawn around:
 * the furthest a figure travels towards the tax authority is a file a person is handed.
 *
 * ## Four properties, and the mechanism for each
 *
 *   1. **It runs only for a signed return.** There is exactly ONE read here, {@link vatReturnForFiling},
 *      and the refusal is `ZY055` raised inside `vat_return_for_filing()` — in the database, on a READ.
 *      Nothing is checked in this module, deliberately: a guard here would be a guarantee about the callers
 *      that came through here, and 0095's header names the three writers that do not (a `psql` session, a
 *      restored dump, and the next caller who writes a filing path without reading this one).
 *   2. **Every figure in the file comes out of the hashed bytes.** `snapshotJson` arrives from that same
 *      read and is the only source of a number below. Not `vat_return_box_figure`, although that view would
 *      give the same answer today: a second read is a second answer, and this file's whole claim is that it
 *      reconciles to the SIGNED snapshot rather than to whatever the ledger says now (ADR 0044).
 *   3. **It reads nothing ambient.** No clock, no environment, no credentials, no configuration. The
 *      acceptance line is that the export "succeeds with no environment variables or credentials set", and
 *      the reason it can is that there is nowhere for one to arrive: nothing is transmitted.
 *   4. **It is one-way.** No export here reads from the accounting package, and there is no client to read
 *      with. `tax-and-filing-must-not-reach-the-network` in `.dependency-cruiser.cjs` refuses the import
 *      and `scripts/test-no-autofile.mjs` refuses the global, the name and the SQL that would go round the
 *      door — because `fetch` is a global and a module graph is blind to it.
 *
 * ## Why the bytes carry no instant and no person
 *
 * {@link renderZohoVatReturn} takes the filing row and NOTHING else, so the same signed return exports to
 * the same bytes for ever. That is what makes the file hash in the audit row worth recording: it answers
 * "is this the file we handed over" rather than "is this a file somebody made at some point". An
 * `exported_at` or an `exported_by` line inside the file would make every export a different artefact and
 * the hash an identifier for nothing.
 *
 * Both facts are recorded — in the `audit_event`, where `occurred_at` is the database's own and the
 * exporting user is in the payload. That is also the right side of a privacy line: the file goes into a
 * third-party accounting package, and the names of the two people who signed the return are in
 * `vat_return_sign_off` and in the audit trail because that is where a system of record keeps them, not in
 * an export that has no need of them.
 *
 * ## What the file is, and what it deliberately is not
 *
 * It is a transcription aid: the box figures of a signed snapshot, in integer fils, with the content hash
 * that ties them to the return two people put their names to. It carries **no TRN, no registered name, no
 * address and no authority reference**, and that is brief rule 15 rather than minimalism — every one of
 * those is unanswered ([UNVERIFIED] Y1-trn, Y11-vat201-boxes, Y11-tax-agent), and a plausible one is
 * indistinguishable from a configured one.
 *
 * It is **not** Zoho Books' own import format. Which columns that package expects for a VAT return is
 * [UNVERIFIED] Y11-zoho-import, and inventing a set would be inventing an integration contract — the same
 * mistake as inventing a TRN, one layer out. So the file declares its own format tag,
 * {@link ZOHO_EXPORT_FORMAT_VERSION}, and answering that question is a new format version beside this one
 * rather than a silent change in what every previously exported file meant.
 *
 * Amounts are **integer fils and nothing else**. A decimal column would be a second money formatter in a
 * package that may not import `@berelax/core` (brief rule 4), and it would be one a spreadsheet parses as a
 * double on the way to the accounting package — which is the drift ADR 0007 exists to prevent, arriving
 * through the one file nobody would think to check.
 */

/** This file's own format tag. Not Zoho Books' format; see the header and [UNVERIFIED] Y11-zoho-import. */
export const ZOHO_EXPORT_FORMAT_VERSION = 'berelax.vat201.zoho.v1'

/** The media type of the bytes. A CSV, so the accountant can open it in front of the package. */
export const ZOHO_EXPORT_MEDIA_TYPE = 'text/csv'

/**
 * Raised when the hashed bytes do not carry the figures this module needs.
 *
 * `invariant_violated` rather than `validation`: `snapshot_json` is tied to `content_hash` by a CHECK in
 * 0095 and the row is append-only, so bytes this module cannot read are not a caller's mistake — they are a
 * snapshot taken by a version of the working papers whose shape this module does not know. Refusing loudly
 * is the point: a renderer that tolerated a missing field would put an empty column in a file somebody
 * types into a tax return.
 */
export class ZohoExportSnapshotUnreadable extends AppError {
  constructor(message: string, details: Record<string, unknown>) {
    super('invariant_violated', message, { details })
    this.name = 'ZohoExportSnapshotUnreadable'
  }
}

/**
 * Every function this module exports, and whether it can only act on a signed return.
 *
 * M-VAT-08's `VAT_RETURN_CONSUMERS` in the same shape and for the same reason: the acceptance line asks
 * the export to run "only for a signed return", and a closed list compared against the module's REAL
 * exports is what makes that a check rather than a sentence. `zoho-export.itest.ts` compares them, so a
 * function added here cannot arrive without somebody deciding in writing whether it can see an unsigned
 * return.
 *
 * The `false` entries are the load-bearing half, because a list where everything required a signature would
 * be the same thing as no list.
 */
export interface ZohoExportSurfaceEntry {
  /** The exported function's name, exactly. */
  readonly export: string
  readonly requiresSignedReturn: boolean
  /** Why it does or does not. Stated per entry, so a wrong answer is visible rather than inherited. */
  readonly why: string
}

export const ZOHO_EXPORT_SURFACE: readonly ZohoExportSurfaceEntry[] = [
  {
    export: 'exportVatReturnForZoho',
    requiresSignedReturn: true,
    why:
      'It is the export. Its one read is vat_return_for_filing(), which raises ZY055 for a return that ' +
      'is not signed by two different people and marked final — in the database, so a caller that came ' +
      'round this module is refused by the same code.',
  },
  {
    export: 'renderZohoVatReturn',
    requiresSignedReturn: false,
    why:
      'Pure formatting over a row the caller already holds. It reads no database, so it cannot be the ' +
      'door and a check inside it would be one: what it requires is a VatReturnForFiling, and the only ' +
      'thing in this repository that produces one is the gated read. A caller determined to render bytes ' +
      'from an unsigned snapshot would have to FABRICATE a finalisation instant, which is visible in a ' +
      'diff in a way a skipped boolean is not.',
  },
  {
    export: 'zohoExportFilename',
    requiresSignedReturn: false,
    why:
      'The filename, from the period, the version and the content hash. It is a name rather than a ' +
      'figure, and it is exported so a screen can say what the download will be called before asking ' +
      'the database for it.',
  },
] as const

// --- the shapes a caller reads -------------------------------------------------------------------

/** One box of the signed snapshot, as the file states it. Amounts are integer fils. */
export interface ZohoExportBoxRow {
  readonly boxNo: number
  readonly label: string
  readonly side: 'output' | 'input'
  readonly displayOrder: number
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  readonly netSuppliesFils: bigint
  readonly taxFils: bigint
  readonly lineCount: number
}

/** The snapshot's own reasons against filing, out of the same bytes. */
export interface ZohoExportNotFileableRow {
  readonly reason: string
  readonly openQuestionId: string
  readonly detail: string
}

/**
 * The totals the file states, and the figures the acceptance line reconciles.
 *
 * `netTaxDueFils` is `outputTaxFils - inputTaxFils` and may be negative — a period whose recoverable input
 * tax exceeds its output tax is a repayment, not an error, and a total clamped at zero would be a figure
 * this module invented.
 */
export interface ZohoExportTotals {
  readonly outputNetSuppliesFils: bigint
  readonly outputTaxFils: bigint
  readonly inputNetSuppliesFils: bigint
  readonly inputTaxFils: bigint
  readonly netTaxDueFils: bigint
}

/**
 * The rendered file and the figures it states.
 *
 * One return value rather than a renderer plus two accessors, so the bytes and the totals a caller asserts
 * against them are produced by ONE walk of the hashed snapshot. Two walks would be two answers, and the
 * whole subject of ADR 0044 is figures that must not be able to disagree.
 */
export interface ZohoVatReturnDocument {
  readonly csv: string
  readonly boxes: readonly ZohoExportBoxRow[]
  readonly notFileableReasons: readonly ZohoExportNotFileableRow[]
  readonly totals: ZohoExportTotals
}

export interface ZohoVatReturnExport {
  readonly filename: string
  readonly mediaType: typeof ZOHO_EXPORT_MEDIA_TYPE
  /** The deliverable. UTF-8, and the only thing {@link fileHash} is over. */
  readonly bytes: Uint8Array
  /** sha256 of {@link bytes}, hex. Recorded on the `audit_event`. */
  readonly fileHash: string
  readonly byteLength: number
  readonly returnId: string
  readonly version: number
  /** The signed snapshot's hash. What ties these bytes to the figures two people put their names to. */
  readonly contentHash: string
  readonly totals: ZohoExportTotals
}

export interface ExportVatReturnForZohoInput {
  readonly returnId: string
  /**
   * Who is exporting. Recorded on the `audit_event` and NOT written into the file.
   *
   * The display name is the one the user is signed in as and is never composed here (brief rule 10).
   */
  readonly exportedBy: { readonly userId: string; readonly displayName: string }
}

// --- reading the hashed bytes --------------------------------------------------------------------

/**
 * The refusal, as a value to `throw` rather than a function that throws.
 *
 * Returned and thrown at the call site so TypeScript narrows after it. A helper that threw internally would
 * need `never` plumbing at every branch below, and the casts that plumbing invites are exactly how a field
 * this module cannot read becomes an empty column instead of a refusal.
 */
const unreadable = (what: string, returnId: string, found: unknown): ZohoExportSnapshotUnreadable =>
  new ZohoExportSnapshotUnreadable(
    `The signed snapshot of VAT return ${returnId} does not carry ${what}, so an export of it would ` +
      'state a figure this module made up. snapshot_json is tied to content_hash by a CHECK (0095) and ' +
      'the row is append-only, so this is a snapshot shape this module does not know rather than a ' +
      'caller error: the working-paper format version is what has to change with it.',
    { returnId, field: what, found: typeof found === 'string' ? found : typeof found },
  )

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/**
 * A decimal-string amount from the canonical form, as a `bigint`.
 *
 * `canonicaliseVat201WorkingPapers` turns every `bigint` into a decimal STRING, because `bigint` has no
 * JSON representation and `JSON.stringify` throws on one. So the bytes hold `"20000"`, and reading it back
 * as a `number` is what `trial-balance.ts` records producing a four-fils difference out of nothing.
 */
function amount(value: unknown, what: string, returnId: string): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw unreadable(`${what} as a decimal string`, returnId, value)
  }
  return BigInt(value)
}

function text(value: unknown, what: string, returnId: string): string {
  if (typeof value !== 'string') throw unreadable(what, returnId, value)
  return value
}

function counted(value: unknown, what: string, returnId: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw unreadable(`${what} as an integer`, returnId, value)
  }
  return value
}

function box(entry: unknown, returnId: string): ZohoExportBoxRow {
  const raw = asObject(entry)
  if (raw === null) throw unreadable('a box object', returnId, entry)
  const side = text(raw['side'], 'a box side', returnId)
  if (side !== 'output' && side !== 'input') {
    throw unreadable('a box side of "output" or "input"', returnId, side)
  }
  const openQuestionId = raw['openQuestionId']
  if (openQuestionId !== null && typeof openQuestionId !== 'string') {
    throw unreadable('a box open-question id or null', returnId, openQuestionId)
  }
  const isProvisional = raw['isProvisional']
  if (typeof isProvisional !== 'boolean') {
    throw unreadable('a box provisional flag', returnId, isProvisional)
  }
  return {
    boxNo: counted(raw['boxNo'], 'a box number', returnId),
    label: text(raw['label'], 'a box label', returnId),
    side,
    displayOrder: counted(raw['displayOrder'], 'a box display order', returnId),
    isProvisional,
    openQuestionId,
    netSuppliesFils: amount(raw['netSuppliesFils'], 'a box net supplies figure', returnId),
    taxFils: amount(raw['taxFils'], 'a box tax figure', returnId),
    lineCount: counted(raw['lineCount'], 'a box line count', returnId),
  }
}

function notFileableRow(entry: unknown, returnId: string): ZohoExportNotFileableRow {
  const raw = asObject(entry)
  if (raw === null) throw unreadable('a reason object', returnId, entry)
  return {
    reason: text(raw['reason'], 'a reason', returnId),
    openQuestionId: text(raw['openQuestionId'], 'a reason open-question id', returnId),
    detail: text(raw['detail'], 'a reason detail', returnId),
  }
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The boxes and the reasons against filing, read out of the snapshot bytes.
 *
 * Boxes are ordered by `displayOrder` then `boxNo`, so the file's row order is a property of the figures
 * rather than of the order a JSON parser happened to walk an array in. Y11-vat201-boxes will renumber the
 * live `vat201_box` rows and this snapshot keeps the numbering it was signed under (ADR 0044), which is
 * exactly why the sort has a second key: two snapshots of different vintages must each order stably.
 */
function readSnapshot(filing: VatReturnForFiling): {
  boxes: readonly ZohoExportBoxRow[]
  notFileableReasons: readonly ZohoExportNotFileableRow[]
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(filing.snapshotJson)
  } catch (err) {
    throw unreadable(
      'parseable JSON',
      filing.returnId,
      err instanceof Error ? err.message : String(err),
    )
  }
  const paper = asObject(parsed)
  if (paper === null) throw unreadable('a JSON object', filing.returnId, parsed)
  const rawBoxes = paper['boxes']
  if (!Array.isArray(rawBoxes)) throw unreadable('a boxes array', filing.returnId, rawBoxes)
  const rawReasons = paper['notFileableReasons']
  if (!Array.isArray(rawReasons)) {
    throw unreadable('a notFileableReasons array', filing.returnId, rawReasons)
  }

  const boxes = rawBoxes.map((entry: unknown) => box(entry, filing.returnId))
  const reasons = rawReasons.map((entry: unknown) => notFileableRow(entry, filing.returnId))
  return {
    boxes: [...boxes].sort((a, b) => a.displayOrder - b.displayOrder || a.boxNo - b.boxNo),
    notFileableReasons: [...reasons].sort(
      (a, b) => compare(a.reason, b.reason) || compare(a.openQuestionId, b.openQuestionId),
    ),
  }
}

/** The totals, summed over the boxes of the signed snapshot. */
function totalsOf(boxes: readonly ZohoExportBoxRow[]): ZohoExportTotals {
  const sideTotal = (which: 'output' | 'input') =>
    boxes
      .filter((entry) => entry.side === which)
      .reduce(
        (into, entry) => ({ net: into.net + entry.netSuppliesFils, tax: into.tax + entry.taxFils }),
        {
          net: 0n,
          tax: 0n,
        },
      )
  const output = sideTotal('output')
  const input = sideTotal('input')
  return {
    outputNetSuppliesFils: output.net,
    outputTaxFils: output.tax,
    inputNetSuppliesFils: input.net,
    inputTaxFils: input.tax,
    netTaxDueFils: output.tax - input.tax,
  }
}

// --- the bytes -----------------------------------------------------------------------------------

/**
 * One CSV field, quoted per RFC 4180 when it has to be.
 *
 * Quoted on a leading or trailing space as well as on the three characters the format requires, because a
 * label whose whitespace a reader trims is a label that no longer matches the snapshot it came from.
 */
function field(value: string | number | bigint | boolean | null): string {
  const raw = value === null ? '' : String(value)
  const needsQuoting = /[",\r\n]/.test(raw) || raw !== raw.trim()
  return needsQuoting ? `"${raw.replace(/"/g, '""')}"` : raw
}

const line = (...cells: readonly (string | number | bigint | boolean | null)[]) =>
  cells.map(field).join(',')

/**
 * `LF`, not `CRLF`.
 *
 * RFC 4180 says CRLF and every reader in use accepts LF, and the deciding argument is the other one: these
 * bytes are hashed and the hash is the audit trail's answer to "is this the file we handed over". A line
 * ending a checkout, an editor or a copy through a Windows tool can rewrite makes that hash a fact about
 * the transport. `pnpm invisibles` refuses a stray CR anywhere in this tree for the same reason.
 */
const NEWLINE = '\n'

/**
 * The export, from the signed return and NOTHING else.
 *
 * One argument, so the same signed return renders the same bytes for ever — see the header on why an
 * instant or a user inside the file would make the recorded file hash meaningless.
 *
 * The shape is four labelled sections rather than one wide table, because the file states three different
 * kinds of thing — what this return is, what its figures are, and why it may not be filed — and a single
 * header row over all three would pad two of them with empty columns. Each section opens with
 * `section,<name>` so a reader never has to guess from the column count.
 */
export function renderZohoVatReturn(filing: VatReturnForFiling): ZohoVatReturnDocument {
  const { boxes, notFileableReasons } = readSnapshot(filing)
  const totals = totalsOf(boxes)

  const lines: readonly string[] = [
    line('section', 'return'),
    line('key', 'value'),
    line('export_format_version', ZOHO_EXPORT_FORMAT_VERSION),
    // Said in the file, not only in a comment. The file leaves this system and is read by somebody who has
    // not read ADR 0017, and the one thing they must not conclude is that anything has been filed.
    line(
      'nothing_here_has_been_filed',
      'this system has no capability to file a return (ADR 0017)',
    ),
    line('working_paper_format_version', filing.formatVersion),
    line('return_id', filing.returnId),
    line('period_id', filing.periodId),
    line('starts_on', filing.startsOn),
    line('ends_on', filing.endsOn),
    line('return_version', filing.version),
    line('snapshot_content_hash', filing.contentHash),
    line('engine_signature', filing.engineSignature),
    line('finalised_at', filing.finalisedAt.toISOString()),
    line('amount_unit', 'fils'),
    '',
    line('section', 'boxes'),
    line(
      'box_no',
      'label',
      'side',
      'net_supplies_fils',
      'tax_fils',
      'line_count',
      'is_provisional',
      'open_question_id',
    ),
    ...boxes.map((entry) =>
      line(
        entry.boxNo,
        entry.label,
        entry.side,
        entry.netSuppliesFils,
        entry.taxFils,
        entry.lineCount,
        entry.isProvisional,
        entry.openQuestionId,
      ),
    ),
    '',
    line('section', 'totals'),
    line('key', 'value'),
    line('output_net_supplies_fils', totals.outputNetSuppliesFils),
    line('output_tax_fils', totals.outputTaxFils),
    line('input_net_supplies_fils', totals.inputNetSuppliesFils),
    line('input_tax_fils', totals.inputTaxFils),
    line('net_tax_due_fils', totals.netTaxDueFils),
    '',
    line('section', 'not_fileable'),
    line('reason', 'open_question_id', 'detail'),
    ...notFileableReasons.map((entry) => line(entry.reason, entry.openQuestionId, entry.detail)),
  ]
  return { csv: `${lines.join(NEWLINE)}${NEWLINE}`, boxes, notFileableReasons, totals }
}

/**
 * The filename: the period, the version and the first twelve characters of the content hash.
 *
 * The hash is in the name because a period can have several versions and a version can be re-exported, and
 * the question somebody asks of a file on a disk six months later is which return it is of. Everything
 * outside `A-Za-z0-9._-` is replaced: `period_id` is free text a human chose, and a `/` in it would make
 * this a path rather than a name.
 */
export function zohoExportFilename(filing: VatReturnForFiling): string {
  const safePeriod = filing.periodId.replace(/[^A-Za-z0-9._-]/g, '_')
  return `vat201-${safePeriod}-v${filing.version}-${filing.contentHash.slice(0, 12)}.csv`
}

// --- the door ------------------------------------------------------------------------------------

/**
 * Exports a signed, final VAT return as bytes an accountant carries into Zoho Books.
 *
 * Refused with `ZY055` — `VatReturnNotSignedOff` — while the return is unsigned or not marked final, by
 * `vat_return_for_filing()` and not by anything here. On that refusal nothing is produced and nothing is
 * recorded: the read comes first, so the caller gets no bytes and the transaction has written no audit row.
 *
 * The audit row is written by this function rather than left to the caller, and it is in the same
 * transaction as the read that produced the bytes, so the file and the evidence of it cannot separate. It
 * carries the exporting user, the return version and the file hash — the three things the acceptance line
 * names — and `occurred_at` is the database's own clock rather than an argument nobody can check.
 *
 * There is deliberately no outbox event. An event type is a vocabulary, and nothing subscribes to this one:
 * the reader of "what did we hand the accountant, and when" is the audit trail, which is append-only
 * (ADR 0008) and is where that question is already asked of every other export in this system.
 */
export async function exportVatReturnForZoho(
  uow: UnitOfWork,
  input: ExportVatReturnForZohoInput,
): Promise<ZohoVatReturnExport> {
  const filing = await vatReturnForFiling(uow.sql, input.returnId)
  const document = renderZohoVatReturn(filing)
  const bytes = new TextEncoder().encode(document.csv)
  const fileHash = createHash('sha256').update(bytes).digest('hex')
  const filename = zohoExportFilename(filing)

  await uow.audit.record({
    action: 'vat_return.zoho_export',
    entityType: 'vat_return',
    entityId: filing.returnId,
    operation: 'export',
    after: {
      // The exporting user by id AND by the name they are signed in as. `audit_event.actor_id` is a uuid
      // column, so an application user id that is not one cannot go there — which is why this is here and
      // not only in the actor.
      exportedByUserId: input.exportedBy.userId,
      exportedByDisplayName: input.exportedBy.displayName,
      returnVersion: filing.version,
      fileHash,
      // The snapshot's hash beside the file's. Two different questions: "is this the file we handed over"
      // and "is it of the return they signed".
      contentHash: filing.contentHash,
      periodId: filing.periodId,
      filename,
      byteLength: bytes.byteLength,
      exportFormatVersion: ZOHO_EXPORT_FORMAT_VERSION,
    },
  })

  return {
    filename,
    mediaType: ZOHO_EXPORT_MEDIA_TYPE,
    bytes,
    fileHash,
    byteLength: bytes.byteLength,
    returnId: filing.returnId,
    version: filing.version,
    contentHash: filing.contentHash,
    totals: document.totals,
  }
}
