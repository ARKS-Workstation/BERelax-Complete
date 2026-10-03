import {
  ALERT_OPEN_REASON,
  BUDGET_EXCEEDED_REASON,
  DISABLED_REASON,
  FAILING_WITHOUT_WORDS_REASON,
  filsFrom,
  GOOGLE_DEPENDENT_AGENTS,
  KILL_SWITCH_REASON,
  money,
} from '@berelax/core'
import { describe, expect, it } from 'vitest'
import type {
  AgentConsoleScreen,
  AgentConsoleScreenRow,
  AgentCost,
} from '../app/(admin)/agents/queries.ts'
import {
  AGENT_BUDGET_WARNING_PER_MILLE,
  type AgentConsoleView,
  KILL_SWITCH_FIELDS,
  KILL_SWITCH_PATH,
  renderAgentConsoleHtml,
} from '../app/(admin)/agents/render.ts'

/**
 * The agent console's bytes (G-AGT-02). Pure: a screen in, a document out, no database.
 *
 * ## The string this file exists for
 *
 * *"a DOM test asserts the string 'An error occurred' appears nowhere on the page"*. It is asserted below
 * against every reason kind the union has — including the two a renderer would reach for a fallback on: a
 * failure with no error text, and an agent nothing is wrong with. ADR 0116 is why there is no fallback to
 * find; this is the check that says so about the bytes.
 *
 * ## What is left to the itest
 *
 * The NUMBERS, and that the console is generated from the registry. A pure render cannot tell a row count
 * derived from `agent_definition` from a hand-written list — it renders whatever array it is given — so
 * "inserting a fixture agent increments the rendered row count" is `agent-console.itest.ts`'s, where the
 * array comes from a real query against a real insert.
 */

const DATE = '2026-10-02'

const cost = (overrides: Partial<AgentCost> = {}): AgentCost => ({
  spent: money(filsFrom(1_200)),
  perRun: money(filsFrom(2_000)),
  runs: 3,
  ceiling: money(filsFrom(6_000)),
  share: 200,
  worstRunShare: 600,
  ...overrides,
})

function row(overrides: Partial<AgentConsoleScreenRow> = {}): AgentConsoleScreenRow {
  return {
    agentKey: 'review_autoresponder',
    displayName: 'Review autoresponder',
    purpose: 'Drafts a reply to every review and waits for a person to approve it.',
    enabled: true,
    killSwitch: false,
    expectedIntervalSeconds: 900,
    lastRunAtIso: '2026-10-02T18:00:00.000Z',
    lastSuccessAtIso: '2026-10-02T17:00:00.000Z',
    nextRunAtIso: '2026-10-02T18:15:00.000Z',
    lastError: null,
    lastOutcome: 'succeeded',
    consecutiveFailures: 0,
    alertOpen: false,
    cost: cost(),
    pending: 3,
    reason: { kind: 'running' },
    ...overrides,
  }
}

const screen = (
  rows: readonly AgentConsoleScreenRow[],
  overrides: Partial<AgentConsoleScreen> = {},
): AgentConsoleScreen => ({
  tradingDate: DATE,
  rows,
  googleState: 'healthy',
  deadLetters: [],
  ...overrides,
})

const view = (overrides: Partial<AgentConsoleView> = {}): AgentConsoleView => ({
  chrome: { googleReauth: null, sendBacklog: null, returnTo: '/agents' },
  screen: screen([row()]),
  mayToggle: true,
  direction: 'ltr',
  ...overrides,
})

/** One agent's `<article>`, scoped so an assertion about one row is about one row. */
function article(html: string, agentKey: string): string {
  const start = html.indexOf(`data-agent="${agentKey}"`)
  if (start === -1) throw new Error(`no row for ${agentKey}`)
  const end = html.indexOf('</article>', start)
  return html.slice(start, end === -1 ? undefined : end)
}

describe('there is no generic error sentence anywhere', () => {
  it('renders every reason kind without it', () => {
    const kinds: readonly AgentConsoleScreenRow['reason'][] = [
      { kind: 'running' },
      { kind: 'kill_switch', text: KILL_SWITCH_REASON },
      { kind: 'disabled', text: DISABLED_REASON },
      {
        kind: 'google_paused',
        text: GOOGLE_DEPENDENT_AGENTS['review_autoresponder']?.whenBroken ?? '',
      },
      { kind: 'google_degraded', text: GOOGLE_DEPENDENT_AGENTS['seo_agent']?.whenBroken ?? '' },
      { kind: 'failing', text: 'ETIMEDOUT reading the Search Console API', consecutiveFailures: 4 },
      { kind: 'budget_exceeded', text: BUDGET_EXCEEDED_REASON },
      { kind: 'alert_open', text: ALERT_OPEN_REASON },
      { kind: 'failing_without_words', text: FAILING_WITHOUT_WORDS_REASON, consecutiveFailures: 2 },
    ]
    const html = renderAgentConsoleHtml(
      view({
        screen: screen(kinds.map((reason, index) => row({ agentKey: `agent_${index}`, reason }))),
      }),
    )
    // The string, and three near-misses a careless fallback would use instead.
    for (const generic of [
      'An error occurred',
      'an error occurred',
      'Something went wrong',
      'Unknown error',
    ]) {
      expect(html, `the console renders ${generic}`).not.toContain(generic)
    }
    // The control: every one of the nine rows rendered, so the absences above are about a full page.
    expect([...html.matchAll(/data-reason-kind="/g)]).toHaveLength(kinds.length)
    expect(kinds).toHaveLength(9)
  })

  it('prints the agent’s own words for a failure, escaped', () => {
    const html = renderAgentConsoleHtml(
      view({
        screen: screen([
          row({
            reason: {
              kind: 'failing',
              text: 'ETIMEDOUT after 30s <img src=x onerror=alert(1)>',
              consecutiveFailures: 4,
            },
            consecutiveFailures: 4,
          }),
        ]),
      }),
    )
    expect(html).toContain('ETIMEDOUT after 30s')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })

  it('names which field is empty when a failure has no words', () => {
    // The branch a fallback string would have been written for. It says where to look instead.
    const html = renderAgentConsoleHtml(
      view({
        screen: screen([
          row({
            reason: {
              kind: 'failing_without_words',
              text: FAILING_WITHOUT_WORDS_REASON,
              consecutiveFailures: 2,
            },
            consecutiveFailures: 2,
          }),
        ]),
      }),
    )
    expect(html).toContain('agent_heartbeat.last_error is empty')
    expect(html).toContain('agent_run.error')
  })

  it('prints a STATE and no sentence for an agent with nothing wrong', () => {
    const html = renderAgentConsoleHtml(view())
    expect(article(html, 'review_autoresponder')).toContain('data-reason="running"')
    expect(html).toContain('Running. The heartbeat records no failure')
  })
})

describe('one broken Google connection, two different reasons', () => {
  it('pauses the autoresponder and degrades the SEO agent', () => {
    const autoresponder = GOOGLE_DEPENDENT_AGENTS['review_autoresponder']
    const seo = GOOGLE_DEPENDENT_AGENTS['seo_agent']
    if (autoresponder === undefined || seo === undefined) {
      throw new Error(
        'the Google dependence table no longer holds the two agents this case is about',
      )
    }
    const html = renderAgentConsoleHtml(
      view({
        screen: screen(
          [
            row({
              agentKey: 'review_autoresponder',
              reason: { kind: 'google_paused', text: autoresponder.whenBroken },
            }),
            row({
              agentKey: 'seo_agent',
              displayName: 'SEO agent',
              reason: { kind: 'google_degraded', text: seo.whenBroken },
              pending: 5,
            }),
          ],
          { googleState: 'broken' },
        ),
      }),
    )
    const paused = article(html, 'review_autoresponder')
    expect(paused).toContain('paused: Google connection needs re-authorising')
    expect(paused).toContain('data-state="paused"')

    const degraded = article(html, 'seo_agent')
    expect(degraded).toContain('cached history we keep')
    expect(degraded).toContain('data-state="degraded"')
    // The two sentences are DIFFERENT, which is the whole point: reporting either as the other sends
    // somebody after the wrong thing.
    expect(degraded).not.toContain('needs re-authorising')
    expect(paused).not.toContain('cached history')
  })

  it('declares the two dependences and nothing in between', () => {
    // The table is the claim, so it is read rather than described: every entry is `pauses` or `degrades`
    // and every one carries a sentence.
    for (const [key, entry] of Object.entries(GOOGLE_DEPENDENT_AGENTS)) {
      expect(['pauses', 'degrades'], key).toContain(entry.dependence)
      expect(entry.whenBroken.length, key).toBeGreaterThan(20)
    }
    expect(Object.keys(GOOGLE_DEPENDENT_AGENTS).length).toBeGreaterThanOrEqual(6)
  })
})

describe('cost against budget', () => {
  it('renders the measured spend, the derived ceiling and the share', () => {
    const html = renderAgentConsoleHtml(view())
    const only = article(html, 'review_autoresponder')
    expect(only).toContain('data-cost-fils="1200"')
    expect(only).toContain('data-budget-share="200"')
    expect(only).toContain('20.0% of 60.00')
    expect(only).toContain('data-runs="3"')
  })

  it('renders the warning variant at 99% of a run’s budget and not below it', () => {
    const warned = renderAgentConsoleHtml(
      view({
        screen: screen([row({ cost: cost({ worstRunShare: AGENT_BUDGET_WARNING_PER_MILLE }) })]),
      }),
    )
    expect(article(warned, 'review_autoresponder')).toContain('data-budget-warning="true"')
    expect(article(warned, 'review_autoresponder')).toContain('class="warn"')
    // One per mille below, which is the control: a threshold asserted only from above is a threshold
    // satisfied by always warning.
    const quiet = renderAgentConsoleHtml(
      view({
        screen: screen([
          row({ cost: cost({ worstRunShare: AGENT_BUDGET_WARNING_PER_MILLE - 1 }) }),
        ]),
      }),
    )
    expect(article(quiet, 'review_autoresponder')).toContain('data-budget-warning="false"')
    expect(AGENT_BUDGET_WARNING_PER_MILLE).toBe(990)
  })

  it('reads "no budget" and never 100% for an agent that spends nothing', () => {
    const html = renderAgentConsoleHtml(
      view({
        screen: screen([
          row({
            agentKey: 'nightly_rollups',
            cost: cost({
              spent: money(filsFrom(0)),
              perRun: money(filsFrom(0)),
              ceiling: money(filsFrom(0)),
              share: null,
              worstRunShare: null,
            }),
          }),
        ]),
      }),
    )
    const only = article(html, 'nightly_rollups')
    expect(only).toContain('no budget')
    expect(only).toContain('data-budget-share=""')
    expect(only).not.toContain('100.0%')
    expect(only).not.toContain('Infinity')
    expect(only).not.toContain('NaN')
  })
})

describe('the queue, the kill switch and the landmarks', () => {
  it('prints a dash for an agent with no queue and a number for one with a queue', () => {
    const html = renderAgentConsoleHtml(
      view({
        screen: screen([
          row({ agentKey: 'review_autoresponder', pending: 3 }),
          row({ agentKey: 'nightly_rollups', pending: null }),
        ]),
      }),
    )
    expect(article(html, 'review_autoresponder')).toContain('data-pending="3"')
    // Absent rather than nought: "nothing is waiting" and "this agent has nothing that waits" are
    // different facts and only one of them is a number.
    expect(article(html, 'nightly_rollups')).toContain('data-pending=""')
    expect(article(html, 'nightly_rollups')).toContain('has no queue')
  })

  it('renders one POST form per agent, carrying the state to move TO', () => {
    const html = renderAgentConsoleHtml(
      view({
        screen: screen([
          row({ agentKey: 'review_autoresponder', killSwitch: false }),
          row({
            agentKey: 'seo_agent',
            killSwitch: true,
            reason: { kind: 'kill_switch', text: KILL_SWITCH_REASON },
          }),
        ]),
      }),
    )
    expect(html).toContain(`action="${KILL_SWITCH_PATH}"`)
    expect(html).toContain('method="post"')
    // The state to move TO, so a replayed submission is harmless rather than a flip.
    expect(article(html, 'review_autoresponder')).toContain(
      `name="${KILL_SWITCH_FIELDS.desired}" value="on"`,
    )
    expect(article(html, 'seo_agent')).toContain(`name="${KILL_SWITCH_FIELDS.desired}" value="off"`)
    expect(html).not.toContain('method="get"')
  })

  it('renders no control at all for a role that may not toggle', () => {
    const html = renderAgentConsoleHtml(view({ mayToggle: false }))
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<button')
    /*
      And not a disabled one: a greyed button is a control a browser can re-enable.

      Asserted as the ATTRIBUTE and not as the word. The first version was `not.toContain('disabled')`
      and failed against the page's own sentence explaining that the control is absent rather than
      disabled — the same trap `stripNonCode` exists for one package over, in a test rather than a gate.
    */
    expect(html).not.toMatch(/\sdisabled(?:[=>\s])/)
    expect(html).toContain('needs the agent:configure permission')
  })

  it('states noindex, names the trading date, and mirrors for the RTL cell', () => {
    const html = renderAgentConsoleHtml(view())
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">')
    expect(html).toContain(`data-trading-date="${DATE}"`)
    expect(html).toContain('<html lang="en" dir="ltr">')
    expect(renderAgentConsoleHtml(view({ direction: 'rtl' }))).toContain(
      '<html lang="en" dir="rtl">',
    )
  })

  it('emits both admin banners inside <main>', () => {
    const html = renderAgentConsoleHtml(
      view({
        chrome: {
          googleReauth: {
            state: 'broken',
            headline: 'Needs re-authorising',
            detail: 'The grant has expired.',
            dismissible: false,
            connectionId: 'connection-1',
            googleEmail: null,
          },
          sendBacklog: { queued: 31, threshold: 20 },
          returnTo: '/agents',
        },
      }),
    )
    expect(html).toContain('data-google-reauth="broken"')
    expect(html).toContain('data-messages-delayed="31"')
    expect(html.indexOf('<main>')).toBeLessThan(html.indexOf('data-google-reauth'))
  })

  it('counts the rows it rendered, which is what the itest compares against a real insert', () => {
    const html = renderAgentConsoleHtml(
      view({ screen: screen([row({ agentKey: 'a' }), row({ agentKey: 'b' })]) }),
    )
    expect(html).toContain('data-agent-count="2"')
    expect([...html.matchAll(/data-agent="/g)]).toHaveLength(2)
  })
})
