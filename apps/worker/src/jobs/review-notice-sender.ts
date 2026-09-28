import type { Config } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createPostgresMessageStore, readCurrentTemplate, type Sql } from '@berelax/db'
import {
  classifyTemplateRow,
  type DeliveryDeps,
  deliverMessage,
  InMemoryOutbox,
  type MessageId,
  PROVISIONAL_SENDER_IDS,
  type SendContext,
  TDRA_PROMOTIONAL_WINDOW,
} from '@berelax/messaging'
import { createResendTransport } from '@berelax/messaging/transports/resend'
import { AppError } from '@berelax/shared'

/**
 * The sending half of the fallback intake's two notices (G-REV-02): one port, one implementation.
 *
 * Shared by the count tripwire and the Monday nudge because they differ in exactly one thing — which template
 * key they render — and everything else about them is identical: an email, to the owner, carrying a deep link
 * built from the stored placeId, through the messaging choke point. Two copies of this would be two places to
 * get the gate evaluators, the staging-guard handling and the idempotency key right.
 *
 * ## Why it is a port at all
 *
 * So the two passes can be driven on a frozen clock and asserted on the fake Resend outbox without either of
 * them knowing how a message is sent. It is also what keeps
 * `scripts/check-send-chokepoint.mjs`'s first rule satisfied honestly: the method is {@link
 * ReviewNoticeNotifier.notify} rather than `send`, and the ONE implementation of it calls `deliverMessage` and
 * therefore `sendMessage` — where the template judgement, the sender-identity class rule, the promotional gate
 * and the staging guard are. The name is not a way around that scanner; what matters is where the message
 * lands, and there is one place it can land.
 *
 * ## Why the class comes from the row and is never written here
 *
 * `classifyTemplateRow` narrows the stored row, and the reason is the hole its own header records: the
 * reminder worker used to write `messageClass: 'transactional'` at the call site, which was true of that
 * template and was a hole all the same — `reclassify_template` can make any template promotional, and a call
 * site that restates the class sends promotional content from the transactional identity with every gate
 * skipped. So the class, the channel, the locale and the approval state all come from the database, and a
 * label this build cannot read is a named refusal rather than a guess.
 *
 * ## The recipient: the honest shipped answer is nobody
 *
 * {@link NO_OWNER_CONTACT_ON_FILE} returns `null`. **No table in this build holds a contact address for the
 * owner or any member of staff** — migration 0075 had to record exactly this for the Google re-auth ladder,
 * and P-HR-06 for the rota notice — and a plausible address is worse than a blank one (brief rule 15).
 *
 * `google_connections.google_email` is deliberately NOT used, and that is the decision worth writing down:
 * docs/10 §5's third question is *which Google account currently owns the GBP listing, and at what role*, with
 * the answer *possibly a former agency*. Emailing that address about this business's reviews would be a
 * disclosure to a third party, chosen by the build rather than by the owner.
 *
 * So both passes record their decision, report `no_recipient_on_file`, and send nothing. Everything else — the
 * comparison, the phrase, the deep link, the idempotency, the rows — is built and exercised, and the day an
 * owner address exists this resolver is the one line that changes. `Y7-owner-notification-address` in
 * docs/OPEN-QUESTIONS.md is the question.
 */

/**
 * The from-address, carrying a placeholder marker on a `.invalid` domain.
 *
 * Y6-email-sender: docs/05 §2 asks for separate verified sending subdomains for transactional and marketing,
 * and neither exists. The transport takes `from` as a required argument with no default for that reason, and
 * this is the shape the messaging fixtures already use — `not-configured@…invalid` — so that nothing can
 * mistake it for a verified sender.
 */
export const PROVISIONAL_EMAIL_SENDER = Object.freeze({
  address: 'not-configured@berelax.example.invalid',
  name: 'BE RELAX (sender not configured)',
})

/** The notice a pass asks to be sent. Every value is one the pass built from trusted data. */
export interface ReviewNotice {
  /** The rendered count phrase — `2 new reviews` — or absent for the nudge, which counts nothing. */
  readonly reviewsPhrase?: string
  /** The Maps deep link, from `placeReviewsDeepLink` and the STORED placeId. */
  readonly deepLink: string
  /** Derived from a row id, so a reclaimed job computes the same key and the second row is refused. */
  readonly idempotencyKey: string
  readonly recipient: string
}

export type ReviewNoticeOutcome =
  | {
      readonly kind: 'sent'
      /** `null` when F03's staging guard diverted it, which off production is the ordinary outcome. */
      readonly messageId: string | null
    }
  /** The gate refused, the template is unapproved, or a column holds a label this build cannot read. */
  | { readonly kind: 'refused'; readonly reason: string }

/** The port. `notify`, not `send` — see the header. */
export interface ReviewNoticeNotifier {
  notify(notice: ReviewNotice): Promise<ReviewNoticeOutcome>
}

/** Who to tell. `null` means nobody, which is the shipped answer. */
export type ReviewNoticeRecipientResolver = () => string | null

/**
 * The shipped resolver: `null` for every caller.
 *
 * Exported so a test can assert it is null rather than reading this file and believing it, and so the one line
 * that changes when an owner-contact table lands is here.
 */
export const NO_OWNER_CONTACT_ON_FILE: ReviewNoticeRecipientResolver = () => null

export interface ReviewNoticeNotifierOptions {
  /** The verified sending address. No default — see {@link PROVISIONAL_EMAIL_SENDER} and Y6-email-sender. */
  readonly from: { readonly address: string; readonly name?: string }
  /** Which of the two fallback templates to render. */
  readonly templateKey: string
  /** Injected, because nothing in this codebase reads the clock directly. */
  readonly now: () => string
}

export function reviewNoticeNotifierFor(
  sql: Sql,
  config: Config,
  options: ReviewNoticeNotifierOptions,
): ReviewNoticeNotifier {
  const resend = createResendTransport({ config, now: options.now, from: options.from })
  const send: SendContext = {
    appEnv: config.APP_ENV,
    outboundAllowlist: config.OUTBOUND_ALLOWLIST,
    senderIds: PROVISIONAL_SENDER_IDS,
    transports: [resend.transport],
    outbox: new InMemoryOutbox(),
    clock: { now: () => Date.parse(options.now()) as Instant },
    gate: {
      marketingKillSwitch: false,
      promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
      // The three fail-closed evaluators every other runtime wires, for the same reason: these notices are
      // TRANSACTIONAL, so the gate returns on its first line and none of them is read — and a promotional
      // send through this runtime therefore fails closed rather than going out unevaluated. A constant here
      // would be the compliance check with the answer written in
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
    store: createPostgresMessageStore(sql),
    send,
    // The queue is the thing that waits. A retry inside the pass would hold its rows for the declared backoff.
    waitUntil: async () => {},
  }

  return {
    async notify(notice) {
      const row = await readCurrentTemplate(sql, {
        key: options.templateKey,
        channel: 'email',
        // English only, and the reason is migration 0075's verbatim: no table in this build records which
        // language a member of staff reads, and picking a locale per role would be a guess about a person
        // (ADR 0020). The Arabic variant is seeded and will be selected the day a staff locale exists.
        locale: 'en',
      })
      if (row === undefined) {
        // Not a soft failure. The shipped corpus is seeded from `DEFAULT_TEMPLATES`, so an absent row means
        // this database was never seeded — and a pass that shrugged would report success for a notice nobody
        // received (docs/12 §1: a stub must never look like it works).
        throw new AppError(
          'invariant_violated',
          `No current '${options.templateKey}' email template in this database. The shipped corpus is ` +
            'seeded from DEFAULT_TEMPLATES, so an absent row means the seed never ran.',
          { details: { templateKey: options.templateKey } },
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
      if (classified.kind === 'unreadable') return { kind: 'refused', reason: classified.detail }

      const available: Record<string, string> = {
        link: notice.deepLink,
        ...(notice.reviewsPhrase === undefined ? {} : { reviews: notice.reviewsPhrase }),
      }
      // Narrowed to what this variant declares rather than handed a superset: the renderer refuses a value it
      // did not declare, and the nudge template declares `link` alone.
      const values = Object.fromEntries(
        classified.template.variables
          .filter((name) => name in available)
          .map((name) => [name, available[name] ?? '']),
      )
      const missing = classified.template.variables.filter((name) => !(name in values))
      if (missing.length > 0) {
        // A blank renders. A declared variable this notice cannot supply means the copy and the pass have
        // drifted apart, and a visible refusal beats an email with a hole in the sentence.
        throw new AppError(
          'invariant_violated',
          `Template '${options.templateKey}' declares ${missing.join(', ')}, which this notice does not ` +
            'carry. Refusing to render a body with a blank in it.',
          { details: { templateKey: options.templateKey, missing } },
        )
      }
      const outcome = await deliverMessage(delivery, {
        templateId: row.templateId,
        id: notice.idempotencyKey as MessageId,
        template: classified.template,
        values,
        recipient: notice.recipient,
      })
      if (outcome.kind === 'sent' || outcome.kind === 'held') {
        return { kind: 'sent', messageId: outcome.message.id }
      }
      if (outcome.kind === 'not_sent' && outcome.result.kind === 'diverted') {
        // F03's staging guard, and off production this is the ORDINARY outcome rather than a refusal: the
        // message is in the local outbox and inspectable. There is no `message` row, which is why the
        // notification column is nullable — migration 0075 had to make the same allowance.
        return { kind: 'sent', messageId: null }
      }
      const reason =
        outcome.kind === 'failed'
          ? `the transport failed: ${outcome.message.status}`
          : `the send was refused: ${outcome.result.kind}`
      return { kind: 'refused', reason }
    },
  }
}
