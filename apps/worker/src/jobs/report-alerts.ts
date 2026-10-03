import type { Config } from '@berelax/config'
import { type Instant, safeText, type TradingBucket } from '@berelax/core'
import { createPostgresMessageStore, readCurrentTemplate, type Sql } from '@berelax/db'
import {
  classifyTemplateRow,
  type DeliveryDeps,
  deliverMessage,
  InMemoryOutbox,
  type MessageClass,
  type MessageId,
  outboundMessageFor,
  PROVISIONAL_SENDER_IDS,
  renderEmailHtml,
  type SendContext,
  TDRA_PROMOTIONAL_WINDOW,
} from '@berelax/messaging'
import { createResendTransport } from '@berelax/messaging/transports/resend'
import { AppError } from '@berelax/shared'

/**
 * The pushed report alert (R-REP-08), through the one send choke point.
 *
 * ## A pushed report is a SEND, and there is no second path
 *
 * `deliverMessage` and therefore `sendMessage`, which is where the template judgement, the sender
 * identity class rule, the promotional gate, the campaign cap and the F03 staging guard live.
 * `scripts/check-send-chokepoint.mjs`'s `message-send-outside-the-choke-point` permits a `.send(` only
 * in `send.ts` and the two transports, so a second path here would fail that scanner rather than merely
 * be discouraged. The method is `deliver`, not `send`, for `SeoWeeklyReportSender.deliver`'s reason: the
 * name is not a way round the scanner, and what matters is that there is one place a message can land.
 *
 * This is the FOURTH runtime in this worker to wire a `SendContext` — beside `google-reauth-notify.ts`,
 * `review-notice-sender.ts` and `seo-weekly-report.ts` — and what keeps the four from drifting is not
 * this comment but `gate-evaluator-answers-a-constant` in that same scanner, which refuses a gate
 * evaluator wired to a literal.
 *
 * ## The class is the decision, and the two cases are asserted rather than argued
 *
 * R-REP-08's acceptance line is *a staff operational alert at 01:30 is permitted while a customer-facing
 * alert is held to the 07:00–21:00 window*. Both are the GATE's answers and neither is implemented here:
 *
 *   * A staff operational alert is `transactional`. `evaluateGate` returns `allow` on its first line for
 *     a transactional message and never reads the quiet-hours window — which is right, and is the same
 *     reason a booking confirmation goes out at 01:30: trading runs 11:00–02:00, so 01:30 is the middle
 *     of the shift the alert is about, and a report that waited until 07:00 would reach the owner after
 *     the day it is about had closed.
 *   * A customer-facing alert is `promotional` by TYPE, so it reaches `evaluatePromotionalGate` and the
 *     TDRA window holds it. This runtime cannot send one: its three evaluators THROW, so a promotional
 *     message through it is refused `blocked_unevaluable` before the window would have mattered.
 *
 * {@link REPORT_ALERT_CLASS} is a CONSTANT and not a parameter. A caller that could pass the class could
 * pass `promotional` for a staff alert — which reads as a sensible way to respect quiet hours and would
 * silence the one message that says the salon's figures cannot be trusted — or `transactional` for a
 * customer-facing one, which is the TDRA breach. The decision belongs to the alert's AUDIENCE and the
 * audience is in the registry.
 *
 * ## The recipient: the honest shipped answer is nobody
 *
 * {@link NO_ALERT_RECIPIENT} returns `null`, exactly as the review notices and the weekly report do. No
 * table in this build holds a contact address for the owner (migration 0075, P-HR-06,
 * `Y7-owner-notification-address`), and a plausible address is worse than a blank one (brief rule 15).
 * `google_connections.google_email` is deliberately not used: docs/10 §5 says the account that owns the
 * listing may be a former agency, so sending this business's figures there would be a disclosure to a
 * third party chosen by the build.
 *
 * So the pass composes the alert, judges its template, records that it had nowhere to send it, and sends
 * nothing.
 */

/** The template this pass renders. One constant, so the row and the selector cannot disagree. */
export const REPORT_ALERT_TEMPLATE = 'seo.weekly_report'

/**
 * The class of a staff operational alert. A CONSTANT — see the header for why it is not a parameter.
 */
export const REPORT_ALERT_CLASS: MessageClass = 'transactional'

/**
 * The from-address, carrying a placeholder marker on a `.invalid` domain.
 *
 * Y6-email-sender: docs/05 §2 asks for separate verified sending subdomains for transactional and
 * marketing, and neither exists. The same shape the weekly report uses, so nothing can mistake it for a
 * verified sender.
 */
export const PROVISIONAL_ALERT_SENDER = Object.freeze({
  address: 'not-configured@berelax.example.invalid',
  name: 'BE RELAX (sender not configured)',
})

/** Who to tell. `null` means nobody, which is the shipped answer. */
export type AlertRecipientResolver = () => string | null

/** The shipped resolver: `null`. Exported so a test can assert it rather than read this file. */
export const NO_ALERT_RECIPIENT: AlertRecipientResolver = () => null

/** What the alert is about: a data-quality check that stopped holding, or a figure that moved. */
export interface ReportAlertInput {
  /** The dashboard window the alert is about, as trading dates. */
  readonly windowFrom: string
  readonly windowTo: string
  /** The registered data-quality checks that are not holding, by id. Never empty. */
  readonly failingCheckIds: readonly string[]
  /** One sentence per finding, already composed by the caller from the check's own detail. */
  readonly findings: readonly string[]
  /** The trading buckets, so the alert can say which part of the day it is about. */
  readonly buckets: readonly TradingBucket[]
}

export type ReportAlertOutcome =
  | {
      readonly kind: 'sent'
      /** `null` when F03's staging guard diverted it, which off production is the ordinary outcome. */
      readonly messageId: string | null
      readonly body: string
      readonly html: string
    }
  | {
      readonly kind: 'not_sent'
      readonly reason: string
      /** Composed even when it cannot be sent: an alert nobody reads is still evidence it ran. */
      readonly body: string
      readonly html: string | null
    }

export interface ReportAlertDeps {
  readonly sql: Sql
  readonly config: Config
  /** Injected, because nothing in this codebase reads the clock directly. */
  readonly now: () => string
  readonly recipient: AlertRecipientResolver
  readonly from: { readonly address: string; readonly name?: string }
}

/**
 * The alert's body, composed here and escaped here.
 *
 * Plain sentences, one per failing check, and NO FIGURE. The figures are on the dashboard and the alert
 * is what gets somebody to open it: a number in an email is a number with no formula, no drill-down and
 * no refusal state beside it, which is the whole thing ADR 0120 exists to prevent one surface along.
 */
export function composeReportAlert(input: ReportAlertInput): string {
  if (input.failingCheckIds.length === 0) {
    throw new AppError(
      'validation',
      'A report alert with no failing check is an alert about nothing. A pass with nothing to say sends ' +
        'nothing rather than an empty reassurance: "all clear" every morning is how a real alert comes ' +
        'to be ignored.',
    )
  }
  const lines = [
    `Some figures for ${safeText(input.windowFrom)} to ${safeText(input.windowTo)} cannot be trusted ` +
      'today.',
    '',
    ...input.findings.map((finding) => `- ${safeText(finding)}`),
    '',
    `Checks not holding: ${input.failingCheckIds.map((id) => safeText(id)).join(', ')}.`,
    `The trading window for this period is ${input.buckets.length} hour(s), ` +
      `${input.buckets[0]?.label ?? 'unknown'} to ${input.buckets.at(-1)?.label ?? 'unknown'}.`,
    '',
    'Open the reports screen to see which tiles are refusing a figure and the rows behind each check. ' +
      'No figure is in this message on purpose: a number here would have no formula, no drill-down and ' +
      'no refusal state beside it.',
  ]
  return lines.join('\n')
}

/** The port. `deliver`, not `send` — see the header. */
export interface ReportAlertSender {
  deliver(input: ReportAlertInput): Promise<ReportAlertOutcome>
}

export function reportAlertSender(deps: ReportAlertDeps): ReportAlertSender {
  const resend = createResendTransport({ config: deps.config, now: deps.now, from: deps.from })
  const send: SendContext = {
    appEnv: deps.config.APP_ENV,
    outboundAllowlist: deps.config.OUTBOUND_ALLOWLIST,
    senderIds: PROVISIONAL_SENDER_IDS,
    transports: [resend.transport],
    outbox: new InMemoryOutbox(),
    clock: { now: () => Date.parse(deps.now()) as Instant },
    gate: {
      marketingKillSwitch: false,
      promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
      // The three fail-closed evaluators every other runtime wires, for the same reason: this alert is
      // TRANSACTIONAL, so the gate returns on its first line and none of them is read — and a
      // promotional send through this runtime therefore fails closed rather than going out unevaluated.
      // A constant here would be the compliance check with the answer written in
      // (`gate-evaluator-answers-a-constant`, scripts/check-send-chokepoint.mjs).
      evaluators: {
        hasConsent: () => {
          throw new Error(
            'No consent store in this runtime (C-CRM-03). Promotional sends fail closed.',
          )
        },
        isSuppressed: () => {
          throw new Error(
            'This runtime prefetches no suppression logs (C-CRM-04). Promotional sends fail closed.',
          )
        },
        frequencyCapReached: () => {
          throw new Error(
            'No frequency store in this runtime (C-AUTO-03). Promotional sends fail closed.',
          )
        },
      },
    },
  }
  const delivery: DeliveryDeps = {
    store: createPostgresMessageStore(deps.sql),
    send,
    // The queue is the thing that waits. A retry inside the pass would hold its rows for the backoff.
    waitUntil: async () => {},
  }

  return {
    async deliver(input) {
      const body = composeReportAlert(input)
      const row = await readCurrentTemplate(deps.sql, {
        key: REPORT_ALERT_TEMPLATE,
        channel: 'email',
        // English only, and the reason is migration 0075's verbatim: no table in this build records
        // which language a member of staff reads, and picking a locale per role would be a guess about
        // a person (ADR 0020).
        locale: 'en',
      })
      if (row === undefined) {
        throw new AppError(
          'invariant_violated',
          `No current '${REPORT_ALERT_TEMPLATE}' email template in this database. The shipped corpus ` +
            'is seeded from DEFAULT_TEMPLATES, so an absent row means the seed never ran.',
          { details: { templateKey: REPORT_ALERT_TEMPLATE } },
        )
      }
      if (row.messageClass !== REPORT_ALERT_CLASS) {
        // The template row's own class and this pass's constant have to agree, and the refusal is here
        // rather than a cast: a promotional template rendered through a transactional runtime would
        // reach the gate's first line and be allowed, which is the TDRA breach this check is for.
        return {
          kind: 'not_sent',
          reason:
            `the '${REPORT_ALERT_TEMPLATE}' template is ${row.messageClass} and a staff operational ` +
            `alert is ${REPORT_ALERT_CLASS}. A promotional template through this runtime would be ` +
            'allowed by the gate on its first line, which is the quiet-hours breach.',
          body,
          html: null,
        }
      }
      const classified = classifyTemplateRow({
        templateKey: row.templateKey,
        messageClass: row.messageClass,
        channel: row.channel,
        locale: row.locale,
        subject: row.subject,
        body: row.body,
        variables: row.variables,
        approvalState: row.approvalState,
        customerCareWindow: row.customerCareWindow,
        category: row.category,
      })
      if (classified.kind === 'unreadable') {
        return { kind: 'not_sent', reason: classified.detail, body, html: null }
      }

      const recipient = deps.recipient()
      const request = {
        templateId: row.templateId,
        // Derived from the window and the failing set, so a reclaimed job computes the same key and the
        // provider refuses the second message rather than billing for it.
        id: `report-alert-${input.windowFrom}-${input.windowTo}-${[...input.failingCheckIds]
          .sort()
          .join('.')}` as MessageId,
        template: classified.template,
        values: { report: body },
        recipient: recipient ?? PROVISIONAL_ALERT_SENDER.address,
      }
      // The HTML part exactly as the transport derives it, so a preview is the bytes that were sent.
      const html = renderEmailHtml(outboundMessageFor(request))

      if (recipient === null) {
        return {
          kind: 'not_sent',
          reason:
            'no_recipient_on_file: no table in this build holds a contact address for the owner ' +
            '(Y7-owner-notification-address), and a plausible one is worse than a blank one.',
          body,
          html,
        }
      }

      const outcome = await deliverMessage(delivery, { ...request, recipient })
      if (outcome.kind === 'sent' || outcome.kind === 'held') {
        return { kind: 'sent', messageId: outcome.message.id, body, html }
      }
      if (outcome.kind === 'not_sent' && outcome.result.kind === 'diverted') {
        // F03's staging guard, and off production this is the ORDINARY outcome rather than a refusal.
        return { kind: 'sent', messageId: null, body, html }
      }
      const reason =
        outcome.kind === 'failed'
          ? `the transport failed: ${outcome.message.status}`
          : `the send was refused: ${outcome.result.kind}`
      return { kind: 'not_sent', reason, body, html }
    },
  }
}
