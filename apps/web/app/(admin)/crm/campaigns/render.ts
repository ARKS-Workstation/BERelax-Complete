import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import { ADMIN_SHELL_CSS, renderAdminChromeClose, renderAdminChromeOpen } from '@berelax/ui/admin'
import {
  ADMIN_BANNER_CSS,
  type AdminChrome,
  renderAdminBanner,
} from '../../../../src/components/admin/google-reauth-banner.ts'

/**
 * The campaigns screen, as HTML (C-AUTO-10).
 *
 * Pure: rows in, a document out. No database and no clock — every figure on the page is a function of
 * what it is given, which is what lets `apps/web/src/campaigns-render.test.ts` assert the screen without
 * a server and what makes two renders of one set of rows byte-identical.
 *
 * ## Why a route handler and not a page
 *
 * The reason the pipeline board, the Messages inbox, the template editor and the compliance calendar all
 * give: W-SITE-01's registry requires every *document* to be served in both locales, so a `page.tsx`
 * here would need an Arabic admin document and the W-SYS-01 shell.
 *
 * ## The one thing the markup has to get right
 *
 * **A count is never shown without the instant it was taken at.** C-AUTO-10's provisional answer says so
 * in as many words — *"the timestamp shown next to the number rather than hidden"* — and the reason is
 * that the number sits above a send button: a recipient count with no date is an invitation to spend
 * money against a figure of unknown age. `segmentCountFreshness` in `@berelax/core` returns the age on
 * BOTH verdicts so a caller that has the verdict has the age, and this file puts them in the same cell so
 * there is nothing to omit without omitting the number too.
 *
 * It is READ-ONLY. Creating, estimating and launching a campaign are the sender's and the API's, and a
 * screen that could launch one would be a second place the cap and the window are decided — which is
 * exactly what migration 0154 and `promotional-window.ts` exist to prevent. Y6-sender-ids is open, so no
 * campaign can leave this build at all yet.
 */

export interface CampaignRowView {
  readonly campaignKey: string
  readonly title: string
  readonly state: string
  readonly haltedReason: string | null
  readonly capFils: number
  readonly spentFils: number
  readonly estimatedRecipients: number | null
  readonly estimatedSegments: number | null
  readonly estimatedFils: number | null
  readonly scheduledAtIso: string | null
  /** Counted rows, from one query. `held + sent == total` is how a halted campaign is read. */
  readonly sent: number
  readonly held: number
  readonly total: number
  readonly segmentKey: string
  /** The segment's cached count, and the instant it was taken. Never one without the other. */
  readonly segmentCount: number | null
  readonly segmentCountAtIso: string | null
  readonly segmentCountIsStale: boolean | null
}

export interface CampaignsView {
  readonly chrome: AdminChrome
  readonly campaigns: readonly CampaignRowView[]
  /** The OPEN-QUESTIONS id the cap and the sender identities are tracked under. The page cites it. */
  readonly openQuestionId: string
  /** The cap every new campaign is created with, in fils, and the fact that it is provisional. */
  readonly defaultCapFils: number
}

/** `12,345 fils`. Fils, not a formatted AED amount: the cap and the spend are integer fils (ADR 0007). */
const fils = (value: number): string => `${value.toLocaleString('en-AE')} fils`

const CAMPAIGNS_CSS = `
main{max-width:70rem;margin:0 auto;padding:var(--space-4,1rem);font-family:var(--font-body,system-ui)}
table{width:100%;border-collapse:collapse}
th,td{text-align:start;padding:var(--space-2,.5rem);border-bottom:1px solid var(--colour-border)}
.lede p{max-width:60ch}
.stale{font-weight:700}
.empty{padding:var(--space-4,1rem)}
`

/** One row's cached count and its age, in one cell. See the file's note on why they are inseparable. */
function segmentCountCell(row: CampaignRowView): string {
  if (row.segmentCount === null || row.segmentCountAtIso === null) {
    return '<td data-testid="segment-count">Never counted</td>'
  }
  const staleness = row.segmentCountIsStale === true ? ' <span class="stale">(stale)</span>' : ''
  return (
    '<td data-testid="segment-count">' +
    `${safeText(String(row.segmentCount))} as at ` +
    `<time datetime="${safeText(row.segmentCountAtIso)}">${safeText(row.segmentCountAtIso)}</time>` +
    `${staleness}</td>`
  )
}

function campaignRow(row: CampaignRowView): string {
  const estimate =
    row.estimatedFils === null
      ? 'Not estimated'
      : `${row.estimatedRecipients ?? 0} recipient(s) × ${row.estimatedSegments ?? 0} segment(s) = ${fils(row.estimatedFils)}`
  const halted = row.haltedReason === null ? '' : ` (${safeText(row.haltedReason)})`
  return [
    `<tr data-testid="campaign-row" data-campaign-key="${safeText(row.campaignKey)}">`,
    `<th scope="row">${safeText(row.title)}<br><code>${safeText(row.campaignKey)}</code></th>`,
    `<td>${safeText(row.state)}${halted}</td>`,
    `<td><code>${safeText(row.segmentKey)}</code></td>`,
    segmentCountCell(row),
    `<td data-testid="campaign-estimate">${safeText(estimate)}</td>`,
    `<td data-testid="campaign-spend">${safeText(fils(row.spentFils))} of ${safeText(fils(row.capFils))}</td>`,
    `<td data-testid="campaign-outcome">${row.sent} sent, ${row.held} held, ${row.total} total</td>`,
    '</tr>',
  ].join('')
}

export function renderCampaignsHtml(view: CampaignsView): string {
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: `apps/web/src/seo/brand.test.ts` requires the full trading name wherever the
    // brand appears, and an internal screen naming it would be citing the wrong entity.
    '<title>Campaigns — admin</title>',
    `<style>${tokensCss()}${ADMIN_SHELL_CSS}${CAMPAIGNS_CSS}${ADMIN_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    renderAdminChromeOpen({
      title: 'Campaigns',
      path: '/crm/campaigns',
      role: view.chrome.role,
      staffReference: view.chrome.staffReference,
    }),
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Campaigns</h1>',
    '<div class="lede">',
    '<p><strong>Every count on this page carries the instant it was taken.</strong> A recipient count ' +
      'with no date is a figure of unknown age above a decision to spend money, so the number and its ' +
      'timestamp are one cell and a count older than the staleness window says so.</p>',
    '<p>The cap is the database’s, not this screen’s. A campaign reserves each message against ' +
      '<code>campaign.cap_fils</code> in the same statement that claims the recipient, so two senders ' +
      'cannot both decide one more message fits — and a campaign that reaches its cap stops and ' +
      'holds the rest of its list rather than spending past it.</p>',
    `<p>No campaign can leave this build yet: the sender identities are unconfigured and are tracked as ` +
      `<code data-testid="campaigns-open-question">${safeText(view.openQuestionId)}</code>. The default ` +
      `cap a new campaign is created with is ${safeText(fils(view.defaultCapFils))}, which is a ` +
      `provisional figure and not a budget anybody has stated.</p>`,
    '</div>',
    view.campaigns.length === 0
      ? '<p class="empty" data-testid="campaigns-empty">No campaigns have been created.</p>'
      : [
          '<table data-testid="campaigns-table">',
          '<thead><tr><th scope="col">Campaign</th><th scope="col">State</th>',
          '<th scope="col">Segment</th><th scope="col">Contacts</th><th scope="col">Estimate</th>',
          '<th scope="col">Spend</th><th scope="col">Outcome</th></tr></thead>',
          `<tbody>${view.campaigns.map(campaignRow).join('')}</tbody>`,
          '</table>',
        ].join(''),
    '</main>',
    renderAdminChromeClose(),
    '</body>',
    '</html>',
  ].join('\n')
}
