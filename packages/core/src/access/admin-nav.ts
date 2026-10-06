import { can, type Permission, type Role } from './permissions.ts'

/**
 * The admin's navigation, as data.
 *
 * ## Why this exists
 *
 * Until now the operational admin had **no navigation at all**. Each of its screens is a route handler
 * emitting a complete HTML document, and none of them linked to any other: you reached a screen by typing
 * its path. Fifty-three routes, no way between them. That is the gap this file and
 * `packages/ui/src/admin/shell.ts` close.
 *
 * ## Why the registry is here and not in the UI package
 *
 * Because every item carries a `permission`, and the thing that answers a permission is `can()`, two lines
 * up. A navigation bar that showed a receptionist the payroll link would be a worse failure than a missing
 * link: it invites a click that ends in a refusal, and it discloses what exists. So visibility is decided
 * by the same matrix that decides access, in the same package, and `adminNavFor` is a pure function of a
 * role.
 *
 * It is NOT an authorisation boundary and must never be read as one. The route's own guard is. Hiding a
 * link from a menu is a courtesy to the reader; `guardAdminRoute` and `assertCan` are the fence. A test
 * asserts the pairing in both directions so the menu cannot drift into being the only check.
 *
 * ## Why `href` is a literal rather than a route id
 *
 * `apps/web/src/routes/registry.ts` is the registry for DOCUMENTS — pages that must exist in both locales
 * with canonical URLs and alternates. The admin is deliberately outside it: there is no Arabic admin, and
 * `noindex` screens have no canonical form. So these paths are literals here, and
 * `admin-nav.test.ts` holds them against the route handlers actually on disk — which is the check that
 * matters, because a link to a path nobody serves is the one failure a types system cannot see.
 */

export interface AdminNavItem {
  /** The path, absolute and without a locale prefix. The admin is English-only by design. */
  readonly href: string
  readonly label: string
  /**
   * What a reader must be allowed to do for this item to appear.
   *
   * One permission and not a list: an item whose visibility depended on several would need a rule about
   * whether they are all required or any of them, and every screen here has one obvious answer to "what
   * is this for". Where a screen genuinely serves two audiences it appears twice, under both groups.
   */
  readonly permission: Permission
  /**
   * Query the link must carry to answer at all, when the screen refuses a bare request.
   *
   * `/reports` and `/accounts/reconciliation` both do this deliberately — "a screen that answered for
   * 'the last thirty days' answers a different question every day" — so a menu linking to them bare would
   * send every reader to a 400. The shell fills these from the current trading window rather than this
   * file inventing a default, because a default here would be the very thing those screens refuse.
   */
  readonly needsWindow?: 'period' | 'from-to'
}

export interface AdminNavGroup {
  readonly id: string
  readonly label: string
  readonly items: readonly AdminNavItem[]
}

/**
 * Every screen in the `(admin)` group that a person navigates TO, grouped the way the work is grouped.
 *
 * Deliberately absent, and each for a reason rather than an oversight:
 *
 *   * `/login` — reached by being signed out, never by a signed-in reader.
 *   * `/clients/[id]/…`, `/reviews/[id]`, `/documents/[id]`, `/hr/leave/[id]`,
 *     `/compliance/evidence/[evidenceId]`, `/settings/media/preview/[mediaId]` — a menu cannot link to a
 *     row. They are reached from the list that holds them.
 *   * `/crm/flows/api`, the two `/settings/…/revalidate` endpoints,
 *     `/settings/integrations/test-connection`, `/reviews/[id]/mark-posted` — endpoints a form posts to,
 *     not documents. (Written without a glob on purpose: a `*` followed by a slash closes a block comment,
 *     and this comment did exactly that until the parser said so.)
 *   * `/hr/me` — in `Workforce`, because it is the one HR screen every role may open.
 */
export const ADMIN_NAV: readonly AdminNavGroup[] = [
  {
    id: 'today',
    label: 'Today',
    items: [
      { href: '/reports', label: 'Dashboard', permission: 'calendar:read', needsWindow: 'from-to' },
      { href: '/calendar', label: 'Calendar', permission: 'calendar:read' },
      { href: '/day-sheet/print', label: 'Day sheet', permission: 'calendar:read' },
      { href: '/quick-book', label: 'Quick book', permission: 'walkin:create' },
    ],
  },
  {
    id: 'front-desk',
    label: 'Front desk',
    items: [
      { href: '/checkout', label: 'Checkout', permission: 'invoice:issue' },
      { href: '/till', label: 'Till', permission: 'till:operate' },
      { href: '/till/cash-up', label: 'Cash up', permission: 'till:operate' },
      { href: '/packages', label: 'Packages', permission: 'catalogue:read' },
    ],
  },
  {
    id: 'clients',
    label: 'Clients',
    items: [
      { href: '/clients/duplicates', label: 'Duplicates', permission: 'customer:merge' },
      { href: '/crm/pipeline', label: 'Pipeline', permission: 'customer:read' },
    ],
  },
  {
    id: 'accounts',
    label: 'Accounts',
    items: [
      {
        href: '/accounts/reconciliation',
        label: 'Reconciliation',
        permission: 'ledger:read',
        needsWindow: 'period',
      },
    ],
  },
  {
    id: 'workforce',
    label: 'Workforce',
    items: [
      { href: '/hr/me', label: 'My record', permission: 'leave:request' },
      { href: '/hr/rota', label: 'Rota', permission: 'rota:read' },
      { href: '/hr/timesheets', label: 'Timesheets', permission: 'employee:read' },
      { href: '/hr/leave', label: 'Leave', permission: 'leave:approve' },
      { href: '/hr/payroll', label: 'Payroll', permission: 'payroll:read' },
      { href: '/hr/commission', label: 'Commission', permission: 'commission:read' },
      { href: '/hr/credentials', label: 'Credentials', permission: 'employee:read' },
      { href: '/hr/reassignment', label: 'Reassignment', permission: 'rota:publish' },
    ],
  },
  {
    id: 'marketing',
    label: 'Marketing',
    items: [
      { href: '/crm/campaigns', label: 'Campaigns', permission: 'campaign:read' },
      { href: '/reviews', label: 'Reviews', permission: 'review:record' },
      { href: '/reviews/paste', label: 'Paste a review', permission: 'review:record' },
      { href: '/messaging/templates/editor', label: 'Templates', permission: 'template:write' },
      { href: '/messaging/controls', label: 'Send controls', permission: 'campaign:send' },
    ],
  },
  {
    id: 'insight',
    label: 'Insight',
    items: [
      {
        href: '/analytics',
        label: 'Analytics',
        permission: 'calendar:read',
        needsWindow: 'from-to',
      },
      { href: '/reports/data-quality', label: 'Data quality', permission: 'calendar:read' },
      { href: '/agents', label: 'Agents', permission: 'content:write' },
      { href: '/agents/seo/suggestions', label: 'SEO suggestions', permission: 'content:write' },
      { href: '/agents/seo/gbp-snapshot', label: 'Business profile', permission: 'content:write' },
    ],
  },
  {
    id: 'governance',
    label: 'Governance',
    items: [
      { href: '/compliance', label: 'Compliance calendar', permission: 'employee:read' },
      { href: '/compliance/unverified', label: 'Unverified evidence', permission: 'employee:read' },
      { href: '/agents/kill-switch', label: 'Kill switch', permission: 'template:approve' },
      { href: '/settings/privacy', label: 'Privacy requests', permission: 'customer:export' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    items: [
      { href: '/settings/integrations', label: 'Integrations', permission: 'content:write' },
      { href: '/settings/messages', label: 'Messages', permission: 'template:write' },
    ],
  },
]

/**
 * The groups a role may see, with the items it may not removed and any group left empty dropped.
 *
 * An empty group is dropped rather than rendered as a heading with nothing under it, because a heading
 * over nothing reads as a loading failure. A role that may see no item at all gets an empty array, and the
 * shell renders the sidebar's own "nothing here" rather than an empty `<nav>` — which is the honest
 * statement for `therapist`, whose only screens are their own record and the rota.
 */
export function adminNavFor(role: Role): readonly AdminNavGroup[] {
  return ADMIN_NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => can(role, item.permission)),
  })).filter((group) => group.items.length > 0)
}

/**
 * The group and item a path belongs to, for the sidebar's current-page state and the breadcrumb.
 *
 * Longest-prefix rather than equality, so `/clients/abc/intake` resolves to the Clients group and
 * `/till/cash-up` to Cash up rather than to Till. Equality alone would leave every row screen with no
 * place in the menu, which is how a sidebar ends up highlighting nothing on half the application.
 */
export function adminNavLocate(
  path: string,
): { readonly group: AdminNavGroup; readonly item: AdminNavItem } | null {
  let best: { group: AdminNavGroup; item: AdminNavItem } | null = null
  for (const group of ADMIN_NAV) {
    for (const item of group.items) {
      if (path !== item.href && !path.startsWith(`${item.href}/`)) continue
      if (best === null || item.href.length > best.item.href.length) best = { group, item }
    }
  }
  return best
}
