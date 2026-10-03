import { agentReasonText, escapeHtml, formatAmount, safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import {
  ADMIN_BANNER_CSS,
  type AdminChrome,
  renderAdminBanner,
} from '../../../src/components/admin/google-reauth-banner.ts'
import {
  AGENT_BUDGET_WARNING_PER_MILLE,
  type AgentConsoleScreen,
  type AgentConsoleScreenRow,
  agentBudgetWarns,
} from './queries.ts'

/**
 * The agent console (G-AGT-02): one row per agent in the registry, with the real reason per agent.
 *
 * Pure: a screen in, bytes out, no database and no clock. That is what lets the capture harness render it
 * twelve times — three viewports × two themes × two directions — with `page.setContent` and no server, and
 * it is why "zero pixel diff on an unchanged rerun" is a property of the bytes rather than of the harness.
 *
 * ## There is no generic error string, and there is nowhere for one to live
 *
 * `agentReasonText` takes an {@link AgentReason}, which is a discriminated union whose every member
 * carries a sentence declared for a named cause or the agent's own `last_error`. `running` carries no
 * text at all and this renderer prints the STATE for it. So there is no branch here that needs a
 * fallback, which is the point: `?? 'An error occurred'` is eleven characters, it reads as defensive
 * programming, and it is the thing that turns a console into a screen nobody trusts. ADR 0116 records
 * that, and `agent-console-render.test.ts` asserts the string appears nowhere in these bytes.
 *
 * ## Why the kill switch is a form and not a link
 *
 * A toggle that changed state on a GET would be togglable by a crawler, a link preview and a browser's
 * own prefetch, and this one stops an agent. One `<form method="post">` per agent, with the agent key and
 * the direction it is being moved in as hidden fields — so a replayed POST moves it to the state the form
 * was rendered for rather than flipping whatever it finds, which is what makes a double submission
 * harmless instead of a race between two operators.
 *
 * ## Why markup rather than a `.tsx`
 *
 * The reason every other admin screen records: `apps/web/src/routes/registry.ts` is in exact bijection
 * with the filesystem and requires every DOCUMENT in both locales, so an admin screen is a route handler
 * returning bytes. The manifest entry names `page.tsx` and `agent-row.tsx`; they are `route.ts` and this
 * file, and the deviation is a NOTE on the entry.
 */

export interface AgentConsoleView {
  /** Both admin banners and the page a reconnect comes back to. Required — see `AdminChrome`. */
  readonly chrome: AdminChrome
  readonly screen: AgentConsoleScreen
  /** Whether this principal may work the kill switches. False renders no control at all. */
  readonly mayToggle: boolean
  readonly direction: 'ltr' | 'rtl'
}

/** The hidden field names the kill-switch form posts. Spelled once; the handler reads these. */
export const KILL_SWITCH_FIELDS = { agentKey: 'agent', desired: 'desired' } as const
export const KILL_SWITCH_PATH = '/agents/kill-switch'
/** The two values `desired` may carry. A state to move TO, never a flip. */
export const KILL_SWITCH_DESIRED = ['on', 'off'] as const
export type KillSwitchDesired = (typeof KILL_SWITCH_DESIRED)[number]

const CONSOLE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 76rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-3); }
  .lede {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    margin: 0 0 var(--space-7);
  }
  .lede p { margin: 0 0 var(--space-3); }
  .lede p:last-child { margin-bottom: 0; }
  ol.agents { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-5); }
  .agent {
    border: 1px solid var(--color-border);
    border-inline-start-width: var(--space-2);
    border-inline-start-color: var(--color-accent-teal);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
  }
  .agent[data-state='paused'] { border-inline-start-color: var(--color-ink-2); }
  .agent[data-state='failing'] { border-inline-start-color: var(--color-danger); }
  .agent[data-state='degraded'] { border-inline-start-color: var(--color-accent-gold); }
  .agent h2 { font-size: 1.0625rem; margin: 0 0 var(--space-2); }
  .agent .purpose { color: var(--color-ink-2); font-size: 0.875rem; margin: 0 0 var(--space-4); }
  .agent .reason {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    background: var(--color-ground);
    padding: var(--space-3) var(--space-4);
    margin: 0 0 var(--space-4);
  }
  .agent dl {
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--space-3) var(--space-5);
  }
  .agent dt { color: var(--color-ink-2); font-size: 0.8125rem; }
  .agent dd { margin: 0; font-variant-numeric: tabular-nums; }
  .agent dd.warn { color: var(--color-danger); font-weight: 600; }
  .agent form { margin: var(--space-4) 0 0; }
  .agent button {
    min-height: 2.75rem;
    padding: var(--space-2) var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-ground);
    color: var(--color-ink);
    cursor: pointer;
  }
  .agent .readonly { color: var(--color-ink-2); font-size: 0.875rem; margin: var(--space-4) 0 0; }
  .dead-letters {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    margin: var(--space-7) 0 0;
  }
  @media (max-width: 40rem) {
    .agent { padding: var(--space-4); }
    .agent dl { grid-template-columns: minmax(0, 1fr); }
  }
`

/** The coarse state the stylesheet and a screenshot key off. Derived from the reason, never from both. */
function stateOf(row: AgentConsoleScreenRow): 'running' | 'paused' | 'failing' | 'degraded' {
  switch (row.reason.kind) {
    case 'kill_switch':
    case 'disabled':
    case 'google_paused':
      return 'paused'
    case 'failing':
    case 'failing_without_words':
    case 'budget_exceeded':
    case 'alert_open':
      return 'failing'
    case 'google_degraded':
      return 'degraded'
    default:
      return 'running'
  }
}

/** An ISO instant, or the named absence. Never a blank cell. */
const instantCell = (iso: string | null, never: string): string =>
  iso === null ? escapeHtml(never) : `<time datetime="${escapeHtml(iso)}">${escapeHtml(iso)}</time>`

/**
 * The money cell: what was spent, the ceiling it was spent against, and the share or the named absence.
 *
 * `formatAmount` is `@berelax/core`'s, over the `Money` the query built. Nothing here divides by 100: a
 * renderer doing its own arithmetic on a money figure is the float ADR 0007 refuses, and the currency is
 * stated once in the label rather than in every cell.
 */
function costCells(row: AgentConsoleScreenRow): string {
  const cost = row.cost
  const share =
    cost.share === null
      ? 'no budget — this agent performs no outbound call, so there is nothing to spend'
      : `${Math.floor(cost.share / 10)}.${cost.share % 10}% of ${formatAmount(cost.ceiling)}`
  const warn = agentBudgetWarns(cost)
  return (
    `<dt>Cost to date (AED)</dt><dd data-cost-fils="${cost.spent.fils}">${escapeHtml(formatAmount(cost.spent))}</dd>` +
    `<dt>Against budget</dt><dd${warn ? ' class="warn"' : ''} data-budget-share="${cost.share ?? ''}" ` +
    `data-budget-warning="${warn ? 'true' : 'false'}">${escapeHtml(share)}</dd>` +
    `<dt>Runs today</dt><dd data-runs="${cost.runs}">${cost.runs}</dd>`
  )
}

function renderRow(row: AgentConsoleScreenRow, mayToggle: boolean): string {
  const reason = agentReasonText(row.reason)
  const state = stateOf(row)
  const pending =
    row.pending === null
      ? '<dt>Awaiting approval</dt><dd data-pending="">— this agent has no queue</dd>'
      : `<dt>Awaiting approval</dt><dd data-pending="${row.pending}">${row.pending}</dd>`
  const desired = row.killSwitch ? 'off' : 'on'
  const control = mayToggle
    ? `<form method="post" action="${escapeHtml(KILL_SWITCH_PATH)}">` +
      `<input type="hidden" name="${KILL_SWITCH_FIELDS.agentKey}" value="${escapeHtml(row.agentKey)}">` +
      `<input type="hidden" name="${KILL_SWITCH_FIELDS.desired}" value="${desired}">` +
      `<button type="submit" data-kill-switch="${escapeHtml(row.agentKey)}" data-desired="${desired}">` +
      `${row.killSwitch ? 'Release the kill switch' : 'Stop this agent'}</button></form>`
    : // No control at all, and not a disabled one: a disabled button is a control somebody can enable
      // from dev tools, and the refusal is the handler's anyway. The sentence says who may.
      '<p class="readonly">Stopping an agent needs the agent:configure permission, which this role does ' +
      'not hold. The toggle is absent rather than disabled: the refusal is the handler’s, and a greyed ' +
      'button would be a control a browser could re-enable.</p>'
  return (
    `<li><article class="agent" data-agent="${escapeHtml(row.agentKey)}" data-state="${state}" ` +
    `data-reason-kind="${escapeHtml(row.reason.kind)}" ` +
    `data-kill-switch-on="${row.killSwitch ? 'true' : 'false'}">` +
    `<h2>${safeText(row.displayName)}</h2>` +
    `<p class="purpose">${safeText(row.purpose)}</p>` +
    (reason === null
      ? '<p class="reason" data-reason="running">Running. The heartbeat records no failure, the ' +
        'watchdog has no open alert, and nothing is switched off.</p>'
      : `<p class="reason" data-reason="${escapeHtml(row.reason.kind)}">${safeText(reason)}</p>`) +
    '<dl>' +
    `<dt>Last run</dt><dd data-last-run="${escapeHtml(row.lastRunAtIso ?? '')}">${instantCell(row.lastRunAtIso, 'never — it has not run')}</dd>` +
    `<dt>Last success</dt><dd data-last-success="${escapeHtml(row.lastSuccessAtIso ?? '')}">${instantCell(row.lastSuccessAtIso, 'never — it has never succeeded')}</dd>` +
    `<dt>Next run</dt><dd data-next-run="${escapeHtml(row.nextRunAtIso ?? '')}">${instantCell(row.nextRunAtIso, 'none scheduled')}</dd>` +
    `<dt>Consecutive failures</dt><dd data-failures="${row.consecutiveFailures}">${row.consecutiveFailures}</dd>` +
    pending +
    costCells(row) +
    '</dl>' +
    control +
    '</article></li>'
  )
}

export function renderAgentConsoleHtml(view: AgentConsoleView): string {
  const screen = view.screen
  return [
    '<!doctype html>',
    `<html lang="en" dir="${view.direction}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    `<title>Agents — ${escapeHtml(screen.tradingDate)} — admin</title>`,
    `<style>${tokensCss()}${CONSOLE_CSS}${ADMIN_BANNER_CSS}</style>`,
    '</head>',
    `<body data-trading-date="${escapeHtml(screen.tradingDate)}" ` +
      `data-google-state="${escapeHtml(screen.googleState ?? 'none')}">`,
    '<main>',
    renderAdminBanner(view.chrome),
    `<h1>Agents — trading date ${escapeHtml(screen.tradingDate)}</h1>`,
    '<div class="lede">',
    `<p>Every agent the registry holds, which today is <strong data-agent-count="${screen.rows.length}">` +
      `${screen.rows.length}</strong>. The list is the registry’s: an <code>agent_definition</code> row ` +
      'with a heartbeat appears here with no code change, and an agent with no heartbeat is invisible to ' +
      'the watchdog too — which is a failing gate rather than a blank row on this screen.</p>',
    '<p>Each row says why it is in the state it is in, in its own words or in the words of the thing that ' +
      'stopped it. There is no generic error sentence, and there is nowhere in the renderer for one to ' +
      'live: a row with nothing wrong prints its state instead.</p>',
    `<p>Cost is measured from <code>agent_run.cost_fils</code> for this trading date, against the ` +
      'per-run ceiling the definition carries multiplied by the number of runs. There is no per-day ' +
      'budget in this schema — <code>Y13-agent-period-budget</code> is that question — so the ceiling is ' +
      'a derivation and the screen says so rather than presenting it as a figure somebody set.</p>',
    '</div>',
    `<ol class="agents">${screen.rows.map((row) => renderRow(row, view.mayToggle)).join('')}</ol>`,
    '<section class="dead-letters" aria-labelledby="dead-letters-heading">',
    '<h2 id="dead-letters-heading">Conversions that gave up</h2>',
    `<p data-dead-letters="${screen.deadLetters.length}">` +
      (screen.deadLetters.length === 0
        ? 'None. No dispatch has exhausted its retry budget.'
        : `${screen.deadLetters.length} dispatch(es) have exhausted their retry budget. A dead letter ` +
          'cannot be deleted (ZY711) — it is the record that a conversion was permanently not ' +
          'delivered, and the remedy is to re-queue, which re-judges consent on the way.') +
      '</p>',
    '</section>',
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}

/** The warning threshold, re-exported so a suite cannot drift from the renderer's own figure. */
export { AGENT_BUDGET_WARNING_PER_MILLE }
