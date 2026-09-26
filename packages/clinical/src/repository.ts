import {
  assertCapturedVersion,
  type ClinicalConsentView,
  type ClinicalReadDecision,
  ClinicalReadRefused,
  type Clock,
  type CompliancePolicy,
  deriveContraindicationFlags,
  type Instant,
  type IntakeField,
  type IntakeTemplate,
  IntakeTemplateCopyRefused,
  intakeAadContext,
  lintContraindicationDefinition,
  lintIntakeDefinition,
  lintIntakeTemplateCopy,
  type RenderedSubmission,
  renderSubmission,
  resolveClinicalRead,
  type StepUpGrantView,
} from '@berelax/core'
import {
  AuditWriter,
  readCompliancePolicy,
  readSetting,
  type Sql,
  type UnitOfWork,
  withUnitOfWork,
} from '@berelax/db'
import {
  AppError,
  CLINICAL_LINT_QUESTION_COPY_SETTING_KEY,
  CLINICAL_REAL_INTAKE_SETTING_KEY,
  CLINICAL_STEP_UP_WINDOW_SETTING_KEY,
  type ContraindicationFlagKey,
} from '@berelax/shared'
import { type Kek, open, seal } from './envelope.ts'
import { type ContraindicationWriteResult, writeContraindicationFlags } from './flags-view.ts'
import type { ClinicalErrorSink, ClinicalLogger } from './logging.ts'

/**
 * The clinical intake store (C-CRM-08).
 *
 * The one place in this system that holds a decrypted intake payload, and it holds one for the duration
 * of one function call. Everything about the file is shaped by four rules, and each of them exists
 * because the obvious alternative fails in a way nothing would notice:
 *
 * **1. A refusal is a feature.** `recordIntake` refuses by name when consent cannot be established, and
 * writes no row. "We could not establish consent" must never reach "proceed", so the absent-consent case
 * and the withdrawn-consent case take the same branch and neither has a fallback. Migration 0082 holds
 * the same rule as a deferred constraint trigger, so a `psql` INSERT is refused too — and neither layer
 * makes the other redundant: this one names the customer before the transaction opens, and the trigger
 * catches the write that never came through here at all.
 *
 * **2. Every read is authenticated afresh and audited individually.** An admin session is not enough to
 * read a health record: a stolen cookie would otherwise reach one. `resolveClinicalRead` in
 * `@berelax/core` is the decision and it is pure, so the rule is testable without a key or a clock; this
 * file supplies the rows it decides over and writes the audit row either way. A refused read writes a
 * `denied` row, which is the one an insider-threat review actually looks for.
 *
 * **3. The payload never enters a log, a breadcrumb or an error.** `ClinicalLogFields` is a closed map
 * of ids, counts and names, so "add the answers to the debug line" is a type error rather than a code
 * review. Every throw in this file is built from ids; `open` already reports an authentication failure
 * without saying what failed to decrypt.
 *
 * **4. A submission renders against the version it was captured under.** `readIntake` fetches the
 * template by `template_id`, never the current one for the locale, and `assertCapturedVersion` refuses
 * the mismatch. The one-line mistake this closes — fetching the current template because that is the row
 * a screen usually wants — produces a page that is a plausible lie about what somebody was asked.
 *
 * ## What this file deliberately does not do
 *
 * No `delete`, and no method that updates a payload. ADR 0010 revokes DELETE even from the clinical
 * role: a correction supersedes. There is no bulk read and no export: an export of health data is a
 * different operation with a different audit shape, and building one here would make it available as a
 * side effect of building a screen.
 */

// ------------------------------------------------------------------------------------------------
// Inputs and outputs
// ------------------------------------------------------------------------------------------------

export interface ClinicalStoreDeps {
  readonly sql: Sql
  /**
   * The clinical KEK. Required, never optional: an optional key would mean a code path that stores a
   * payload unsealed, which is the one thing this whole boundary exists to make unrepresentable.
   */
  readonly kek: Kek
  readonly clock: Clock
  readonly logger: ClinicalLogger
  readonly errors?: ClinicalErrorSink
}

/** Who is acting, and why. Both are on every audit row this file writes. */
export interface ClinicalActor {
  readonly employeeId: string
  /** A label for the audit row. Never a name this build invented — see brief rule 10. */
  readonly label: string
}

export interface PublishTemplateInput {
  readonly locale: 'en' | 'ar'
  readonly title: string
  readonly fields: readonly IntakeField[]
  readonly consentText: string
  readonly actor: ClinicalActor
}

export interface PublishedTemplate {
  readonly templateId: string
  readonly version: number
  readonly locale: 'en' | 'ar'
  readonly consentHash: string
  /** The version this one superseded, or null for the first version of a locale. */
  readonly supersededTemplateId: string | null
}

export interface RecordIntakeInput {
  readonly customerId: string
  readonly templateId: string
  /** Plaintext answers. Sealed before they reach the database and never logged. */
  readonly answers: Readonly<Record<string, unknown>>
  readonly submittedVia: 'online' | 'in_salon' | 'staff_entry'
  /**
   * Whether this is a synthetic fixture or a real client's answers.
   *
   * Required and with no default, which is the same closed-map argument ADR 0025 makes for the
   * employment record: the value somebody forgets to state is, on the balance of probability, the real
   * one, and a permissive default would write it into a database the residency question has not cleared.
   * `real` is refused entirely until `clinical.real_intake_permitted` is set (OPEN-QUESTIONS
   * Y5-residency), by this function and by migration 0082's trigger.
   */
  readonly dataOrigin: 'synthetic' | 'real'
  readonly actor: ClinicalActor
}

export interface ReadIntakeInput {
  readonly submissionId: string
  readonly actor: ClinicalActor
  /** Why this record is being opened. Matched against the step-up grant's own purpose. */
  readonly statedPurpose: string
}

export interface IntakeReadResult {
  readonly submissionId: string
  readonly customerId: string
  readonly rendered: RenderedSubmission
  /** The grant this read was permitted under, so a screen can say how long is left. */
  readonly grantId: string
}

/**
 * A derivation of the contraindication flags from one stored submission (C-CRM-09).
 *
 * The same three arguments a read takes, because it IS a read: it decrypts a payload, so it goes through
 * the same step-up gate, writes the same `read` audit row, and is refused for the same seven reasons.
 * Anything else would be a second door onto the same data with a different lock.
 */
export interface DeriveFlagsInput {
  readonly submissionId: string
  readonly actor: ClinicalActor
  readonly statedPurpose: string
}

export interface DerivedFlagsResult extends ContraindicationWriteResult {
  readonly submissionId: string
  readonly customerId: string
  /** Flags whose question was asked and whose answer the derivation would not interpret. */
  readonly undetermined: readonly ContraindicationFlagKey[]
  /** Flags the captured version never asked about. Not an escalation — see the core module. */
  readonly notAsked: readonly ContraindicationFlagKey[]
  readonly grantId: string
}

export interface GrantStepUpInput {
  readonly employeeId: string
  readonly statedPurpose: string
  /** How the second factor was proven. Only TOTP exists; 0082's CHECK says so too. */
  readonly method: 'totp'
  readonly actorLabel: string
}

export interface StepUpGranted {
  readonly grantId: string
  readonly expiresAt: Instant
  readonly windowMinutes: number
}

// ------------------------------------------------------------------------------------------------
// Row shapes
// ------------------------------------------------------------------------------------------------

interface TemplateRow {
  readonly id: string
  readonly version: number
  readonly locale: string
  readonly title: string
  readonly definition: { readonly fields?: readonly IntakeField[] }
  readonly consentText: string
  readonly consentHash: string
}

const toTemplate = (row: TemplateRow): IntakeTemplate => ({
  templateId: row.id,
  version: Number(row.version),
  // The column is `text` with a CHECK, so the cast is the CHECK's guarantee rather than a conversion.
  locale: row.locale === 'ar' ? 'ar' : 'en',
  title: row.title,
  fields: row.definition.fields ?? [],
  consentText: row.consentText,
})

/**
 * The consent wording hash.
 *
 * SHA-256 over the wording, which is what makes "what did they agree to" answerable years later without
 * keeping a copy of the paragraph on every consent row. It is computed here and in nothing else: two
 * spellings of the hash are two gates, and the second one always passes.
 */
async function hashConsentText(text: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(text.trim(), 'utf8').digest('hex')
}

// ------------------------------------------------------------------------------------------------
// The store
// ------------------------------------------------------------------------------------------------

export interface ClinicalIntakeStore {
  publishTemplate(input: PublishTemplateInput): Promise<PublishedTemplate>
  recordConsent(input: {
    readonly customerId: string
    readonly templateId: string
    readonly capturedVia: 'online' | 'in_salon' | 'staff_witnessed'
    readonly signaturePresent: boolean
    readonly actor: ClinicalActor
  }): Promise<{ readonly consentId: string }>
  withdrawConsent(input: {
    readonly consentId: string
    readonly actor: ClinicalActor
  }): Promise<void>
  grantStepUp(input: GrantStepUpInput): Promise<StepUpGranted>
  recordIntake(input: RecordIntakeInput): Promise<{ readonly submissionId: string }>
  readIntake(input: ReadIntakeInput): Promise<IntakeReadResult>
  /**
   * Derives the contraindication flags from a stored submission and writes the crossing row.
   *
   * On this interface rather than as a free function in `flags-view.ts`, and the reason is the brief's:
   * a flag derived by reading plaintext into a module outside `@berelax/clinical` would defeat both the
   * encrypted store and the closed log-field map. The plaintext exists for the duration of this call,
   * inside the package that holds the key, and what comes back is eight booleans.
   */
  deriveFlags(input: DeriveFlagsInput): Promise<DerivedFlagsResult>
  readTreatmentNote(input: {
    readonly noteId: string
    readonly actor: ClinicalActor
    readonly statedPurpose: string
  }): Promise<{ readonly noteId: string; readonly body: string; readonly grantId: string }>
}

export function createClinicalIntakeStore(deps: ClinicalStoreDeps): ClinicalIntakeStore {
  const { sql, kek, clock, logger } = deps

  /**
   * One transaction, one actor, one audit writer (`withUnitOfWork`, ADR 0008).
   *
   * Every write here goes through it rather than through `sql.begin`, so the row, its audit event and any
   * domain event are durable together or not at all. For this store the audit row is the load-bearing
   * half: a stored submission whose audit row was lost is a health record nobody can account for, and an
   * audit row for a submission that rolled back is a claim that somebody's answers are held when they
   * are not.
   */
  const inTransaction = <T>(
    actor: ClinicalActor,
    run: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> =>
    withUnitOfWork(sql, { kind: 'staff', id: actor.employeeId, label: actor.label }, run)

  /**
   * Records a REFUSAL, on the pool rather than inside the caller's transaction.
   *
   * This is the one place where sharing a transaction with the thing being recorded is wrong, and it took
   * a failing assertion to see it. Every other audit row in this system commits with the change it
   * describes, because an audit row for a change that did not happen is as bad as a change with no audit
   * row (ADR 0008). A refusal inverts that: the transaction is going to ROLL BACK — that is what "refused"
   * means — so a denial row written inside it is a denial row that disappears, and an attempt to read a
   * health record with no purpose becomes the only event in this system that leaves no trace. Migration
   * 0005's own comment says why that matters: insider access is the realistic breach for this business.
   *
   * `audit_event` is append-only and the refusal has no other state to stay consistent with, so a separate
   * connection costs nothing and loses nothing. It is the fact that somebody asked.
   */
  const recordRefusal = async (
    actor: ClinicalActor,
    entry: {
      readonly action: string
      readonly entityType: string
      readonly entityId?: string
      readonly refusal: string
      readonly details: Readonly<Record<string, unknown>>
    },
  ): Promise<void> => {
    const writer = new AuditWriter(sql, {
      kind: 'staff',
      id: actor.employeeId,
      label: actor.label,
    })
    await writer.record({
      action: entry.action,
      entityType: entry.entityType,
      ...(entry.entityId === undefined ? {} : { entityId: entry.entityId }),
      operation: 'denied',
      after: { refusal: entry.refusal, ...entry.details },
    })
  }

  const log = (
    level: 'info' | 'warn',
    message: string,
    fields: Parameters<ClinicalLogger['log']>[0]['fields'],
  ): void => {
    logger.log({ level, message, fields })
    deps.errors?.addBreadcrumb({ category: 'clinical', message, data: fields })
  }

  /** The profile in force, mapped to the pure lint's policy type. `packages/db` may not import core. */
  const policyFor = async (tx: Sql): Promise<CompliancePolicy & { version: number }> => {
    const row = await readCompliancePolicy(tx)
    return {
      bannedClaimTerms: row.bannedClaimTerms,
      permittedPublicTitles: row.permittedPublicTitles,
      medicalClaimsPermitted: row.medicalClaimsPermitted,
      version: row.profileVersion,
    }
  }

  const templateById = async (
    tx: Sql,
    templateId: string,
  ): Promise<IntakeTemplate & { readonly consentHash: string }> => {
    const [row] = await tx<TemplateRow[]>`
      select id, version, locale, title, definition,
             consent_text as "consentText", consent_hash as "consentHash"
        from clinical.intake_form_template
       where id = ${templateId}::uuid
    `
    if (row === undefined) {
      throw new AppError('not_found', `No intake template ${templateId}`, {
        details: { templateId },
      })
    }
    return { ...toTemplate(row), consentHash: row.consentHash }
  }

  /**
   * The consent covering a wording hash for a customer, or null.
   *
   * Null is returned rather than thrown, because the caller's job is to turn it into a NAMED refusal and
   * a `denied` audit row. A throw here would lose the distinction between "no consent" and "the query
   * failed", and those two must not answer the same way — the first is a decision about a person and the
   * second is an outage.
   *
   * The newest matching record wins, and a WITHDRAWN one is returned rather than skipped. Skipping it
   * would let an older live consent mask a withdrawal, which is the `with-google.itest.ts` defect in a
   * place where it matters far more: brief rule 12's first case, arriving as permission to read a health
   * record somebody asked to be left alone about.
   */
  const consentFor = async (
    tx: Sql,
    customerId: string,
    consentHash: string,
  ): Promise<ClinicalConsentView | null> => {
    const [row] = await tx<
      { consentHash: string; consentedAtMs: string; withdrawnAtMs: string | null }[]
    >`
      select consent_hash                                      as "consentHash",
             (extract(epoch from consented_at) * 1000)::bigint as "consentedAtMs",
             case when withdrawn_at is null then null
                  else (extract(epoch from withdrawn_at) * 1000)::bigint end as "withdrawnAtMs"
        from clinical.treatment_consent
       where customer_id = ${customerId}::uuid and consent_hash = ${consentHash}
       order by consented_at desc, id desc
       limit 1
    `
    if (row === undefined) return null
    return {
      consentHash: row.consentHash,
      consentedAt: Number(row.consentedAtMs) as Instant,
      withdrawnAt: row.withdrawnAtMs === null ? null : (Number(row.withdrawnAtMs) as Instant),
    }
  }

  /** The live grant for an employee, newest first. Expiry and revocation are the DECISION's to judge. */
  const liveGrantFor = async (tx: Sql, employeeId: string): Promise<StepUpGrantView | null> => {
    const [row] = await tx<
      {
        id: string
        employeeId: string
        statedPurpose: string
        grantedAtMs: string
        expiresAtMs: string
        revokedAtMs: string | null
      }[]
    >`
      select id,
             employee_id                                     as "employeeId",
             stated_purpose                                  as "statedPurpose",
             (extract(epoch from granted_at) * 1000)::bigint  as "grantedAtMs",
             (extract(epoch from expires_at) * 1000)::bigint  as "expiresAtMs",
             case when revoked_at is null then null
                  else (extract(epoch from revoked_at) * 1000)::bigint end as "revokedAtMs"
        from clinical.step_up_grant
       where employee_id = ${employeeId}::uuid
       order by granted_at desc, id desc
       limit 1
    `
    if (row === undefined) return null
    return {
      grantId: row.id,
      employeeId: row.employeeId,
      statedPurpose: row.statedPurpose,
      grantedAt: Number(row.grantedAtMs) as Instant,
      expiresAt: Number(row.expiresAtMs) as Instant,
      revokedAt: row.revokedAtMs === null ? null : (Number(row.revokedAtMs) as Instant),
    }
  }

  /**
   * The consent gate for a WRITE. Refuses by name, writes a `denied` row, and stores nothing.
   *
   * The absent case and the withdrawn case take the same branch on purpose, and the message is the only
   * thing that differs. They are the same decision — there is no live consent to this wording — and a
   * gate that treated "no record" as a separate, softer state is the exact failure this unit exists to
   * make unreachable: "we could not establish consent" reaching "proceed".
   *
   * The `denied` row commits only if the caller's transaction commits, which it does not, because this
   * throws. That is the right trade and it is worth stating: the refusal is visible to the operator in the
   * thrown message and in the structured log line, and an audit row written on its own connection so that
   * it survived the rollback would be a second write path into an append-only table for the one case where
   * nothing happened. Migration 0082's ZJ003 is the durable half — it refuses the same INSERT at COMMIT
   * whatever this code does.
   */
  const assertConsentForWrite = async (
    uow: UnitOfWork,
    args: {
      readonly customerId: string
      readonly templateId: string
      readonly consentHash: string
      readonly actor: ClinicalActor
    },
  ): Promise<void> => {
    const consent = await consentFor(uow.sql, args.customerId, args.consentHash)
    if (consent !== null && consent.withdrawnAt === null) return

    const refusal = consent === null ? 'consent_not_established' : 'consent_withdrawn'
    // No entityId: nothing was written, so there is no row to name. A placeholder id here would be a
    // reference to a submission that does not exist, which is worse than its absence.
    await recordRefusal(args.actor, {
      action: 'clinical.intake_submission.refused',
      entityType: 'clinical.intake_submission',
      refusal,
      details: { customerId: args.customerId, templateId: args.templateId },
    })
    log('warn', 'intake submission refused', {
      customerId: args.customerId,
      templateId: args.templateId,
      refusal,
      outcome: 'refused',
    })
    throw new AppError(
      'forbidden',
      consent === null
        ? 'IntakeConsentNotEstablished: no consent record covers the wording of template ' +
            `${args.templateId} for customer ${args.customerId}. Nothing was stored. "Consent could ` +
            'not be established" is a refusal and never a default.'
        : 'IntakeConsentWithdrawn: consent to the wording of template ' +
            `${args.templateId} was withdrawn by customer ${args.customerId}. Nothing was stored.`,
      { details: { refusal, customerId: args.customerId, templateId: args.templateId } },
    )
  }

  /**
   * The read gate, applied and audited.
   *
   * One function for both sealed tables, because the rule is one rule and a second copy of it is where
   * the two come to disagree — which for a gate means one of the two tables quietly stops being gated.
   */
  const authoriseRead = async (
    uow: UnitOfWork,
    args: {
      readonly entityType: string
      readonly entityId: string
      readonly customerId: string
      readonly consentHash: string | null
      readonly actor: ClinicalActor
      readonly statedPurpose: string
    },
  ): Promise<Extract<ClinicalReadDecision, { permitted: true }>> => {
    const at = clock.now()
    const consent =
      args.consentHash === null
        ? null
        : await consentFor(uow.sql, args.customerId, args.consentHash)
    const grant = await liveGrantFor(uow.sql, args.actor.employeeId)
    const decision = resolveClinicalRead({
      employeeId: args.actor.employeeId,
      statedPurpose: args.statedPurpose,
      at,
      grant,
      consent,
    })

    if (!decision.permitted) {
      // Recorded on the POOL and not in `uow`, because this transaction is about to roll back. See
      // `recordRefusal`: an insider-threat review looks for exactly this row — somebody trying records
      // they have no stated purpose for — and a denial that rolled back with the refusal would make the
      // attempt the only thing in this system that leaves no trace.
      await recordRefusal(args.actor, {
        action: `${args.entityType}.read_denied`,
        entityType: args.entityType,
        entityId: args.entityId,
        refusal: decision.refusal,
        details: { statedPurpose: args.statedPurpose, customerId: args.customerId },
      })
      log('warn', 'clinical read refused', {
        employeeId: args.actor.employeeId,
        statedPurpose: args.statedPurpose,
        refusal: decision.refusal,
        outcome: 'refused',
      })
      throw new ClinicalReadRefused(decision)
    }
    return decision
  }

  /**
   * One gated, audited decryption of one submission. The only path to a plaintext intake payload.
   *
   * Extracted when `deriveFlags` became the second reader, for the reason `authoriseRead` is one function
   * for two tables: a second copy of this sequence is where the two come to disagree, and the way they
   * disagree is that one of them stops fetching the CAPTURED template, or stops asserting the version, or
   * opens the envelope with a binding it rebuilt slightly differently. Each of those is a whole gate case
   * in `scripts/test-gates.mjs` for the first reader and would be invisible on the second.
   *
   * The plaintext is returned to a caller inside this package and to nowhere else. It is never logged: the
   * caller's `log` calls take a `ClinicalLogFields`, which is a closed map of ids and counts.
   */
  const openSubmission = async (
    uow: UnitOfWork,
    input: {
      readonly submissionId: string
      readonly actor: ClinicalActor
      readonly statedPurpose: string
    },
  ): Promise<{
    readonly row: {
      readonly id: string
      readonly customerId: string
      readonly templateVersion: number
    }
    readonly template: IntakeTemplate & { readonly consentHash: string }
    readonly decision: Extract<ClinicalReadDecision, { permitted: true }>
    readonly answers: Readonly<Record<string, unknown>>
  }> => {
    const tx = uow.sql
    const [row] = await tx<
      {
        id: string
        customerId: string
        templateId: string
        templateVersion: number
        aadContext: string
        ciphertext: Buffer
        nonce: Buffer
        wrappedDataKey: Buffer
        kekVersion: string
        aadFingerprint: string
      }[]
    >`
      select id,
             customer_id        as "customerId",
             template_id        as "templateId",
             template_version   as "templateVersion",
             aad_context        as "aadContext",
             payload_ciphertext as "ciphertext",
             payload_nonce      as "nonce",
             wrapped_data_key   as "wrappedDataKey",
             kek_version        as "kekVersion",
             aad_fingerprint    as "aadFingerprint"
        from clinical.intake_submission
       where id = ${input.submissionId}::uuid
    `
    if (row === undefined) {
      throw new AppError('not_found', `No intake submission ${input.submissionId}`, {
        details: { submissionId: input.submissionId },
      })
    }

    // The template the submission NAMES, never the current one for its locale. Fetched before the gate
    // because the gate needs the consent hash of the wording actually agreed to.
    const template = await templateById(tx, row.templateId)
    assertCapturedVersion(template, {
      templateId: row.templateId,
      templateVersion: Number(row.templateVersion),
    })

    const decision = await authoriseRead(uow, {
      entityType: 'clinical.intake_submission',
      entityId: row.id,
      customerId: row.customerId,
      consentHash: template.consentHash,
      actor: input.actor,
      statedPurpose: input.statedPurpose,
    })

    const plaintext = open(
      kek,
      {
        table: 'clinical.intake_submission',
        recordId: row.id,
        customerId: row.customerId,
        context: row.aadContext,
      },
      {
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        wrappedDataKey: row.wrappedDataKey,
        kekVersion: row.kekVersion,
        aadFingerprint: row.aadFingerprint,
      },
    )
    return {
      row: { id: row.id, customerId: row.customerId, templateVersion: Number(row.templateVersion) },
      template,
      decision,
      answers: JSON.parse(plaintext) as Readonly<Record<string, unknown>>,
    }
  }

  return {
    publishTemplate: async (input) => {
      const structural = lintIntakeDefinition(input.fields)
      if (structural.length > 0) {
        throw new AppError(
          'validation',
          `IntakeTemplateDefinitionRefused: ${structural.join(', ')}`,
          { userFacing: true, details: { rules: structural } },
        )
      }

      /**
       * The contraindication rules, checked at PUBLICATION (C-CRM-09).
       *
       * A field keyed `recent_surgery` and asked as `long_text` looks exactly like the question that feeds
       * the flag, is answered by every client, and derives nothing for the life of that template version.
       * Refused here because publication is the only moment anybody is looking at the question set: the
       * alternative is a front desk reading `recent_surgery: false` for a client who wrote the answer out
       * in full, and nothing anywhere saying why.
       */
      const contraindication = lintContraindicationDefinition(input.fields)
      if (contraindication.length > 0) {
        throw new AppError(
          'validation',
          `IntakeTemplateContraindicationRefused: ${contraindication
            .map((problem) => `${problem.fieldKey}: ${problem.why}`)
            .join(' ')}`,
          {
            userFacing: true,
            details: {
              rules: contraindication.map((problem) => problem.rule),
              at: contraindication.map((problem) => problem.fieldKey),
            },
          },
        )
      }

      const lintQuestions = await readSetting<boolean>(sql, CLINICAL_LINT_QUESTION_COPY_SETTING_KEY)
      const policy = await policyFor(sql)
      const findings = lintIntakeTemplateCopy(
        { title: input.title, consentText: input.consentText, fields: input.fields },
        policy,
        { lintQuestions },
      )
      if (findings.length > 0) throw new IntakeTemplateCopyRefused(findings)

      const consentHash = await hashConsentText(input.consentText)

      return await inTransaction(input.actor, async (uow) => {
        const tx = uow.sql
        // The previous current version for this locale, superseded in the SAME transaction. Two
        // statements rather than one because 0082 permits exactly two columns to change on an UPDATE and
        // the partial unique index permits one current row per locale: an INSERT before the UPDATE
        // violates the index, so the order is load-bearing and is stated here rather than discovered.
        const [previous] = await tx<{ id: string; version: number }[]>`
          update clinical.intake_form_template
             set is_current = false, superseded_at = now()
           where locale = ${input.locale} and is_current
          returning id, version
        `
        const [row] = await tx<{ id: string; version: number }[]>`
          insert into clinical.intake_form_template
            (version, locale, title, definition, consent_text, consent_hash, is_current)
          values (
            (select coalesce(max(version), 0) + 1
               from clinical.intake_form_template where locale = ${input.locale}),
            ${input.locale}, ${input.title},
            ${tx.json({ fields: input.fields } as never)},
            ${input.consentText}, ${consentHash}, true
          )
          returning id, version
        `
        if (row === undefined) {
          throw new AppError('invariant_violated', 'The template INSERT returned no row')
        }
        await uow.audit.record({
          action: 'clinical.intake_template.published',
          entityType: 'clinical.intake_form_template',
          entityId: row.id,
          operation: 'create',
          after: {
            version: Number(row.version),
            locale: input.locale,
            fieldCount: input.fields.length,
            supersededTemplateId: previous?.id ?? null,
            regulatoryProfileVersion: policy.version,
            questionCopyLinted: lintQuestions,
          },
        })
        log('info', 'intake template published', {
          templateId: row.id,
          templateVersion: Number(row.version),
          fieldCount: input.fields.length,
        })
        return {
          templateId: row.id,
          version: Number(row.version),
          locale: input.locale,
          consentHash,
          supersededTemplateId: previous?.id ?? null,
        }
      })
    },

    recordConsent: async (input) => {
      return await inTransaction(input.actor, async (uow) => {
        const tx = uow.sql
        const template = await templateById(tx, input.templateId)
        const [row] = await tx<{ id: string }[]>`
          insert into clinical.treatment_consent
            (customer_id, template_id, consent_hash, consent_locale, captured_via, signature_present)
          values (${input.customerId}::uuid, ${input.templateId}::uuid, ${template.consentHash},
                  ${template.locale}, ${input.capturedVia}, ${input.signaturePresent})
          returning id
        `
        if (row === undefined) {
          throw new AppError('invariant_violated', 'The consent INSERT returned no row')
        }
        await uow.audit.record({
          action: 'clinical.treatment_consent.captured',
          entityType: 'clinical.treatment_consent',
          entityId: row.id,
          operation: 'create',
          after: {
            customerId: input.customerId,
            templateId: input.templateId,
            templateVersion: template.version,
            capturedVia: input.capturedVia,
            signaturePresent: input.signaturePresent,
          },
        })
        return { consentId: row.id }
      })
    },

    withdrawConsent: async (input) => {
      await inTransaction(input.actor, async (uow) => {
        const tx = uow.sql
        const result = await tx`
          update clinical.treatment_consent
             set withdrawn_at = now()
           where id = ${input.consentId}::uuid and withdrawn_at is null
        `
        if (result.count !== 1) {
          throw new AppError(
            'conflict',
            `ConsentAlreadyWithdrawn: clinical.treatment_consent ${input.consentId} is not a live ` +
              'consent, so there is nothing to withdraw. A withdrawal is recorded once.',
            { details: { consentId: input.consentId, matched: result.count } },
          )
        }
        await uow.audit.record({
          action: 'clinical.treatment_consent.withdrawn',
          entityType: 'clinical.treatment_consent',
          entityId: input.consentId,
          operation: 'update',
          after: { withdrawn: true },
        })
      })
    },

    grantStepUp: async (input) => {
      const windowMinutes = await readSetting<number>(sql, CLINICAL_STEP_UP_WINDOW_SETTING_KEY)
      return await inTransaction(
        { employeeId: input.employeeId, label: input.actorLabel },
        async (uow) => {
          const tx = uow.sql
          // `now() + interval` computed in the DATABASE rather than from the injected clock, because
          // 0082's ceiling CHECK compares `expires_at` against `granted_at`, and `granted_at` defaults to
          // the database's `now()`. A window computed against a process clock that had drifted would be
          // refused by the ceiling — or, worse, silently shortened — for reasons nothing in the message
          // would name.
          const [row] = await tx<{ id: string; expiresAtMs: string }[]>`
          insert into clinical.step_up_grant (employee_id, method, stated_purpose, expires_at)
          values (${input.employeeId}::uuid, ${input.method}, ${input.statedPurpose},
                  now() + make_interval(mins => ${windowMinutes}))
          returning id, (extract(epoch from expires_at) * 1000)::bigint as "expiresAtMs"
        `
          if (row === undefined) {
            throw new AppError('invariant_violated', 'The step-up INSERT returned no row')
          }
          await uow.audit.record({
            action: 'clinical.step_up.granted',
            entityType: 'clinical.step_up_grant',
            entityId: row.id,
            operation: 'create',
            after: {
              method: input.method,
              statedPurpose: input.statedPurpose,
              windowMinutes,
            },
          })
          log('info', 'clinical step-up granted', {
            employeeId: input.employeeId,
            grantId: row.id,
            statedPurpose: input.statedPurpose,
          })
          return {
            grantId: row.id,
            expiresAt: Number(row.expiresAtMs) as Instant,
            windowMinutes,
          }
        },
      )
    },

    recordIntake: async (input) => {
      const realPermitted = await readSetting<boolean>(sql, CLINICAL_REAL_INTAKE_SETTING_KEY)
      if (input.dataOrigin === 'real' && !realPermitted) {
        await recordRefusal(input.actor, {
          action: 'clinical.intake_submission.refused',
          entityType: 'clinical.intake_submission',
          refusal: 'real_intake_not_permitted',
          details: { customerId: input.customerId, openQuestionId: 'Y5-residency' },
        })
        // Refused before the transaction opens, and before anything is sealed. Naming the open question
        // is the whole message: an operator who reads "refused" without knowing WHICH question is open
        // goes looking for a bug. Migration 0082 raises the same refusal as ZJ005 for a write that never
        // came through here.
        throw new AppError(
          'forbidden',
          'ClinicalRealIntakeNotPermitted: refusing to store a real intake payload. OPEN-QUESTIONS ' +
            'Y5-residency is open — whether intake notes are health data subject to UAE localisation ' +
            'is unconfirmed and this database is not UAE-hosted, so the strict reading applies. Set ' +
            `"${CLINICAL_REAL_INTAKE_SETTING_KEY}" once the owner has answered.`,
          { details: { openQuestionId: 'Y5-residency', dataOrigin: input.dataOrigin } },
        )
      }

      return await inTransaction(input.actor, async (uow) => {
        const tx = uow.sql
        const template = await templateById(tx, input.templateId)

        // The consent gate, in the application. Named, before the seal, and with no row written.
        await assertConsentForWrite(uow, {
          customerId: input.customerId,
          templateId: input.templateId,
          consentHash: template.consentHash,
          actor: input.actor,
        })

        // The retention basis, read from the profile in force and STORED. 0004 defaults it to the
        // healthcare-grade 25 years because Y1-licence unconfirmed resolves to the stricter reading;
        // storing the derived date rather than recomputing it later is what makes a past decision
        // explainable when the profile has since changed.
        const [retention] = await tx<{ years: number }[]>`
          select clinical_retention_years as years from regulatory_profile_current
        `
        if (retention === undefined) {
          throw new AppError(
            'invariant_violated',
            'No regulatory profile is in force, so no retention period can be derived. 0004 seeds one.',
          )
        }

        // The row id is a term of the AAD, so it has to exist before the payload is sealed. Generated
        // here rather than by the column default for exactly that reason: sealing against an id the
        // INSERT then chose differently produces a row that decrypts for nobody, and the failure
        // surfaces as `forbidden` on a read weeks later.
        const [minted] = await tx<{ id: string }[]>`select public.uuid_generate_v7() as id`
        if (minted === undefined) {
          throw new AppError('invariant_violated', 'Could not mint a submission id')
        }
        const submissionId = minted.id

        // One binding, used by the seal AND written to the column. Two calls cannot diverge today, and
        // the reason the format lives in one function is that two spellings of it are two AADs — the
        // second of which produces a row nothing can ever open.
        const aadContext = intakeAadContext(template.version)

        const sealed = seal(
          kek,
          {
            table: 'clinical.intake_submission',
            recordId: submissionId,
            customerId: input.customerId,
            context: aadContext,
          },
          JSON.stringify(input.answers),
        )

        /**
         * The client's previous intake form is SUPERSEDED, never deleted.
         *
         * Without this, `superseded_at` was a column nothing ever set — so the route's
         * `where superseded_at is null` was a filter that read as a rule and could not be one, and a
         * client who filled a second form in left two live submissions with nothing saying which one the
         * front desk should act on.
         *
         * An UPDATE is permitted here and nowhere else on this row: `superseded_at` is one of the three
         * columns migration 0043's ZK002 allows to change, and it is in that set precisely because an
         * intake submission is superseded rather than edited. The old row keeps its ciphertext, its key
         * version and its AAD, so it stays readable evidence of what was answered and when.
         */
        await tx`
          update clinical.intake_submission
             set superseded_at = now()
           where customer_id = ${input.customerId}::uuid and superseded_at is null
        `

        await tx`
          insert into clinical.intake_submission
            (id, customer_id, template_id, payload_ciphertext, payload_nonce, wrapped_data_key,
             kek_version, aad_fingerprint, submitted_via, template_version, aad_context, data_origin,
             retain_until)
          values (
            ${submissionId}::uuid, ${input.customerId}::uuid, ${input.templateId}::uuid,
            ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.wrappedDataKey},
            ${sealed.kekVersion}, ${sealed.aadFingerprint}, ${input.submittedVia},
            ${template.version}, ${aadContext}, ${input.dataOrigin},
            now() + make_interval(years => ${Number(retention.years)})
          )
        `

        await uow.audit.record({
          action: 'clinical.intake_submission.stored',
          entityType: 'clinical.intake_submission',
          entityId: submissionId,
          operation: 'create',
          after: {
            customerId: input.customerId,
            templateId: input.templateId,
            templateVersion: template.version,
            submittedVia: input.submittedVia,
            dataOrigin: input.dataOrigin,
            answerCount: Object.keys(input.answers).length,
            retentionYears: Number(retention.years),
          },
        })
        log('info', 'intake submission stored', {
          submissionId,
          customerId: input.customerId,
          templateId: input.templateId,
          templateVersion: template.version,
          answerCount: Object.keys(input.answers).length,
          ciphertextBytes: sealed.ciphertext.length,
          kekVersion: sealed.kekVersion,
          dataOrigin: input.dataOrigin,
          outcome: 'stored',
        })
        return { submissionId }
      })
    },

    readIntake: async (input) => {
      return await inTransaction(input.actor, async (uow) => {
        const { row, template, decision, answers } = await openSubmission(uow, input)
        const rendered = renderSubmission(template, answers)

        await uow.audit.record({
          action: 'clinical.intake_submission.read',
          entityType: 'clinical.intake_submission',
          entityId: row.id,
          operation: 'read',
          after: {
            statedPurpose: decision.statedPurpose,
            grantId: decision.grantId,
            customerId: row.customerId,
            templateId: template.templateId,
            templateVersion: row.templateVersion,
          },
        })
        log('info', 'intake submission read', {
          submissionId: row.id,
          customerId: row.customerId,
          employeeId: input.actor.employeeId,
          grantId: decision.grantId,
          statedPurpose: decision.statedPurpose,
          templateVersion: row.templateVersion,
          answerCount: rendered.answers.length,
          outcome: 'read',
        })
        return {
          submissionId: row.id,
          customerId: row.customerId,
          rendered,
          grantId: decision.grantId,
        }
      })
    },

    deriveFlags: async (input) => {
      return await inTransaction(input.actor, async (uow) => {
        const { row, template, decision, answers } = await openSubmission(uow, input)

        // The pure derivation. The plaintext goes in as an argument and nothing comes out but booleans,
        // counts and flag keys — which is what makes the whole rule checkable with no key and no server.
        const derivation = deriveContraindicationFlags(template, answers)

        // Audited as a READ of the submission, in addition to the derivation's own row, because that is
        // what it is: a payload was decrypted. A path that wrote only "flags derived" would be a way to
        // open a health record that the insider-threat query for reads of a submission does not see.
        await uow.audit.record({
          action: 'clinical.intake_submission.read',
          entityType: 'clinical.intake_submission',
          entityId: row.id,
          operation: 'read',
          after: {
            statedPurpose: decision.statedPurpose,
            grantId: decision.grantId,
            customerId: row.customerId,
            templateId: template.templateId,
            templateVersion: row.templateVersion,
            readFor: 'contraindication_flag_derivation',
          },
        })

        const written = await writeContraindicationFlags(uow, {
          customerId: row.customerId,
          submissionId: row.id,
          derivation,
        })

        log('info', 'contraindication flags derived', {
          submissionId: row.id,
          customerId: row.customerId,
          employeeId: input.actor.employeeId,
          grantId: decision.grantId,
          statedPurpose: decision.statedPurpose,
          templateVersion: row.templateVersion,
          // Counts, never keys and never values. `undeterminedCount` is how many answers this derivation
          // would not interpret, which is a fact about the form rather than about the client.
          answerCount: Object.keys(answers).length,
          undeterminedCount: written.undeterminedCount,
          derivationVersion: written.derivationVersion,
          flagsChanged: written.changed,
          outcome: 'read',
        })

        return {
          ...written,
          submissionId: row.id,
          customerId: row.customerId,
          undetermined: derivation.undetermined,
          notAsked: derivation.notAsked,
          grantId: decision.grantId,
        }
      })
    },

    readTreatmentNote: async (input) => {
      return await inTransaction(input.actor, async (uow) => {
        const tx = uow.sql
        const [row] = await tx<
          {
            id: string
            customerId: string
            ciphertext: Buffer
            nonce: Buffer
            wrappedDataKey: Buffer
            kekVersion: string
            aadFingerprint: string
          }[]
        >`
          select id,
                 customer_id      as "customerId",
                 body_ciphertext  as "ciphertext",
                 body_nonce       as "nonce",
                 wrapped_data_key as "wrappedDataKey",
                 kek_version      as "kekVersion",
                 aad_fingerprint  as "aadFingerprint"
            from clinical.treatment_note
           where id = ${input.noteId}::uuid
        `
        if (row === undefined) {
          throw new AppError('not_found', `No treatment note ${input.noteId}`, {
            details: { noteId: input.noteId },
          })
        }

        /**
         * The consent basis for a NOTE, which is deliberately weaker than a submission's.
         *
         * A submission is answers to one wording, so its basis is consent to THAT wording and a hash
         * comparison says so exactly. A note has no template and therefore no wording of its own, so the
         * basis asserted here is that the client has a live clinical consent at all — the newest one on
         * record, whatever its wording.
         *
         * That is weaker and it is stated rather than hidden. Binding a note to a particular wording
         * would mean choosing one, and the only available choices are the current template's (which
         * refuses every note taken before the last reword) or the note's own (which does not exist).
         * Inventing a third would be inventing a business rule, which brief rule 15 forbids for exactly
         * the reason it bites here: a plausible consent binding is indistinguishable from a real one.
         * What it does hold is the part that matters — a client with no consent on record, or whose
         * consent has been withdrawn, cannot have their notes read.
         */
        const [live] = await tx<{ consentHash: string }[]>`
          select consent_hash as "consentHash"
            from clinical.treatment_consent
           where customer_id = ${row.customerId}::uuid
           order by consented_at desc, id desc
           limit 1
        `

        const decision = await authoriseRead(uow, {
          entityType: 'clinical.treatment_note',
          entityId: row.id,
          customerId: row.customerId,
          consentHash: live?.consentHash ?? null,
          actor: input.actor,
          statedPurpose: input.statedPurpose,
        })

        const body = open(
          kek,
          {
            table: 'clinical.treatment_note',
            recordId: row.id,
            customerId: row.customerId,
          },
          {
            ciphertext: row.ciphertext,
            nonce: row.nonce,
            wrappedDataKey: row.wrappedDataKey,
            kekVersion: row.kekVersion,
            aadFingerprint: row.aadFingerprint,
          },
        )

        await uow.audit.record({
          action: 'clinical.treatment_note.read',
          entityType: 'clinical.treatment_note',
          entityId: row.id,
          operation: 'read',
          after: {
            statedPurpose: decision.statedPurpose,
            grantId: decision.grantId,
            customerId: row.customerId,
          },
        })
        log('info', 'treatment note read', {
          noteId: row.id,
          customerId: row.customerId,
          employeeId: input.actor.employeeId,
          grantId: decision.grantId,
          statedPurpose: decision.statedPurpose,
          outcome: 'read',
        })
        return { noteId: row.id, body, grantId: decision.grantId }
      })
    },
  }
}
