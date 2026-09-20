import { AppError } from '@berelax/shared'

/**
 * Authorisation, as pure data and pure functions.
 *
 * Three properties matter more than the specific grants:
 *
 *   1. **Deny by default.** A permission that is not explicitly granted is refused. There is no
 *      wildcard except the one the `owner` role holds deliberately, and no "if unsure, allow".
 *   2. **Field level, not just route level.** A receptionist legitimately needs the client record in
 *      order to take a booking, and must not see the clinical notes on it. Route-level checks cannot
 *      express that, so sensitive fields are grouped and granted separately.
 *   3. **Pure.** This is in `packages/core`, so it has no database, no session, no request. It
 *      answers "may this role do this?" and nothing else, which makes the whole matrix testable.
 */

export const ROLES = [
  'owner',
  'manager',
  'accountant',
  'receptionist',
  'therapist',
  'marketer',
  'auditor',
  'system',
] as const

export type Role = (typeof ROLES)[number]

/** `resource:action`. Namespaced so the matrix stays readable and greppable. */
export const PERMISSIONS = [
  // Booking and the front desk
  'booking:read',
  'booking:create',
  'booking:reschedule',
  'booking:cancel',
  'booking:override_constraints',
  'calendar:read',
  'walkin:create',

  // The appointment lifecycle (B-LIFE-01). One permission per state a transition can reach, which is
  // what lets `packages/core/src/lifecycle/transitions.ts` declare who may perform each move ONCE, in
  // data, and check it through `can()` — instead of a hand-rolled role comparison at each call site,
  // which is how two call sites come to disagree about who may cancel.
  //
  // `booking:cancel` above is the customer-requested cancellation, which the front desk records.
  // Cancelling on the SALON's behalf and marking a no-show are separate permissions because they are
  // the two moves the front desk may not make alone: one breaks the salon's own commitment and carries
  // a refund, the other writes a judgement against the customer that a fee policy will later attach
  // money to (B-LIFE-03). Neither is granted to `system`: marking a no-show is a judgement, not a
  // sweep, and a background worker that could take it would take it at 03:00 with nobody to ask.
  'booking:confirm',
  'booking:check_in',
  'booking:start',
  'booking:complete',
  'booking:mark_no_show',
  'booking:cancel_as_salon',

  // Catalogue
  'catalogue:read',
  'catalogue:write',
  'price:write',

  // Customers
  'customer:read',
  'customer:write',
  'customer:merge',
  'customer:export',
  'customer:blocklist',

  // Clinical — deliberately split, see FIELD_GROUPS
  'clinical_flags:read',
  'clinical_note:read',
  'clinical_note:write',

  // Money
  'till:operate',
  'invoice:issue',
  'invoice:credit_note',
  'payment:refund',
  'ledger:read',
  'ledger:post',
  'period:lock',
  'vat_return:prepare',
  'cost:write',

  // People
  'employee:read',
  'employee:write',
  'payroll:read',
  'payroll:run',
  'leave:request',
  'leave:approve',
  'rota:read',
  'rota:publish',
  'commission:read',

  // Marketing
  'campaign:read',
  'campaign:send',
  'segment:write',
  'template:write',
  'template:approve',

  // Content and SEO
  'content:write',
  'content:publish',
  'seo_agent:configure',

  // Platform
  'settings:read',
  'settings:write',
  'settings:write_compliance',
  'audit:read',
  'agent:configure',
  'integration:connect',
  'report:read',
  'report:financial',
] as const

export type Permission = (typeof PERMISSIONS)[number]

/**
 * Groups of sensitive fields, granted separately from the record that contains them.
 *
 * This is the mechanism behind "a receptionist can see that a client has a contraindication flag but
 * cannot read the note behind it".
 */
export const FIELD_GROUPS = [
  'clinical.notes',
  'clinical.flags',
  'employee.salary',
  'employee.bank',
  'employee.identity_documents',
  'customer.contact',
  'customer.spend_history',
] as const

export type FieldGroup = (typeof FIELD_GROUPS)[number]

interface RoleDefinition {
  readonly description: string
  readonly permissions: readonly Permission[] | 'all'
  readonly fieldGroups: readonly FieldGroup[] | 'all'
  /** Roles that must complete a second factor. Anything touching money, people or settings. */
  readonly requiresTotp: boolean
}

const RECEPTIONIST_PERMISSIONS = [
  'booking:read',
  'booking:create',
  'booking:reschedule',
  'booking:cancel',
  // The lifecycle moves the front desk makes all evening: accept a request, record an arrival, start
  // the treatment, close it at the till. Deliberately NOT `booking:mark_no_show` or
  // `booking:cancel_as_salon` — see the catalogue above.
  'booking:confirm',
  'booking:check_in',
  'booking:start',
  'booking:complete',
  'calendar:read',
  'walkin:create',
  'catalogue:read',
  'customer:read',
  'customer:write',
  // Sees THAT there is a contraindication, never the note behind it.
  'clinical_flags:read',
  'till:operate',
  'invoice:issue',
  'rota:read',
  'settings:read',
] as const satisfies readonly Permission[]

export const ROLE_DEFINITIONS: Readonly<Record<Role, RoleDefinition>> = Object.freeze({
  owner: {
    description: 'The proprietor. Everything, including compliance-locked settings.',
    permissions: 'all',
    fieldGroups: 'all',
    requiresTotp: true,
  },
  manager: {
    description: 'Runs the floor. Operations and people, but not compliance controls.',
    permissions: [
      ...RECEPTIONIST_PERMISSIONS,
      'booking:override_constraints',
      // The two lifecycle moves the front desk may not make alone (B-LIFE-01).
      'booking:mark_no_show',
      'booking:cancel_as_salon',
      'catalogue:write',
      'customer:merge',
      'customer:blocklist',
      'invoice:credit_note',
      'payment:refund',
      'employee:read',
      'employee:write',
      'leave:approve',
      'rota:publish',
      'commission:read',
      'campaign:read',
      'segment:write',
      'content:write',
      'report:read',
      'audit:read',
      'settings:write',
      'agent:configure',
    ],
    /**
     * `employee.bank` and `employee.identity_documents` were added by P-HR-01. `employee.salary` was
     * deliberately NOT.
     *
     * The manager holds the HR file: docs/04 §7's credential registry, the visa and Emirates ID expiry
     * dates that gate bookable availability, and the bank account a WPS file pays into. `employee:write`
     * without those two groups is a permission that cannot do its job — the screen that files a document
     * cannot read the number it is filing — and the way that gets resolved under pressure is a wider
     * grant made in a hurry.
     *
     * Pay is different and stays with the owner and the accountant. A wage is a term of employment the
     * proprietor sets and the books record; the floor manager needs the account a salary is sent to, not
     * the amount. It is also what keeps the field-level projection honest rather than theoretical:
     * `manager` is the role that holds `employee:read` and not `employee.salary`, so
     * `projectEmployeeRecord` really does drop the wage columns for somebody, and
     * `packages/hr/src/employee.itest.ts` asserts it on a real row.
     *
     * Still NOT `clinical.notes`: the floor manager has no clinical role, and that is a different
     * boundary (ADR 0010). Every read of a bank or identity field, by any role, writes an audit row with
     * a declared purpose — `packages/hr/src/employee-repository.ts` — which is the insider-threat
     * control docs/06 D4 asks for, and it is what makes these two grants reviewable rather than invisible.
     */
    fieldGroups: [
      'clinical.flags',
      'customer.contact',
      'customer.spend_history',
      'employee.bank',
      'employee.identity_documents',
    ],
    requiresTotp: true,
  },
  accountant: {
    description: 'Books and filings. Every financial record, no clinical data.',
    permissions: [
      'ledger:read',
      'ledger:post',
      'period:lock',
      'vat_return:prepare',
      'cost:write',
      'invoice:issue',
      'invoice:credit_note',
      'payroll:read',
      'payroll:run',
      'commission:read',
      'report:read',
      'report:financial',
      'customer:read',
      'catalogue:read',
      'settings:read',
      'audit:read',
    ],
    // Salary and bank are needed to run payroll; clinical data never is.
    fieldGroups: ['employee.salary', 'employee.bank', 'customer.spend_history'],
    requiresTotp: true,
  },
  receptionist: {
    description: 'Front desk. Bookings, checkout, client records without clinical notes.',
    permissions: RECEPTIONIST_PERMISSIONS,
    fieldGroups: ['clinical.flags', 'customer.contact'],
    requiresTotp: false,
  },
  therapist: {
    description: 'Delivers treatments. Own schedule, client preferences, contraindication flags.',
    permissions: [
      'calendar:read',
      'booking:read',
      // The therapist starts the treatment they are about to give, from the room. The front desk
      // records the arrival and closes the till; neither of those is theirs.
      'booking:start',
      'customer:read',
      'catalogue:read',
      'clinical_flags:read',
      'clinical_note:read',
      'clinical_note:write',
      'leave:request',
      'rota:read',
      'commission:read',
    ],
    // A therapist reads the clinical note for the client in front of them; it is their record of
    // treatment. They never see salary, bank details or spend history.
    fieldGroups: ['clinical.flags', 'clinical.notes'],
    requiresTotp: false,
  },
  marketer: {
    description: 'Campaigns and content. Segments, never individual contact details.',
    permissions: [
      'campaign:read',
      'campaign:send',
      'segment:write',
      'template:write',
      'content:write',
      'catalogue:read',
      'report:read',
      'settings:read',
    ],
    // Deliberately NOT customer.contact: a marketer works with segments and counts, and exporting
    // the client list is the insider-threat path this closes.
    fieldGroups: [],
    requiresTotp: false,
  },
  auditor: {
    description: 'Read-only oversight, including the audit trail. Writes nothing.',
    permissions: ['audit:read', 'ledger:read', 'report:read', 'report:financial', 'settings:read'],
    fieldGroups: [],
    requiresTotp: true,
  },
  system: {
    description: 'Background workers and agents. No interactive login exists for this role.',
    permissions: [
      'booking:read',
      'calendar:read',
      'customer:read',
      'catalogue:read',
      'ledger:post',
      'campaign:send',
      'content:write',
      'report:read',
    ],
    fieldGroups: [],
    requiresTotp: false,
  },
})

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS)
const FIELD_GROUP_SET: ReadonlySet<string> = new Set(FIELD_GROUPS)

/** Deny by default: an unknown permission string is refused, not treated as ungated. */
export function can(role: Role, permission: Permission): boolean {
  if (!PERMISSION_SET.has(permission)) return false
  const def = ROLE_DEFINITIONS[role]
  return def.permissions === 'all' ? true : def.permissions.includes(permission)
}

/**
 * Deny by default, including for an unknown GROUP — which this did not do until P-HR-01.
 *
 * `can()` has refused an unrecognised permission string since F07; this function had no equivalent
 * check, so the two halves of one policy disagreed in the direction that matters. A role with
 * `fieldGroups: 'all'` returned `true` for any string at all, so `owner` was granted a group nobody had
 * declared — and the group nobody has declared is a field somebody has just added. The type system does
 * not close it: every caller that reaches this with a value from a record, a URL or a JSON body has a
 * `string` widened to `FieldGroup` somewhere behind it, which is precisely the case a runtime check is
 * for. Asserted by the deny-by-default case in `permissions.test.ts`, with the wildcard role.
 */
export function canReadFieldGroup(role: Role, group: FieldGroup): boolean {
  if (!FIELD_GROUP_SET.has(group)) return false
  const def = ROLE_DEFINITIONS[role]
  return def.fieldGroups === 'all' ? true : def.fieldGroups.includes(group)
}

export function requiresTotp(role: Role): boolean {
  return ROLE_DEFINITIONS[role].requiresTotp
}

/** Throws rather than returning false, for use at a call site that must not proceed. */
export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw new AppError('forbidden', `Role "${role}" may not ${permission}`, {
      details: { role, permission },
    })
  }
}

export function assertCanReadFieldGroup(role: Role, group: FieldGroup): void {
  if (!canReadFieldGroup(role, group)) {
    throw new AppError('forbidden', `Role "${role}" may not read ${group}`, {
      details: { role, group },
    })
  }
}

/**
 * Removes field groups the role may not read.
 *
 * Used at the boundary where a record leaves the data layer, so a forgotten check cannot leak a
 * salary or a clinical note into a JSON response.
 *
 * **An unmapped field is KEPT**, and that is deliberate for the records this was written for — an
 * appointment or a customer, where most fields are innocuous and `fieldMap` names the exceptions. It is
 * the wrong default for a record whose fields are mostly sensitive, because there the field somebody
 * forgets to map is the one most likely to be a wage or an identity number. The employment record is
 * therefore CLOSED instead: `packages/core/src/hr/employee.ts` classifies every field and refuses one it
 * does not classify. Do not change the rule here to match it — the two records want opposite defaults,
 * and a single default would either leak an unmapped salary or strip every ordinary column off every
 * other record in the system.
 */
export function redactForRole<T extends Record<string, unknown>>(
  role: Role,
  record: T,
  fieldMap: Readonly<Record<string, FieldGroup>>,
): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    const group = fieldMap[key]
    if (group === undefined || canReadFieldGroup(role, group)) out[key] = value
  }
  return out as Partial<T>
}

/** Permissions that may only be changed as an audited action, never silently. */
export const COMPLIANCE_LOCKED: readonly Permission[] = ['settings:write_compliance'] as const
