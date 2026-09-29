/**
 * What a private document IS, who may read one, and which ones may be fetched only once (W-SYS-14).
 *
 * ## The hole this closes
 *
 * Every statutory document this build writes was written to a path a caller chose. `writeTaxDocumentPdf`
 * in `@berelax/pdf` takes a `path` and calls `writeFileSync`, so a filed tax invoice — issuer TRN,
 * customer name, every line and every figure — is readable by anybody who learns the path, and nothing
 * records a read. Private storage was DEFERRED by M-TILL-12 to M-TILL-13 and M-VAT-11, both of which went
 * `done` without ever owning storage, so it was owed by nobody.
 *
 * ## Why the classification is here and the crypto is not
 *
 * This module is the POLICY: the closed set of document classes, the permission each one requires, and
 * whether a link to it may be followed twice. It is pure, so it is enumerable as a table of assertions
 * against the whole role matrix rather than exercised through a route (ADR 0009's third property).
 *
 * The signature is `@berelax/media`'s (`storage/signing.ts`), because an HMAC needs `node:crypto` and the
 * purity gate refuses it here. That split is the one that matters: **the signature authorises a FETCH and
 * never a principal**, so the two questions — *is this link genuine* and *may this reader have this
 * document* — are answered by two modules that cannot be confused for each other. A scheme where the
 * signature carried the role would make a forwarded link a role grant.
 *
 * ## Why the permission is the matrix's and not a second copy
 *
 * `REQUIRED_PERMISSION` maps a class onto a permission that already exists, and the route asks `can()`.
 * Nothing here re-decides who may read a tax document: the accountant holds `report:financial` and the
 * marketer does not, and that is one statement in `permissions.ts`. A second table saying which roles may
 * download a payslip would be the copy that disagrees — and it would disagree in the direction where a
 * role gains a document it lost in the matrix, because a widened matrix is reviewed and a download table
 * is not.
 */
import { AppError } from '@berelax/shared'
import {
  can,
  canReadFieldGroup,
  type FieldGroup,
  type Permission,
  type Role,
} from '../access/permissions.ts'

/**
 * Every kind of private document this build produces, found by walking the producers rather than guessed.
 *
 * The set is CLOSED, and the closure is the unit's whole claim: a document class that is not here has no
 * permission mapped to it, so `documentReadRefusal` denies it by default and migration 0101 refuses to
 * store it at all. A new producer is therefore a diff to this array — which is the difference between one
 * place every private document goes through and a convention.
 *
 * Where each one comes from today:
 *
 *   - `tax_invoice` / `tax_credit_note` — `buildTaxDocument` plus `@berelax/pdf`'s renderer, the documents
 *     `writeTaxDocumentPdf` was writing to a caller-chosen path. The hole named in the manifest.
 *   - `vat_return_snapshot` — M-VAT-08's sealed return (`vat_return`, migration 0095). A filed return is a
 *     snapshot and not a query (ADR 0044), so the bytes somebody filed are a document.
 *   - `payslip` — P-HR-07's attendance and P-HR-11's commission, rendered per employee. NOT produced by
 *     anything today, and it is in the set anyway: `employee.salary` is the field group whose whole point
 *     is that the floor manager does not hold it, and a class added later by the unit that renders one
 *     would be a class added under deadline. See the NOTE on this in `build/manifest.yaml`.
 *   - `clinical_extract` — C-CRM-10's erasure and subject-access answer. Same position as `payslip`: no
 *     producer writes one yet, and the class that must be single-use is the one to declare early.
 *   - `compliance_evidence` — M-VAT-11's `obligation_evidence`, which already has a private route of its
 *     own behind a STORED grant. Registered here so the register is complete; see the ADR on why that
 *     route is not rewritten by this unit.
 */
export const PRIVATE_DOCUMENT_CLASSES = [
  'tax_invoice',
  'tax_credit_note',
  'vat_return_snapshot',
  'payslip',
  'clinical_extract',
  'compliance_evidence',
] as const

export type PrivateDocumentClass = (typeof PRIVATE_DOCUMENT_CLASSES)[number]

const CLASS_SET: ReadonlySet<string> = new Set(PRIVATE_DOCUMENT_CLASSES)

/**
 * Whether a link to this class may be followed more than once.
 *
 * `single_use` is not "more secret". It is a statement about what a SECOND fetch means. A tax invoice is a
 * document the customer already holds a copy of and the accountant re-opens whenever the books are read:
 * refusing the second fetch there would produce a screen that works once and then reports a security
 * refusal, which is how a control gets switched off. A payslip and a clinical extract are different —
 * there is no legitimate reason for one link to yield two copies of somebody's wage or their treatment
 * history, and the replay is the whole of how a forwarded link becomes a leak.
 */
export const DOCUMENT_USE_POLICIES = ['replayable', 'single_use'] as const
export type DocumentUsePolicy = (typeof DOCUMENT_USE_POLICIES)[number]

interface PrivateDocumentClassDefinition {
  /** What the document is, in one sentence, for the screen that offers it and for a reader of the log. */
  readonly describes: string
  /** The matrix permission a reader must hold. Never a new one where an existing one already says it. */
  readonly permission: Permission
  /**
   * The field group whose contents are ON the document, where there is one.
   *
   * Checked IN ADDITION to the permission, because the two are not the same question and the matrix keeps
   * them apart for a reason ADR 0009 states: the manager holds `employee:read` and not `employee.salary`,
   * so a payslip gated on `payroll:read` alone would still be refused to a manager — and a payslip gated
   * on the field group alone would be open to anybody who could read an employment record.
   */
  readonly fieldGroup: FieldGroup | undefined
  readonly use: DocumentUsePolicy
}

/**
 * The class table. One row per class, and every permission in it is one `permissions.ts` already declares.
 *
 * The two `report:financial` classes rather than `ledger:read`: the auditor holds both and the marketer
 * holds neither, and the distinction that matters is the accountant — who holds `report:financial` and is
 * the role that files a return. `invoice:issue` would have been wrong for `tax_invoice`, because issuing a
 * document and reading a filed one are different acts and the receptionist legitimately does the first.
 */
export const PRIVATE_DOCUMENT_CLASS_DEFINITIONS: Readonly<
  Record<PrivateDocumentClass, PrivateDocumentClassDefinition>
> = Object.freeze({
  tax_invoice: {
    describes: 'A filed tax invoice: the issuer TRN, the customer, every line and every figure.',
    permission: 'report:financial',
    fieldGroup: undefined,
    use: 'replayable',
  },
  tax_credit_note: {
    describes: 'A filed credit note, with the invoice it reverses named on it.',
    permission: 'report:financial',
    fieldGroup: undefined,
    use: 'replayable',
  },
  vat_return_snapshot: {
    describes: 'The bytes of a filed VAT return, as filed (ADR 0044).',
    permission: 'vat_return:prepare',
    fieldGroup: undefined,
    use: 'replayable',
  },
  payslip: {
    describes: "One employee's pay for one period, including the wage.",
    permission: 'payroll:read',
    fieldGroup: 'employee.salary',
    use: 'single_use',
  },
  clinical_extract: {
    describes: "A subject-access or erasure extract of one customer's clinical record.",
    permission: 'clinical_note:read',
    fieldGroup: 'clinical.notes',
    use: 'single_use',
  },
  compliance_evidence: {
    describes:
      'An attachment filed against a compliance obligation — an inspection report, a permit.',
    permission: 'settings:write_compliance',
    fieldGroup: undefined,
    use: 'replayable',
  },
})

/** Whether the string is a class this build knows. Deny by default: an unknown class is not a class. */
export function isPrivateDocumentClass(value: string): value is PrivateDocumentClass {
  return CLASS_SET.has(value)
}

/**
 * The classes whose links may be followed only once, in a form a migration and a gate can both compare.
 *
 * Derived rather than listed a second time. Migration 0101 stores the policy on the row, because the
 * database is where the replay is refused — a check-then-insert in TypeScript is two statements and two
 * concurrent fetches pass both — and gate case 129j holds the two lists equal.
 */
export const SINGLE_USE_DOCUMENT_CLASSES: readonly PrivateDocumentClass[] =
  PRIVATE_DOCUMENT_CLASSES.filter(
    (name) => PRIVATE_DOCUMENT_CLASS_DEFINITIONS[name].use === 'single_use',
  )

/** The use policy for a class. Throws for an unknown one rather than guessing `replayable`. */
export function documentUsePolicy(documentClass: PrivateDocumentClass): DocumentUsePolicy {
  const definition = PRIVATE_DOCUMENT_CLASS_DEFINITIONS[documentClass]
  if (definition === undefined) {
    throw new AppError(
      'invariant_violated',
      `[unknown-private-document-class] '${documentClass}' is not a private document class, so there is ` +
        'no answer to whether a link to it may be followed twice. Guessing `replayable` here would make ' +
        'an unclassified document the MOST permissive one.',
      { details: { documentClass } },
    )
  }
  return definition.use
}

/**
 * Why a reader may not have this document, or `undefined` when they may.
 *
 * Every refusal is a named reason rather than a boolean, because the three are different facts to whoever
 * reads the log: an unknown class is a document that should never have been stored, a missing permission
 * is somebody reaching outside their role, and a missing field group is somebody whose role legitimately
 * reaches the record and not the figure on it.
 */
export const DOCUMENT_ACCESS_REFUSALS = [
  'document_class_unknown',
  'permission_denied',
  'field_group_denied',
] as const
export type DocumentAccessRefusal = (typeof DOCUMENT_ACCESS_REFUSALS)[number]

export function documentReadRefusal(
  role: Role,
  documentClass: string,
): DocumentAccessRefusal | undefined {
  if (!isPrivateDocumentClass(documentClass)) return 'document_class_unknown'
  const definition = PRIVATE_DOCUMENT_CLASS_DEFINITIONS[documentClass]
  if (!can(role, definition.permission)) return 'permission_denied'
  if (definition.fieldGroup !== undefined && !canReadFieldGroup(role, definition.fieldGroup)) {
    return 'field_group_denied'
  }
  return undefined
}

/**
 * How long a private document link lives.
 *
 * Fifteen minutes, and it is the same figure M-VAT-11 chose for its stored evidence grant — deliberately
 * the same rather than a second number, because two link lifetimes in one product is a thing somebody has
 * to explain. Long enough to open a document, fail a download and open it again; short enough that a link
 * in a chat transcript, an agent log or a browser history is dead before anybody reads it. It is a
 * technical policy with a stated reason and not a legal figure.
 */
export const DOCUMENT_SIGNATURE_TTL_SECONDS = 15 * 60
