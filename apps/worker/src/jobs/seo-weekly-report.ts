import type { Config } from '@berelax/config'
import {
  type Instant,
  renderSeoWeeklyReport,
  SEO_REPORT_MAX_SENTENCE_WORDS,
  type SeoReportMetric,
  type SeoWeeklyAction,
  type SeoWeeklyReport,
  seoReportReadability,
} from '@berelax/core'
import {
  agentHeartbeatFacts,
  createPostgresMessageStore,
  type GscSnapshotRow,
  readCurrentTemplate,
  type SeoSuggestionRow,
  type Sql,
} from '@berelax/db'
import { SEO_SUGGESTION_AGENT } from '@berelax/google'
import {
  classifyTemplateRow,
  type DeliveryDeps,
  deliverMessage,
  InMemoryOutbox,
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
 * The weekly plain-English report (G-SEO-07), through the one send choke point.
 *
 * docs/07 §3 is the requirement and the sentence that matters is *"the thing that makes the agent's
 * autonomy earnable"*. An owner who reads five actions and recognises them agrees to more automation next
 * month; an owner who reads a wall of metrics stops opening the email, and the week the agent is right is
 * the week nobody notices. ADR 0085 recorded the same hazard for the analyses; this is the last mile of it.
 *
 * ## It is on the EXISTING send path and not beside it
 *
 * `deliverMessage` and therefore `sendMessage`, which is where the template judgement, the sender-identity
 * class rule, the promotional gate, the campaign cap and the F03 staging guard live.
 * `scripts/check-send-chokepoint.mjs`'s `message-send-outside-the-choke-point` permits a `.send(` only in
 * `send.ts` and the two transports, so a second path here would fail that scanner rather than merely be
 * discouraged. The method on {@link SeoWeeklyReportSender} is `deliver`, not `send`, for the reason
 * `ReviewNoticeNotifier.notify` is named as it is: the name is not a way around the scanner, and what
 * matters is that there is one place a message can land.
 *
 * This is the THIRD runtime in this worker to wire a `SendContext` — beside `google-reauth-notify.ts`
 * (SMS) and `review-notice-sender.ts` (email) — and the thing that keeps the three from drifting is not
 * this comment. It is `gate-evaluator-answers-a-constant` in that same scanner, which refuses a gate
 * evaluator wired to a literal, so a runtime that quietly made promotional sends evaluable without a
 * consent store fails the gate rather than shipping.
 *
 * ## Nothing sends outside production, and that is re-asserted here
 *
 * `guardOutbound` diverts to the local outbox for any recipient not on `OUTBOUND_ALLOWLIST` whenever
 * `APP_ENV` is not production, and `EMAIL_PROVIDER=real` outside production does not even construct — the
 * registry throws at boot (ADR 0005). Both halves are asserted at this seam in
 * `seo-weekly-report.itest.ts` rather than taken on trust from the two units that built them.
 *
 * ## The recipient: the honest shipped answer is nobody
 *
 * {@link NO_OWNER_REPORT_ADDRESS} returns `null`, exactly as the review notices do. **No table in this
 * build holds a contact address for the owner** — migration 0075 recorded it for the Google re-auth
 * ladder and P-HR-06 for the rota notice — and a plausible address is worse than a blank one (brief rule
 * 15). `google_connections.google_email` is deliberately not used: docs/10 §5's third question is *which
 * Google account currently owns the GBP listing*, answered *possibly a former agency*, so sending this
 * business's weekly report there would be a disclosure to a third party chosen by the build.
 *
 * So the pass composes the report, judges its prose, records that it had nowhere to send it, and sends
 * nothing. `Y7-owner-notification-address` is the question and this resolver is the one line that changes.
 *
 * ## The body is composed here and the frame is a template row
 *
 * `renderSeoWeeklyReport` is pure and lives in `@berelax/core`, so the readability rules are asserted over
 * the text a reader receives rather than over a template that cannot know how long its own output is. The
 * `seo.weekly_report` row owns the words around it and stays editable without a deploy. A template with a
 * field per action would have to declare a fixed five, which is precisely the padding the acceptance line
 * forbids.
 */

/** The template this pass renders. One constant, so the row and the selector cannot disagree. */
export const SEO_WEEKLY_REPORT_TEMPLATE = 'seo.weekly_report'

/**
 * The agent whose heartbeat the report carries.
 *
 * `SEO_SUGGESTION_AGENT` imported rather than the string written again: `agent_definition` declares
 * `seo_agent` with `expected_interval_seconds` of 604,800 — a week — which is the run this report is the
 * output of, and a second spelling here would be a key that silently matched no row and a report whose
 * heartbeat section said the agent had never run.
 */
export const SEO_WEEKLY_REPORT_AGENT = SEO_SUGGESTION_AGENT

/**
 * The from-address, carrying a placeholder marker on a `.invalid` domain.
 *
 * Y6-email-sender: docs/05 §2 asks for separate verified sending subdomains for transactional and
 * marketing, and neither exists. The same shape the review notices use, so nothing can mistake it for a
 * verified sender.
 */
export const PROVISIONAL_REPORT_SENDER = Object.freeze({
  address: 'not-configured@berelax.example.invalid',
  name: 'BE RELAX (sender not configured)',
})

/** Who to tell. `null` means nobody, which is the shipped answer. */
export type ReportRecipientResolver = () => string | null

/**
 * The shipped resolver: `null`.
 *
 * Exported so a test can assert it is null rather than reading this file and believing it.
 */
export const NO_OWNER_REPORT_ADDRESS: ReportRecipientResolver = () => null

export type SeoWeeklyReportOutcome =
  | {
      readonly kind: 'sent'
      /** `null` when F03's staging guard diverted it, which off production is the ordinary outcome. */
      readonly messageId: string | null
      readonly report: SeoWeeklyReport
      /** Exactly the bytes the transport was handed. The preview pane shows these, not a re-render. */
      readonly html: string
    }
  /** Nobody to send to, the gate refused, or the prose failed its own rules. */
  | {
      readonly kind: 'not_sent'
      readonly reason: string
      /** Composed even when it cannot be sent: a report nobody can read is still evidence it ran. */
      readonly report: SeoWeeklyReport
      readonly html: string | null
    }

export interface SeoWeeklyReportInputs {
  readonly weekEndingIso: string
  readonly findings: readonly SeoWeeklyAction[]
  readonly metrics: readonly SeoReportMetric[]
  /** The stored snapshot covering the window, or null when none does. */
  readonly snapshot: GscSnapshotRow | null
  /** What degraded, in a clause, or null for an ordinary run. */
  readonly degradedBecause: string | null
}

export interface SeoWeeklyReportDeps {
  readonly sql: Sql
  readonly config: Config
  /** Injected, because nothing in this codebase reads the clock directly. */
  readonly now: () => string
  readonly recipient: ReportRecipientResolver
  readonly from: { readonly address: string; readonly name?: string }
}

/**
 * One drafted suggestion as an action.
 *
 * The expected effect is deliberately not a figure. Nothing measured what a title change is worth on this
 * site, and ADR 0070 is the rule: an unattributable figure is a refusal, never a number. So it says what
 * the change is for, which is what a reader needs in order to decide whether to make it.
 */
export function actionForSuggestion(row: SeoSuggestionRow): SeoWeeklyAction {
  return {
    kind: 'suggestion',
    finding: `We have drafted new wording for ${row.surface} and it is waiting for you.`,
    expectedEffect:
      'Clearer wording helps the right people recognise the page in a list of results.',
    humanAction:
      'Open the suggestions queue, read the old and new wording, and approve or leave it.',
  }
}

/** The report, composed and judged, with no send. Exported because the screen preview needs it too. */
export function composeSeoWeeklyReport(
  inputs: SeoWeeklyReportInputs,
  heartbeat: {
    readonly lastSuccessAtIso: string | null
    readonly nextRunDueAtIso: string | null
    readonly costToDateFils: number
  },
): SeoWeeklyReport {
  return renderSeoWeeklyReport({
    weekEndingIso: inputs.weekEndingIso,
    findings: inputs.findings,
    metrics: inputs.metrics,
    heartbeat,
    clicks:
      inputs.snapshot === null
        ? null
        : {
            queryClicks: inputs.snapshot.queryClicks,
            pageClicks: inputs.snapshot.pageClicks,
            queryImpressions: inputs.snapshot.queryImpressions,
            pageImpressions: inputs.snapshot.pageImpressions,
          },
    degradedBecause: inputs.degradedBecause,
    maxSentenceWords: SEO_REPORT_MAX_SENTENCE_WORDS,
  })
}

/** The port. `deliver`, not `send` — see the header. */
export interface SeoWeeklyReportSender {
  deliver(inputs: SeoWeeklyReportInputs): Promise<SeoWeeklyReportOutcome>
}

export function seoWeeklyReportSender(deps: SeoWeeklyReportDeps): SeoWeeklyReportSender {
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
      // The three fail-closed evaluators every other runtime wires, for the same reason: this report is
      // TRANSACTIONAL, so the gate returns on its first line and none of them is read — and a promotional
      // send through this runtime therefore fails closed rather than going out unevaluated. A constant
      // here would be the compliance check with the answer written in
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
    async deliver(inputs) {
      const facts = await agentHeartbeatFacts(deps.sql, SEO_WEEKLY_REPORT_AGENT)
      if (facts === undefined) {
        // Not a soft failure. `agent_definition` is seeded by migration, so an absent row means this
        // deployment never registered the agent — and a report with no heartbeat facts would be exactly
        // the silent-stop this unit exists to make visible (docs/12 §1: a stub must never look like it
        // works).
        throw new AppError(
          'invariant_violated',
          `No agent_definition row for '${SEO_WEEKLY_REPORT_AGENT}', so the report cannot carry the ` +
            'heartbeat facts that make a stopped agent visible in the email.',
          { details: { agentKey: SEO_WEEKLY_REPORT_AGENT } },
        )
      }
      const report = composeSeoWeeklyReport(inputs, {
        lastSuccessAtIso: facts.lastSuccessAtIso,
        nextRunDueAtIso: facts.nextRunDueAtIso,
        costToDateFils: facts.costToDateFils,
      })

      // Plain English is ENFORCED, not hoped for. A body that broke its own rules would be sent once and
      // read as the house style from then on, so the pass refuses it with the rule names — the same shape
      // the reply linter takes on the review send path (ADR 0063).
      const prose = seoReportReadability(report, {
        maxSentenceWords: SEO_REPORT_MAX_SENTENCE_WORDS,
        metrics: inputs.metrics,
      })
      if (prose.length > 0) {
        return {
          kind: 'not_sent',
          reason: `the report does not read plainly: ${prose
            .map((finding) => `${finding.rule} — ${finding.detail}`)
            .join('; ')}`,
          report,
          html: null,
        }
      }

      const row = await readCurrentTemplate(deps.sql, {
        key: SEO_WEEKLY_REPORT_TEMPLATE,
        channel: 'email',
        // English only, and the reason is migration 0075's verbatim: no table in this build records which
        // language a member of staff reads, and picking a locale per role would be a guess about a person
        // (ADR 0020). The Arabic variant is seeded and will be selected the day a staff locale exists.
        locale: 'en',
      })
      if (row === undefined) {
        throw new AppError(
          'invariant_violated',
          `No current '${SEO_WEEKLY_REPORT_TEMPLATE}' email template in this database. The shipped ` +
            'corpus is seeded from DEFAULT_TEMPLATES, so an absent row means the seed never ran.',
          { details: { templateKey: SEO_WEEKLY_REPORT_TEMPLATE } },
        )
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
        return { kind: 'not_sent', reason: classified.detail, report, html: null }
      }

      const recipient = deps.recipient()
      const request = {
        templateId: row.templateId,
        // Derived from the window, so a reclaimed job computes the same key and the provider refuses the
        // second message rather than billing for it.
        id: `seo-weekly-${inputs.weekEndingIso}` as MessageId,
        template: classified.template,
        values: { report: report.body },
        recipient: recipient ?? PROVISIONAL_REPORT_SENDER.address,
      }
      // The HTML part exactly as the transport derives it, so the preview is the bytes that were sent and
      // not a second rendering of the same template.
      const html = renderEmailHtml(outboundMessageFor(request))

      if (recipient === null) {
        return {
          kind: 'not_sent',
          reason:
            'no_recipient_on_file: no table in this build holds a contact address for the owner ' +
            '(Y7-owner-notification-address), and a plausible one is worse than a blank one.',
          report,
          html,
        }
      }

      const outcome = await deliverMessage(delivery, { ...request, recipient })
      if (outcome.kind === 'sent' || outcome.kind === 'held') {
        return { kind: 'sent', messageId: outcome.message.id, report, html }
      }
      if (outcome.kind === 'not_sent' && outcome.result.kind === 'diverted') {
        // F03's staging guard, and off production this is the ORDINARY outcome rather than a refusal: the
        // message is in the local outbox and inspectable.
        return { kind: 'sent', messageId: null, report, html }
      }
      const reason =
        outcome.kind === 'failed'
          ? `the transport failed: ${outcome.message.status}`
          : `the send was refused: ${outcome.result.kind}`
      return { kind: 'not_sent', reason, report, html }
    },
  }
}
