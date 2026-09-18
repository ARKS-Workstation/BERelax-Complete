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
    fieldGroups: ['clinical.flags', 'customer.contact', 'customer.spend_history'],
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

/** Deny by default: an unknown permission string is refused, not treated as ungated. */
export function can(role: Role, permission: Permission): boolean {
  if (!PERMISSION_SET.has(permission)) return false
  const def = ROLE_DEFINITIONS[role]
  return def.permissions === 'all' ? true : def.permissions.includes(permission)
}

export function canReadFieldGroup(role: Role, group: FieldGroup): boolean {
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
