import { AppError } from '@berelax/shared'
import { can, type FieldGroup, type Role } from '../access/permissions.ts'
import { EMPLOYEE_FIELD_GROUPS, type EmployeeFieldSensitivity } from './employee.ts'

/**
 * The staff portal's access rule and its field policy (P-HR-14).
 *
 * ## The rule is SELF, and it has no role that widens it
 *
 * `/hr/me` answers one question — *what does the system hold about the person holding this session* — and
 * the only subject it can have is that person. So {@link assertPortalSubject} compares two employee ids and
 * refuses when they differ, **for every role including the owner**. That is deliberately stronger than the
 * rule next door: `mayReadPayslip` and `mayReadCommissionDerivation` both widen on `payroll:read`, because
 * an accountant running payroll legitimately reads somebody else's figures. Nothing legitimately reads
 * somebody else's `/hr/me`.
 *
 * Making it unconditional is what removes the failure mode the acceptance line is about. A rule of the form
 * "self, or a permission" is one grant away from a therapist reading a colleague's wage — a role given
 * `payroll:read` for a reporting screen would acquire the portal with it, invisibly. A rule with no
 * permission in it cannot be widened by a grant at all, so the only way to widen it is to edit this
 * function, which is a diff somebody has to justify.
 *
 * The admin estate keeps its per-employee screens and their own authority: `/hr/payroll` for a run,
 * `/hr/commission` for a derivation, `/hr/rota` for the roster. A manager who needs a colleague's figures
 * goes there. The portal is not the way in.
 *
 * ## The refusal is in the QUERY and not in the view
 *
 * Every portal reader in `@berelax/hr` calls this BEFORE it issues a statement, so a request naming another
 * employee never reaches SQL. A filtered read would have been the easy version and it answers the wrong
 * question: a therapist handed an empty list has been told "you have no shifts", which is a statement about
 * them rather than a refusal, and the difference is exactly what somebody probing for a colleague's row
 * would be reading. `packages/fixtures/src/staff-portal.itest.ts` proves the statement is never issued by
 * asserting the refusal arrives with the colleague's rows PRESENT in the table.
 *
 * ## The field policy is CLOSED and the bank number is not in it
 *
 * {@link PORTAL_EMPLOYEE_FIELDS} enumerates every employment-record field the portal may put on a page, and
 * {@link portalFieldPolicyProblems} refuses one whose sensitivity is anything but `open`. So salary, the
 * identity-document group and the two sealed bank fields are not reachable through this surface, by anybody,
 * including the person they belong to — `EMPLOYEE_FIELD_GROUPS` is the single classification and this is a
 * subset of it rather than a second list.
 *
 * The therapist's own bank detail is shown as {@link PORTAL_BANK_MASK}, and the honest statement about that
 * mask is that **it is not a redaction of a value the page held**. {@link portalBankView} has nowhere to put
 * an account number: the portal never calls `readBankDetail`, so no code path decrypts one and there is no
 * field a future edit could print it into. A mask over a value the renderer holds is one `safeText` away
 * from being the value; this one is the absence of the value, stated on the page so the therapist can see
 * that an account is on file without the number being anywhere in the response.
 */

/** The four surfaces the portal answers for. Enumerated so the refusal test can iterate them. */
export const PORTAL_SURFACES = ['schedule', 'leave', 'commission', 'payslip'] as const

export type PortalSurface = (typeof PORTAL_SURFACES)[number]

/**
 * The refusal's name, which is what a test asserts rather than the sentence.
 *
 * A name and not a message: ADR 0003 asks a check to fail BY THE NAME of the rule, and a message is the
 * part that gets reworded. It is carried in `details.refusal` as well as in the text.
 */
export const PORTAL_SELF_ONLY_REFUSAL = 'portal_subject_is_not_the_viewer' as const

/** The portal's whole access rule: the subject is the viewer, or there is no answer. */
export function isPortalSubjectTheViewer(args: {
  readonly viewerEmployeeId: string
  readonly subjectEmployeeId: string
}): boolean {
  return args.viewerEmployeeId === args.subjectEmployeeId
}

/**
 * {@link isPortalSubjectTheViewer} as a refusal, placed before the statement that would read the row.
 *
 * `role` is taken and deliberately NOT consulted for the decision. It is here so the refusal can say which
 * role was refused — the operator reading the log needs it — and so a reader of this signature can see that
 * the role is an argument the answer does not depend on. `self-service.test.ts` asserts every role in the
 * matrix is refused a colleague's subject, which is the case that would start passing if a permission crept
 * into the condition.
 */
export function assertPortalSubject(args: {
  readonly surface: PortalSurface
  readonly role: Role
  readonly viewerEmployeeId: string
  readonly subjectEmployeeId: string
}): void {
  if (isPortalSubjectTheViewer(args)) return
  throw new AppError(
    'forbidden',
    `${PORTAL_SELF_ONLY_REFUSAL}: the staff portal answers for the signed-in employee and for nobody ` +
      `else, so the ${args.surface} surface is refused. Role "${args.role}" does not change that and no ` +
      "permission does: a colleague's figures are read on the admin screens (/hr/payroll, /hr/commission, " +
      '/hr/rota), which have their own authority rules.',
    {
      details: {
        refusal: PORTAL_SELF_ONLY_REFUSAL,
        surface: args.surface,
        role: args.role,
        viewerEmployeeId: args.viewerEmployeeId,
        subjectEmployeeId: args.subjectEmployeeId,
      },
    },
  )
}

/** The refusal an error carries, or null. Lets a route branch without matching on a message. */
export function portalRefusalOf(error: unknown): typeof PORTAL_SELF_ONLY_REFUSAL | null {
  const refusal = error instanceof AppError ? error.details['refusal'] : undefined
  return refusal === PORTAL_SELF_ONLY_REFUSAL ? PORTAL_SELF_ONLY_REFUSAL : null
}

/**
 * Every employment-record field the portal may render, enumerated.
 *
 * A list and not a predicate over `EMPLOYEE_FIELD_GROUPS`, because "the open fields" is not the claim: the
 * claim is that this screen shows these fields, and a predicate would silently acquire whatever `open`
 * field somebody adds next. {@link portalFieldPolicyProblems} is what holds the list to the classification,
 * in the one direction that matters.
 */
export const PORTAL_EMPLOYEE_FIELDS = [
  'staffReference',
  'employedFrom',
  'employedUntil',
  'contractType',
  'displayName',
] as const

export type PortalEmployeeField = (typeof PORTAL_EMPLOYEE_FIELDS)[number]

/** The field groups the portal may never expose, named so the failure message can print them. */
export const PORTAL_FORBIDDEN_FIELD_GROUPS: readonly FieldGroup[] = Object.freeze([
  'employee.salary',
  'employee.bank',
  'employee.identity_documents',
])

/**
 * Names of fields in `fields` that the portal may not expose, with the group that forbids each.
 *
 * Returned rather than thrown so the test prints every problem at once, and so the empty array is the
 * assertion. An UNCLASSIFIED field is a problem too and is reported as such: `EMPLOYEE_FIELD_GROUPS` is
 * closed (see `employee.ts`), so a name it does not know is a typo or a field somebody has just added, and
 * both of those must fail rather than default to visible.
 */
export function portalFieldPolicyProblems(
  fields: readonly string[] = PORTAL_EMPLOYEE_FIELDS,
): readonly string[] {
  const classification: Readonly<Record<string, EmployeeFieldSensitivity>> = EMPLOYEE_FIELD_GROUPS
  const problems: string[] = []
  for (const field of fields) {
    const sensitivity = classification[field]
    if (sensitivity === undefined) {
      problems.push(
        `${field} is not classified by EMPLOYEE_FIELD_GROUPS, so the portal cannot know whether it is a ` +
          'wage. An unclassified field is refused rather than shown.',
      )
      continue
    }
    if (sensitivity !== 'open') {
      problems.push(`${field} is ${sensitivity}, which the staff portal may not expose.`)
    }
  }
  return problems
}

/**
 * What stands in for the account number on the portal.
 *
 * Bullets and not the last four digits, and that is the decision rather than a style. A tail is a real
 * disclosure — four digits of an IBAN plus a staff reference is enough to confirm a guess — and it would
 * have to come from somewhere, which means either decrypting the sealed payload on a page render or
 * denormalising a tail onto a column that every raw `select` then returns. Both are a worse trade than a
 * therapist having to ask the office which account is on file.
 */
export const PORTAL_BANK_MASK = '••••••••••••••••' as const

/**
 * What the portal says about the viewer's own bank account.
 *
 * `label` is `employee_bank_detail.label`, which is NOT a sealed column (0050) — it is the human handle
 * payroll files the account under. `maskedNumber` is a constant, so this type has no field an account
 * number could arrive in; see the module header on why that is the claim rather than a mask over a value.
 */
export interface PortalBankView {
  readonly onFile: boolean
  readonly label: string | null
  readonly filedOn: string | null
  readonly maskedNumber: typeof PORTAL_BANK_MASK
}

export function portalBankView(args: {
  readonly onFile: boolean
  readonly label: string | null
  readonly filedOn: string | null
}): PortalBankView {
  return {
    onFile: args.onFile,
    // Dropped when nothing is on file: a label with no account behind it is a sentence about an account
    // that does not exist, and the screen would read as though payroll were configured.
    label: args.onFile ? args.label : null,
    filedOn: args.onFile ? args.filedOn : null,
    maskedNumber: PORTAL_BANK_MASK,
  }
}

/**
 * Whether a role may use the portal at all.
 *
 * `leave:request` is the grant, because the one WRITE the portal has is a leave request and every role that
 * holds that grant has an employment record to show. It is asked as a permission rather than as a role list
 * for the matrix's reason: a role given `leave:request` tomorrow gets the portal without an edit here.
 *
 * Note what this does NOT do: it never widens {@link assertPortalSubject}. A role may be refused the portal
 * entirely and no role may be granted somebody else's.
 */
export function mayUseStaffPortal(role: Role): boolean {
  return can(role, 'leave:request')
}
