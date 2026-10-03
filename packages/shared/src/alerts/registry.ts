/**
 * The alert registry: one declarative table of every condition this build will wake somebody for.
 *
 * ## Why this is a table and not a document
 *
 * G-AGT-01 removed one shape of failure — a cron nobody watches — by making the watching STRUCTURAL: a
 * scheduled job names an `agent_definition`, the agent brings an `agent_heartbeat` row in its own
 * migration, and `pnpm jobs` refuses a cron with neither. The defect one level up is an alert nobody
 * watches, and a list of alerts in a document reproduces it exactly: the list is right the day it is
 * written, the eleventh condition is added to the evaluator and not to the list, and the first thing
 * anybody does with the list afterwards is stop trusting it.
 *
 * So this table is **the thing the alerting path reads**, not a description of it. The pass that
 * evaluates alerts enumerates `ALERT_REGISTRY` and looks each entry's observer up BY ID in a
 * `Record<AlertId, …>`, so an entry with no observer does not typecheck and an observer with no entry
 * does not either. `scripts/check-alert-registry.mjs` proves the rest: the severity, the threshold, the
 * runbook heading and the audience are each a claim about something outside this file.
 *
 * ## What an entry is NOT allowed to carry
 *
 * **A target figure.** `AlertSlo.target` is typed `null` and not `number | null`, which makes an
 * invented service-level objective inexpressible rather than discouraged. This build has no production
 * traffic and no measured baseline, so any figure here would be one somebody made up, and a dashboard
 * that is green against a made-up target is worse than no dashboard: it answers "are we within the
 * objective" with a number nobody committed to. What an entry DOES carry is the SHAPE — what is
 * measured, over which rows, across what window — so the figure can be filled in later by somebody who
 * has a baseline, and the `openQuestionId` is where that conversation is recorded.
 *
 * Widening `target` is a deliberate edit to this type, in the commit that answers the open question.
 * That is the point: the type is the record of who has committed to what.
 *
 * ## Thresholds are a different thing from SLOs, and that distinction is load-bearing
 *
 * A threshold is "when is this abnormal enough to look at". Some are STRUCTURAL — one more data subject
 * than the request covers is a bulk read whatever anybody's opinion is, and an obligation one day past
 * its due date is overdue — and those carry no invented figure because they are derived from a fact the
 * build already holds, in the place it already holds it. The rest are genuinely judgements with no
 * measured basis, and those are F09 settings flagged `provisional` against an OPEN-QUESTIONS id, so the
 * figure appears on the Unconfirmed Assumptions panel and is corrected by one audited settings change
 * rather than by a release. A judgement written as a constant in this file would be a figure nobody can
 * see and nobody can correct.
 *
 * `packages/shared` rather than `core` or `db` for `crawlers.ts`'s reason: `packages/db` may reach
 * `shared` and must never import `core` (ADR 0001), the worker reaches all three, and a table that both
 * the reader and the evaluator derive from has no business on the wrong side of that boundary.
 */

/**
 * How urgently somebody is woken. Three values, and there is deliberately no `info`.
 *
 * An alert nobody acts on is a log line, and a severity meaning "do nothing" is what lets the other two
 * fill up with things nobody reads. Anything that does not justify one of these three is a figure on a
 * panel, which is R-REP-08's.
 */
export const ALERT_SEVERITIES = ['immediate', 'same_day', 'next_working_day'] as const
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number]

/** The surface an alert is shown on. Delivery to a handset is R-REP-08's; see {@link AlertRoute}. */
export const ALERT_SURFACES = ['admin_banner', 'compliance_panel', 'operator_review'] as const
export type AlertSurface = (typeof ALERT_SURFACES)[number]

/** What a threshold counts, so a figure is never a bare number. */
export const THRESHOLD_UNITS = [
  'subjects',
  'seconds',
  'messages',
  'attempts',
  'days',
  /*
   * `batches` is G-AGT-02's, added with the settlement alert H-HARD-05 deliberately left out.
   *
   * A sixth unit rather than counting batches in `attempts`, which is the nearest existing word and
   * would be a lie about what is being measured: an attempt is something this build did and a batch is
   * a file an acquirer sent. A threshold's unit is printed beside its figure, and "1 attempts" on a
   * screen about a payout that does not tie is the kind of wrong label that makes somebody distrust the
   * whole panel.
   */
  'batches',
] as const
export type ThresholdUnit = (typeof THRESHOLD_UNITS)[number]

/**
 * A structural threshold: a figure the build already holds somewhere a migration or a release owns.
 *
 * `statedIn` is a path, and the gate reads that file and fails when the figure is not in it. That is
 * what stops this from being a second statement of the figure — the registry POINTS at the authority
 * rather than repeating it, and a migration that changes the authority fails the gate.
 */
export interface StructuralThreshold {
  readonly kind: 'structural'
  readonly value: number
  readonly unit: ThresholdUnit
  /** The file whose text holds this figure. Checked. */
  readonly statedIn: string
}

/** A judgement with no measured basis: an F09 setting, bounded, and flagged provisional. */
export interface SettingThreshold {
  readonly kind: 'setting'
  readonly settingKey: string
  readonly unit: ThresholdUnit
}

export type AlertThreshold = StructuralThreshold | SettingThreshold

/**
 * The SHAPE of a service-level objective, and never a target.
 *
 * `measuredFrom` names `table.column` pairs so the measurement can be recomputed by somebody holding
 * only this entry — a measure described in prose is a measure two people compute differently.
 */
export interface AlertSlo {
  /** What is measured, in one sentence a reader can recompute from `measuredFrom`. */
  readonly measure: string
  /** `table.column`, one per input of the measurement. Checked against the Drizzle mirror. */
  readonly measuredFrom: readonly string[]
  /** The window the measure is taken over. A measure with no window is an all-time average. */
  readonly windowDays: number
  /**
   * Always `null`, by type. See the header: there is no baseline in this build, so there is no figure
   * anybody has committed to, and `number` is not an option this type offers.
   */
  readonly target: null
  /** Where the missing figure is recorded. A row in `docs/OPEN-QUESTIONS.md`. */
  readonly openQuestionId: string
}

/** Who is woken, and where. */
export interface AlertRoute {
  /**
   * The F07 roles this alert is for. A role list and not a person: no name of a person is in this
   * repository (brief rule 10) and no contact detail is on file (`Y13-oncall`).
   */
  readonly audience: readonly string[]
  readonly surface: AlertSurface
}

/**
 * One condition.
 *
 * Every field but `rule` is a claim something outside this file can be held to.
 */
export interface AlertDefinition {
  readonly id: string
  /** The condition, in one sentence: what is true when this fires. */
  readonly rule: string
  readonly severity: AlertSeverity
  readonly threshold: AlertThreshold
  readonly route: AlertRoute
  /** `<runbook file stem>#<heading slug>` in `docs/runbooks/`. Resolved by the gate. */
  readonly runbook: string
  readonly slo: AlertSlo
  /**
   * The ids in {@link UNDEFENDED_BY_DESIGN} this alert does NOT cover.
   *
   * Required and not optional, because the whole value of the exception list is that it is attached to
   * the thing a reader would otherwise believe. The gate holds the two sets equal in both directions:
   * an undefended id no alert names is an exception nobody will ever read, and an id here that the
   * exception list does not define is a limitation stated as a word.
   */
  readonly doesNotCover: readonly string[]
}

/**
 * The insider-threat exception: what this build does NOT defend against, recorded rather than coded
 * around.
 *
 * docs/06 §D4 is explicit that the realistic breach for this business is somebody inside it reading or
 * exporting the client list, and the audit trail is the control: reads are recorded, not just writes
 * (`packages/db/src/audit.ts`), and an export is indexed separately so an unusually large one is cheap
 * to find.
 *
 * The part that is usually left implied is that **the trail cannot constrain the role that can read
 * everything.** The owner holds `settings:write_compliance`, the F07 matrix's widest grant, plus direct
 * database access — it is a single-owner business with no separation of duties to arrange. Every control
 * below is therefore a DETECTION control for that role and not a prevention one, and an alert routed to
 * the owner about the owner is a notification to the person it is about.
 *
 * Writing an alert that implied otherwise would be worse than writing none, so each entry says what is
 * not defended, who can do it, and what would actually defend it — which is almost always a second
 * person, and this business has one.
 */
export interface UndefendedCase {
  readonly id: string
  /** The thing that is not prevented. */
  readonly what: string
  /** Who can do it. */
  readonly who: string
  /** Why it is not defended here, rather than why it does not matter. */
  readonly why: string
  /** What would defend it. Named concretely, so the cost of closing it is visible. */
  readonly wouldNeed: string
}

export const UNDEFENDED_BY_DESIGN: readonly UndefendedCase[] = [
  {
    id: 'owner-reads-everything',
    what:
      'A read or an export performed by the owner. It is recorded and it is alerted on, and neither ' +
      'refuses it or can be made to.',
    who:
      'The owner role, and anybody holding the database credential — which in this business is the ' +
      'same person.',
    why:
      'The audit trail is append-only in the database (ADR 0008) and the alert is routed to the owner. ' +
      'Routing an alert about somebody to that same person is a notification and not a control, and ' +
      'there is no second principal in this business to route it to instead.',
    wouldNeed:
      'A second person in an auditor role who receives the alert, or an append-only sink outside this ' +
      'deployment that the owner cannot reach. Neither exists; the auditor role is in the F07 matrix ' +
      'with nobody in it.',
  },
  {
    id: 'direct-sql-bypasses-the-application',
    what:
      'A read issued over `psql` with the database credential. No `audit_event` row is written, because ' +
      'the writer is the application and not the database.',
    who: 'Anybody holding `DATABASE_URL`.',
    why:
      'Audit rows are written by `AuditWriter` in the same transaction as the change they describe, ' +
      'which is what makes an audited mutation atomic with its evidence. A trail written by a trigger ' +
      'instead would cover a direct read as well, and it would also be a trail that cannot see the ' +
      'actor: a session has no principal at the SQL layer, so every row would be attributed to the ' +
      'application role.',
    wouldNeed:
      'Statement logging on the database server, shipped somewhere the credential holder cannot edit. ' +
      'That is a hosting control and not a code change, and no such sink is configured (`Y13-oncall`).',
  },
  {
    id: 'refused-sign-ins-are-unmetered',
    what:
      'The number of refused sign-ins anybody may make. Each one against an existing staff reference ' +
      'now writes an append-only `audit_event` row, which is what makes the alert possible and also ' +
      'means an unauthenticated caller can make this system write rows.',
    who: 'Anybody who can reach the admin sign-in form.',
    why:
      'Rate limiting on a public endpoint is H-HARD-01 and is not built. Writing the row is still the ' +
      'right trade: without it a credential can be guessed with no record at all, which is the failure ' +
      'the alert exists for. The write is bounded to references that resolve to a real credential — an ' +
      'unknown handle writes nothing — so the vector needs a valid staff reference first.',
    wouldNeed:
      "H-HARD-01's per-endpoint limit in front of the sign-in route. Nothing in this build throttles it.",
  },
  {
    id: 'the-pass-cannot-report-its-own-absence',
    what:
      'A worker that is not running. Every alert here is raised by a pass, so a stopped worker raises ' +
      'nothing at all and the absence of alerts reads exactly like quiet.',
    who: 'Nobody — this is a failure rather than an act.',
    why:
      'Migration 0021 made the evidence a ROW rather than an absence for precisely this reason, and the ' +
      'alert ladder reads those rows. It cannot read them when it is not running, and no pass can ' +
      'report that it did not happen.',
    wouldNeed:
      'A check outside this deployment reading `agent_heartbeat.last_success_at`. H-HARD-04 owns the ' +
      'restore drill, which is the nearest thing in the build, and there is no uptime monitor.',
  },
]

const UNDEFENDED_IDS: ReadonlySet<string> = new Set(UNDEFENDED_BY_DESIGN.map((c) => c.id))

/** Shared by three entries, so the sentence is one string rather than three that drift apart. */
const OWNER_ONLY_AUDIENCE = ['owner'] as const

/**
 * The four threshold setting keys, spelled once.
 *
 * `compliance-notices.ts`'s reason: four things that may not import each other need these strings to
 * agree exactly — the F09 registry (`packages/config`), the reader (`packages/db`), the evaluator
 * (`apps/worker`) and this table. `packages/shared` is the leaf every one of them may import, so a
 * mismatch is not expressible rather than merely unlikely, and a reader that silently falls back to a
 * declared default is not a failure mode this build has to have.
 */
/**
 * The open question behind every threshold figure in this file, and behind every absent SLO target.
 *
 * Two ids and not one, because they are two different conversations. A threshold is a judgement somebody
 * can make today from how the business works; an SLO is a commitment, and committing to one before any
 * traffic has been observed is how a dashboard comes to be green against a figure nobody agreed to.
 */
export const ALERT_THRESHOLDS_OPEN_QUESTION_ID = 'Y13-alert-thresholds'
export const ALERT_SLO_OPEN_QUESTION_ID = 'Y13-alert-slos'

/**
 * The window refused sign-ins are counted in, in minutes.
 *
 * A constant and not a fifth setting, deliberately. The COUNT is the figure an owner has an opinion
 * about ("five mistyped passwords is too many"); the window is the shape of the measurement, and a
 * settings screen offering both invites the combination that silences the alert without looking like it
 * — three attempts in one minute is a far weaker claim than three in an hour, and nothing on the screen
 * would say so. Chosen and not measured, under the same open question as the thresholds.
 */
export const AUTH_FAILURE_WINDOW_MINUTES = 60

/**
 * The window the export alert looks back over, in hours.
 *
 * Twenty-four, and it is a day rather than a chosen figure: `business_day` is first-class in this build
 * (ADR 0007) and a day is the unit the business already counts in. The measurement takes the LARGEST
 * export in the window rather than the most recent one, so an innocent single-subject export arriving
 * afterwards cannot clear an alert about a bulk one.
 */
export const ALERT_OBSERVATION_WINDOW_HOURS = 24

/**
 * The audit action a refused admin sign-in writes.
 *
 * Spelled here because three things need it to agree: the sign-in route that writes it, the reader that
 * counts it, and the test that proves the count. The row is written only when the staff reference
 * resolved to a real credential — see `UNDEFENDED_BY_DESIGN`'s `refused-sign-ins-are-unmetered` and the
 * route's own comment for why an unknown handle deliberately writes nothing.
 */
export const STAFF_SESSION_REFUSED_ACTION = 'staff_session.refused'

/**
 * The outbox event an alert raises, and the aggregate type it carries.
 *
 * An alert is NOT a table. It is a measurement over rows that already exist, so the firing state is
 * derived and clears itself; what needs deduplicating is the NOTIFICATION, and
 * `outbox_event.idempotency_key` already does exactly that. `alert:<id>:<incidentKey>` is the key, the
 * incident key is derived from the observation rather than from the clock, and `publishEvent`'s
 * `on conflict do nothing` is what makes the second pass of one incident insert nothing.
 *
 * The aggregate type is also what keeps the outbox-lag alert from feeding itself: the lag measurement
 * excludes this aggregate type, because an alert event waiting to be published is otherwise backlog, and
 * an alarm whose own output trips it rings for ever.
 *
 * Nothing consumes this event yet, and that is deliberate rather than unfinished. `drainOutbox` marks an
 * event published once every INTERESTED handler has succeeded, so an event with no handler is published
 * on the next pass and does not accumulate. Delivery to a person — an email, a message to a handset — is
 * R-REP-08's pushed alerts, and inventing a channel here would mean inventing a contact (`Y13-oncall`).
 */
export const ALERT_RAISED_EVENT = 'alert.raised'
export const ALERT_EVENT_AGGREGATE_TYPE = 'operational_alert'

/** The fault event: a threshold nobody can read is not a clear alert. */
export const ALERT_THRESHOLD_UNREADABLE_EVENT = 'alert.threshold_unreadable'

export const OUTBOX_LAG_THRESHOLD_SETTING_KEY = 'alerts.outbox_lag_seconds'
export const SEND_BACKLOG_THRESHOLD_SETTING_KEY = 'alerts.send_backlog_messages'
export const JOB_FAILURE_THRESHOLD_SETTING_KEY = 'alerts.job_consecutive_failures'
export const AUTH_FAILURE_THRESHOLD_SETTING_KEY = 'alerts.auth_failures_per_credential'

/**
 * The conditions this build alerts on.
 *
 * Seven. Six were H-HARD-05's; the seventh — an unreconciled settlement batch — was deliberately ABSENT
 * rather than present-and-unobservable, because at the time nothing in this schema recorded a settlement
 * batch or its reconciliation state, and an entry whose observer could only ever answer "nothing to see"
 * is the green dashboard this file's header refuses.
 *
 * The rows exist now: `settlement_batch` and `settlement_variance` (0136), with `state` exclusive between
 * `posted` and `quarantined` and `difference_fils` non-zero by CHECK. So G-AGT-02 discharges the
 * deferral, which cost exactly what this file's design predicted it would — one row here, one observer in
 * `packages/db/src/alerts.ts`, one runbook heading and one threshold unit. A row with any of those
 * missing does not compile or does not pass the gate.
 */
export const ALERT_REGISTRY = [
  {
    id: 'customer_list_export',
    rule:
      'An export covering more than the one data subject who asked for it. A single-subject export is a ' +
      'right being exercised; anything wider is a bulk read of the client list.',
    severity: 'immediate',
    threshold: {
      kind: 'structural',
      value: 2,
      unit: 'subjects',
      // The figure is the CHECK in 0085 that ties `rights_export.alerted` to `subject_count`, so a bulk
      // export cannot be recorded as un-alerted even by a caller that forgot to publish. Pointing at it
      // rather than repeating it is what keeps the two from disagreeing — and it is why this threshold
      // is not a setting: the acceptance line asks that neither the audit write nor the alert can be
      // turned off, and a figure on the Unconfirmed Assumptions panel can be set to a million.
      statedIn: 'packages/db/migrations/0085_data_subject_rights.sql',
    },
    route: { audience: OWNER_ONLY_AUDIENCE, surface: 'operator_review' },
    runbook: 'alerting#a-bulk-export-of-the-client-list',
    slo: {
      measure:
        'The share of bulk exports whose alert was read and dispositioned, and how long that took from ' +
        'the export instant.',
      measuredFrom: [
        'rights_export.exported_at',
        'rights_export.alerted',
        'rights_export.subject_count',
      ],
      windowDays: 90,
      target: null,
      openQuestionId: ALERT_SLO_OPEN_QUESTION_ID,
    },
    doesNotCover: ['owner-reads-everything', 'direct-sql-bypasses-the-application'],
  },
  {
    id: 'outbox_lag',
    rule: 'The oldest unpublished outbox event is older than the configured age, so a domain effect has stopped happening.',
    severity: 'immediate',
    threshold: { kind: 'setting', settingKey: OUTBOX_LAG_THRESHOLD_SETTING_KEY, unit: 'seconds' },
    route: { audience: ['owner', 'manager'], surface: 'operator_review' },
    runbook: 'alerting#the-outbox-has-stopped-draining',
    slo: {
      measure: 'The 95th percentile age of an outbox event at the moment it is published.',
      measuredFrom: ['outbox_event.occurred_at', 'outbox_event.published_at'],
      windowDays: 30,
      target: null,
      openQuestionId: ALERT_SLO_OPEN_QUESTION_ID,
    },
    doesNotCover: ['the-pass-cannot-report-its-own-absence'],
  },
  {
    id: 'send_backlog',
    rule: 'More messages are queued and unsent than the configured backlog, so the front desk is telling clients something the system has not sent.',
    severity: 'same_day',
    threshold: {
      kind: 'setting',
      settingKey: SEND_BACKLOG_THRESHOLD_SETTING_KEY,
      unit: 'messages',
    },
    // The one alert with a surface rather than a notification, and the reason is who needs it: a
    // receptionist taking a booking needs to know the confirmation has not gone out BEFORE they tell
    // somebody it has. That is a banner on the screen they are already looking at.
    route: { audience: ['owner', 'manager', 'receptionist'], surface: 'admin_banner' },
    runbook: 'alerting#messages-are-delayed',
    slo: {
      measure:
        'The 95th percentile delay between a message being queued and a vendor accepting it.',
      measuredFrom: ['message.queued_at', 'message.sent_at'],
      windowDays: 30,
      target: null,
      openQuestionId: ALERT_SLO_OPEN_QUESTION_ID,
    },
    doesNotCover: ['the-pass-cannot-report-its-own-absence'],
  },
  {
    id: 'job_failure_rate',
    rule: 'An agent has failed its declared number of consecutive runs, which is the shape of silence that needs a stack trace rather than a restart.',
    severity: 'immediate',
    threshold: {
      kind: 'setting',
      settingKey: JOB_FAILURE_THRESHOLD_SETTING_KEY,
      unit: 'attempts',
    },
    route: { audience: OWNER_ONLY_AUDIENCE, surface: 'operator_review' },
    runbook: 'alerting#an-agent-is-failing-every-run',
    slo: {
      measure:
        'The share of scheduled runs that succeeded, per agent, counted from the attempts the heartbeat ' +
        'records rather than from the absence of a complaint.',
      measuredFrom: ['agent_heartbeat.consecutive_failures', 'agent_heartbeat.last_success_at'],
      windowDays: 30,
      target: null,
      openQuestionId: ALERT_SLO_OPEN_QUESTION_ID,
    },
    // Deliberately NOT `the-pass-cannot-report-its-own-absence`: the watchdog's 2x-interval alert is the
    // one that fires when an agent stops entirely, and this alert is about the other shape — running and
    // failing. A pass that is not running misses both, which is that exception's subject, and naming it
    // on every entry would make the set-equality check pass while saying nothing.
    doesNotCover: [],
  },
  {
    id: 'repeated_auth_failure',
    rule: 'One staff credential has been refused more times in the window than the configured count, which is either somebody locked out or somebody guessing.',
    severity: 'immediate',
    threshold: {
      kind: 'setting',
      settingKey: AUTH_FAILURE_THRESHOLD_SETTING_KEY,
      unit: 'attempts',
    },
    route: { audience: OWNER_ONLY_AUDIENCE, surface: 'operator_review' },
    runbook: 'alerting#repeated-sign-in-failures-on-one-account',
    slo: {
      measure:
        'The share of refused sign-in bursts that were explained — locked out, or an attempt that was ' +
        'not the account holder.',
      measuredFrom: ['audit_event.occurred_at', 'audit_event.operation', 'audit_event.actor_label'],
      windowDays: 30,
      target: null,
      openQuestionId: ALERT_SLO_OPEN_QUESTION_ID,
    },
    doesNotCover: ['owner-reads-everything', 'refused-sign-ins-are-unmetered'],
  },
  {
    id: 'overdue_blocking_obligation',
    rule: 'A blocking compliance obligation is past its due date and still open, so something the business is not allowed to do without it is being done.',
    severity: 'same_day',
    threshold: {
      kind: 'structural',
      value: 1,
      unit: 'days',
      // ONE day past due, and the figure belongs to 0052 rather than to this file. That migration's own
      // comment is the authority: `obligation_instance.due_on` is compared against the TRADING date,
      // because trading runs 11:00-02:00, so at 01:30 an obligation due that date is not yet overdue.
      // One day past due is therefore the first instant the calendar screen itself calls overdue, and a
      // grace period here would be a second, quieter answer to "when is this due" than the one the
      // screen gives.
      statedIn: 'packages/db/migrations/0052_obligation.sql',
    },
    route: { audience: ['owner', 'manager'], surface: 'compliance_panel' },
    runbook: 'alerting#a-blocking-obligation-is-overdue',
    slo: {
      measure:
        'The share of blocking obligations completed on or before their due date, counted on the trading ' +
        'date the calendar uses.',
      measuredFrom: ['obligation_instance.due_on', 'obligation_instance.completed_at'],
      windowDays: 365,
      target: null,
      openQuestionId: ALERT_SLO_OPEN_QUESTION_ID,
    },
    doesNotCover: ['the-pass-cannot-report-its-own-absence'],
  },
  {
    id: 'unreconciled_settlement_batch',
    rule:
      'A settlement batch that does not tie to the figures this build holds: quarantined because its ' +
      'declared net and the sum of its lines disagree, or carrying a settlement_variance row. The ' +
      'acquirer has said it paid a different amount from the one the till recorded.',
    severity: 'same_day',
    threshold: {
      kind: 'structural',
      value: 1,
      unit: 'batches',
      /*
       * ONE, and the figure belongs to 0136 rather than to this file. `settlement_variance_difference_nonzero`
       * is a CHECK — ZY447, "a variance of nought fils is not a variance" — so a variance row EXISTS only
       * when two figures disagree, and there is no band of tolerable disagreement for a threshold to be
       * inside. A setting here would be a tolerance on money that somebody could widen from a settings
       * screen with nothing recording that they had.
       */
      statedIn: 'packages/db/migrations/0136_settlement_batch.sql',
    },
    // The owner and the accountant, and not the manager: a payout that does not tie is reconciled against
    // the till roll and the payout advice, which is the accountant's work, and the remedy may be a
    // corrected file from the acquirer, which is the owner's conversation.
    route: { audience: ['owner', 'accountant'], surface: 'operator_review' },
    runbook: 'alerting#a-settlement-batch-does-not-reconcile',
    slo: {
      measure:
        'The share of imported settlement batches that tied on the day they arrived, and how long an ' +
        'untied one stayed quarantined before it was explained.',
      measuredFrom: [
        'settlement_batch.state',
        'settlement_batch.settled_on',
        'settlement_batch.imported_at',
        'settlement_variance.difference_fils',
      ],
      windowDays: 90,
      target: null,
      openQuestionId: ALERT_SLO_OPEN_QUESTION_ID,
    },
    doesNotCover: ['the-pass-cannot-report-its-own-absence'],
  },
] as const satisfies readonly AlertDefinition[]

/**
 * The ids, as a union of literals rather than `string`.
 *
 * This is what makes the evaluator's observer map exhaustive: a `Record<AlertId, Observer>` cannot be
 * written with an entry missing and cannot carry one the registry does not declare. `as const satisfies`
 * and not a type annotation on the array is what keeps the literals — an annotated
 * `readonly AlertDefinition[]` widens every id to `string`, and the map then accepts anything.
 */
export type AlertId = (typeof ALERT_REGISTRY)[number]['id']

/** Every id, in registry order. */
export const ALERT_IDS: readonly AlertId[] = ALERT_REGISTRY.map((entry) => entry.id)

export function alertDefinition(id: string): AlertDefinition {
  const found = ALERT_REGISTRY.find((entry) => entry.id === id)
  if (found === undefined) {
    throw new Error(
      `No alert is registered as "${id}". Every alert this build raises is a row in ALERT_REGISTRY; ` +
        'an alert raised from a string is one nothing can route, threshold or document.',
    )
  }
  return found
}

/** The setting keys the registry depends on, so the F09 registry and this one can be held equal. */
export const ALERT_THRESHOLD_SETTING_KEYS: readonly string[] = ALERT_REGISTRY.flatMap(
  (entry): readonly string[] =>
    entry.threshold.kind === 'setting' ? [entry.threshold.settingKey] : [],
)

/**
 * The registry's own invariants, asserted at module load.
 *
 * Here and not only in the gate because an entry whose `doesNotCover` names nothing real is a
 * limitation stated as a word, and a module that loads with one has already shipped it. The gate proves
 * the claims that reach outside this file; these are the ones that do not.
 */
function assertRegistry(): void {
  const ids = ALERT_REGISTRY.map((e) => e.id)
  const duplicate = ids.find((id, at) => ids.indexOf(id) !== at)
  if (duplicate !== undefined) {
    throw new Error(`Alert "${duplicate}" is registered twice. One condition, one id.`)
  }
  for (const entry of ALERT_REGISTRY) {
    for (const id of entry.doesNotCover) {
      if (!UNDEFENDED_IDS.has(id)) {
        throw new Error(
          `Alert "${entry.id}" says it does not cover "${id}", which UNDEFENDED_BY_DESIGN does not ` +
            'define. A limitation nobody wrote out is a limitation nobody can read.',
        )
      }
    }
  }
  const named = new Set<string>(ALERT_REGISTRY.flatMap((e): readonly string[] => e.doesNotCover))
  for (const undefended of UNDEFENDED_BY_DESIGN) {
    if (!named.has(undefended.id)) {
      throw new Error(
        `UNDEFENDED_BY_DESIGN defines "${undefended.id}" and no alert names it in doesNotCover. The ` +
          'exception has to be attached to the alert somebody would otherwise believe, or it is a page ' +
          'nobody opens.',
      )
    }
  }
}

assertRegistry()
