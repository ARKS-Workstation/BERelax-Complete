#!/usr/bin/env node
/**
 * The half of the messaging choke point that no type and no import rule can express.
 *
 * C-AUTO-04's title is its specification: *one choke point, code not configuration*. Every promotional
 * message passes through `sendMessage` in `packages/messaging/src/send.ts`, which judges the template,
 * resolves the sender identity, runs the gate and only then reaches a transport — and the claim that
 * NOTHING sends any other way can only be made by something that fails when a second path appears.
 * Reviewing call sites is not that. So this file is that, in four rules, each with a known-bad fixture in
 * `scripts/test-gates.mjs` that asserts rejection BY NAME.
 *
 * ## What the existing guards already do, and the three holes they leave
 *
 * `messaging-providers-only-inside-a-transport` in `.dependency-cruiser.cjs` closes the *import path* to
 * an SMS or email provider: only `packages/messaging/src/transports` may reach one. That is a
 * module-to-module edge, which is the only kind of thing dependency-cruiser sees, and it is genuinely the
 * hard half. It leaves three things it cannot see:
 *
 *   1. **A `.send(` on something that is already a transport.** The rule stops a feature importing SMSala.
 *      It does not stop a feature being HANDED a transport — which every route and worker job legitimately
 *      is, because the transport is constructed at the edge and passed into the choke point — and then
 *      calling `.send` on it. That call reaches the provider through a module the rule permits.
 *      `createGuardedTransport` in `outbox.ts` was exactly this shape, exported from the package barrel,
 *      and this rule is what found it: a `Transport` wrapper whose `send` applied the staging guard and
 *      nothing else, so a message through it had no template judgement, no identity resolution, no
 *      consent, no suppression, no frequency cap and no quiet hours.
 *   2. **An evaluator that answers a constant.** "Code, not configuration" does not fail because somebody
 *      adds a setting. It fails because somebody writes `hasConsent: () => true` in a runtime, which is
 *      what a toggle looks like once it exists, and which no type refuses because it satisfies the
 *      interface perfectly.
 *   3. **The ORDER inside the choke point.** `send.ts` must run the gate BEFORE the staging guard, or a
 *      promotional message with no consent is recorded as `diverted` on staging and `refused` in
 *      production — so the one environment where the compliance path runs daily is the one that never
 *      exercises it. That is a statement about two positions in one file.
 *
 * ## Why an allowlist of (file, receiver) pairs rather than a clever discriminator
 *
 * `boss.send('reminder', payload)` is pg-boss enqueueing a job and has nothing to do with messaging, so a
 * rule on the name `send` alone would condemn the job registry and be turned off within the week. The
 * discriminator is the ARGUMENT SHAPE: a message send is `send({ ... })` or `send(message)` — an object
 * literal or the message itself — while a job enqueue is `send(name, data, options)`, whose first argument
 * is an identifier or a string. That is what separates the two without either list knowing about the
 * other.
 *
 * What remains after the discriminator is small enough to declare, and declaring it is the point:
 * `PERMITTED_MESSAGE_SENDS` is four entries and each one carries the reason it is there. A new entry is a
 * diff somebody has to justify, which is the whole difference between a choke point and a convention.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stripNonCode } from './lib/strip-non-code.mjs'

const ROOTS = ['packages', 'apps', 'scripts']
const EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs'])
const SKIP_DIRECTORIES = new Set(['.claude', 'node_modules', 'dist', '.next', 'artifacts'])

/** The one module that runs the gate and the one module that reaches a transport. */
const CHOKE_POINT = 'packages/messaging/src/send.ts'

/**
 * Every place a MESSAGE may be handed to something, and the receiver expression it may be handed to.
 *
 * Keyed by file and then by receiver, because "this file may send" is too coarse: `send.ts` may call
 * `transport.send`, and if it acquired a second sender by another name that would be a second path inside
 * the choke point itself.
 */
const PERMITTED_MESSAGE_SENDS = new Map([
  [
    CHOKE_POINT,
    new Map([
      [
        'transport',
        'THE choke point. The only call in the repository that hands a message to a channel transport, ' +
          'and it happens after the template judgement, the identity resolution, the gate and the ' +
          'staging guard.',
      ],
    ]),
  ],
  [
    'packages/messaging/src/transports/smsala.ts',
    new Map([
      [
        'provider',
        'A transport handing the message to its provider PORT. This is the layer the ' +
          'messaging-providers-only-inside-a-transport rule exists to confine, and it is reached only ' +
          'from the choke point.',
      ],
    ]),
  ],
  [
    'packages/messaging/src/transports/resend.ts',
    new Map([['provider', 'The email transport, for the same reason as the SMS one.']]),
  ],
  [
    'packages/google/src/notify/reauth-ladder.ts',
    new Map([
      [
        'args.deps',
        'A declared PORT (`ReauthSender`), not a transport. The ladder decides which rung is due and ' +
          'asks an injected sender for a verdict; the implementation is ' +
          'apps/worker/src/jobs/google-reauth-notify.ts, which calls deliverMessage and therefore ' +
          'sendMessage. It is in this list rather than exempted by shape because a port named `send` is ' +
          'the one way a second path could be assembled out of parts that each look innocent, and the ' +
          'entry is where somebody has to say where it lands.',
      ],
    ]),
  ],
])

/**
 * Modules that may build a gate evaluator answering a constant, because they are not runtimes.
 *
 * Deliberately empty of shipped code, and it stays that way: the five runtimes that wire the gate today
 * all supply evaluators that THROW, because none of them has a recipient list to prefetch for, and a
 * throw is a refusal (`blocked_unevaluable`). A permissive constant is not a smaller version of that; it
 * is the opposite answer.
 */
const PERMITTED_CONSTANT_EVALUATORS = new Set([])

/**
 * The gate module whose structure makes the marketing kill switch unable to reach transactional traffic.
 *
 * C-AUTO-05. The acceptance line is *"structurally cannot touch transactional traffic"*, and the thing a type
 * cannot say is WHERE the switch is read. `evaluateGate` answers `allow` for a transactional message and then
 * delegates to `evaluatePromotionalGate`, whose `message` is a `PromotionalOutboundMessage`; the switch is
 * read inside that second function and nowhere else. Every one of those four facts is a position in this file,
 * and one of them slipping is how stopping marketing becomes stopping booking confirmations.
 */
const GATE_DECISION = 'packages/messaging/src/gate/decide.ts'

/**
 * The ONE module that may write `messaging_control`.
 *
 * The switch's state has one home (migration 0098) and one writer, because a second writer is a second
 * statement of the fact — and the symptom of a second statement is an admin console that says "stopped" over
 * a sender that is still sending. `toggleMessagingControl` also writes the `audit_event` carrying the actor,
 * the direction and the reason in the same transaction; a write from anywhere else is a toggle with no record
 * of who made it.
 */
const KILL_SWITCH_WRITER = 'packages/db/src/repositories/messaging-controls.ts'

/**
 * The runtimes that may hard-code `marketingKillSwitch: false`, and why each one may.
 *
 * Every entry sends TRANSACTIONAL traffic only — a booking confirmation, an OTP, an appointment reminder, a
 * compliance-obligation notice, a Google re-auth prompt — so the switch has nothing to decide for them, and
 * reading it would be worse than useless: `readMessagingControls` refuses a missing control row rather than
 * answering "disengaged", so an unreadable marketing control table would stop a booking confirmation. That is
 * the marketing-problem-becomes-operational-outage failure ADR 0016 exists to remove.
 *
 * The second half of the argument is what makes this list safe rather than merely convenient: all five wire
 * gate evaluators that THROW, because none has a recipient list to prefetch for, so a promotional message
 * that somehow reached one of them is refused `blocked_unevaluable` before the switch would have mattered.
 *
 * A NEW entry is a diff somebody has to justify, which is the whole point. A runtime that can send a
 * promotional message reads the switch from its one home — `apps/worker/src/automation/runtime.ts` is the
 * worked example.
 */
const PERMITTED_LITERAL_KILL_SWITCHES = new Map([
  [
    'apps/web/app/api/v1/book/route.ts',
    'The booking confirmation. Transactional, and the one message a marketing decision must never stop.',
  ],
  [
    'apps/web/app/api/v1/otp/route.ts',
    'The OTP. Transactional, and the message whose absence locks a customer out of their own booking.',
  ],
  [
    'apps/worker/src/jobs/send-scheduled-step.ts',
    'Appointment reminders (B-MSG-03). Transactional: every step it sends is about a booking that exists.',
  ],
  [
    'apps/worker/src/jobs/obligation-reminders.ts',
    'Compliance-obligation notices to staff. Transactional, and internal — no consent model applies.',
  ],
  [
    'apps/worker/src/jobs/google-reauth-notify.ts',
    'The Google re-auth ladder. Transactional, and the message that says an integration has stopped.',
  ],
  [
    'apps/worker/src/jobs/review-notice-sender.ts',
    'The fallback review notices (G-REV-02). Transactional, and internal: the recipient is the owner, the ' +
      'shipped resolver returns null for every caller, and the three consent evaluators beside the literal ' +
      'THROW — so a promotional send through this runtime fails closed rather than reading a false.',
  ],
  [
    'apps/worker/src/jobs/report-alerts.ts',
    'The pushed report alert (R-REP-08). Transactional, and internal for the review notices’ and the ' +
      'weekly report’s reason: the recipient is the owner, the shipped resolver returns null for every ' +
      'caller, and the three consent evaluators beside the literal THROW. Reading the marketing control ' +
      'row here would be worse than not reading it — an unreadable marketing table would stop the one ' +
      'message that says the salon’s figures cannot be trusted today, which is the failure this alert ' +
      'exists to make visible.',
  ],
  [
    'apps/worker/src/jobs/seo-weekly-report.ts',
    'The weekly website report (G-SEO-07). Transactional, and internal for the review notices’ reason: the ' +
      'recipient is the owner, the shipped resolver returns null for every caller, and the three consent ' +
      'evaluators beside the literal THROW. Reading the marketing control row here would be worse than ' +
      'not reading it — an unreadable marketing table would stop the one email that says the agent has ' +
      'gone quiet, which is the failure this report exists to make visible.',
  ],
])

/** Files that carry these patterns as DATA. Scanning either would make the gate report itself. */
const EXEMPT = new Set(['scripts/check-send-chokepoint.mjs', 'scripts/test-gates.mjs'])

/**
 * A test may drive a stub transport directly, and must be able to.
 *
 * `gate/fail-closed.test.ts` counts every call on a counting transport in order to assert the transport
 * was NEVER called, and a claim about zero calls is only worth making against something that counts every
 * one. A test also ships nowhere. The exemption cannot be used to smuggle shipped code past this: nothing
 * imports a test file, and vitest would run anything named like one.
 */
const isTest = (file) => /\.(test|itest)\.ts$/.test(file)

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) yield full
  }
}

const violations = []
const record = (rule, file, line, detail) =>
  violations.push({ rule, where: `${file}:${line}`, detail })

/**
 * A `.send(` whose first argument is an object literal or the message itself.
 *
 * The receiver group allows dots, brackets and calls so `args.deps`, `this.inner` and `transports[0]` are
 * all captured whole — a rule that only matched a bare identifier would be defeated by one property
 * access.
 */
const MESSAGE_SEND =
  /([A-Za-z_$][\w$]*(?:\s*(?:\.\s*[\w$]+|\[[^\]]*\]|\([^()]*\)))*)\s*\.\s*send\s*\(\s*(\{|message\b|msg\b|outbound\b)/g

/** An evaluator whose body is a literal `true` or `false`, with or without parentheses on the parameter. */
const CONSTANT_EVALUATOR =
  /\b(hasConsent|isSuppressed|frequencyCapReached)\s*:\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(true|false)\b/g

/** A `marketingKillSwitch:` written as a literal rather than resolved from the control row. */
const LITERAL_KILL_SWITCH = /\bmarketingKillSwitch\s*:\s*(true|false)\b/g

/**
 * A write to the control table, however it is spelled across a line break.
 *
 * Matched against a DIFFERENT stripping of the file from every other rule here, and the first version of this
 * rule could not fire at all because it was not. SQL in this repository lives inside template literals, and
 * `blankStrings: true` replaces string CONTENTS with `x` — so `sql\`update messaging_control …\`` is
 * `sql\`xxxxxxxx…\`` by the time the other rules read it, and a rule looking for the statement matched nothing
 * in the whole tree while reporting a clean scan. ADR 0002's failure exactly, in the check written to prevent
 * a different one.
 *
 * So this rule reads the file with comments blanked and strings KEPT, and the counter below is what would
 * catch it happening again: the one permitted writer has to be seen writing.
 */
const CONTROL_TABLE_WRITE = /\b(insert\s+into|update)\s+messaging_control\b/gi

let scanned = 0
let permittedSendsSeen = 0
let permittedLiteralKillSwitchesSeen = 0
let controlWritesInTheWriterSeen = 0

for (const root of ROOTS) {
  try {
    statSync(root)
  } catch {
    continue
  }
  for (const file of walk(root)) {
    if (EXEMPT.has(file)) continue
    scanned += 1
    const source = readFileSync(file, 'utf8')
    const code = stripNonCode(source, { blankStrings: true })
    /** Comments blanked, strings KEPT. The only rule that needs this is 4 — see CONTROL_TABLE_WRITE. */
    const codeWithStrings = stripNonCode(source)
    const lineOf = (index) => code.slice(0, index).split('\n').length

    // 1. A second send path. See the header for what the import rule cannot see.
    const permitted = PERMITTED_MESSAGE_SENDS.get(file)
    for (const match of code.matchAll(MESSAGE_SEND)) {
      const receiver = (match[1] ?? '').replace(/\s+/g, '')
      if (permitted?.has(receiver) === true) {
        permittedSendsSeen += 1
        continue
      }
      if (isTest(file)) continue
      record(
        'message-send-outside-the-choke-point',
        file,
        lineOf(match.index),
        `${receiver}.send(...) hands a message to something other than through sendMessage(). Every ` +
          'outbound message goes through packages/messaging/src/send.ts, which is where the template ' +
          'judgement, the sender-identity class rule, the promotional gate and the staging send guard ' +
          'are. A send from here has none of them: it can leave from the wrong registered identity, with ' +
          'no consent record, to a suppressed contact, past the frequency cap, inside quiet hours, and — ' +
          'outside production — to a real customer. If it is a legitimate port rather than a transport, ' +
          'add it to PERMITTED_MESSAGE_SENDS with where it lands.',
      )
    }

    // 2. A gate evaluator that answers a constant, which is what "configuration" actually looks like.
    if (!isTest(file) && !PERMITTED_CONSTANT_EVALUATORS.has(file)) {
      for (const match of code.matchAll(CONSTANT_EVALUATOR)) {
        record(
          'gate-evaluator-answers-a-constant',
          file,
          lineOf(match.index),
          `${match[1]}: () => ${match[2]} is a compliance check with the answer written in. Consent, ` +
            'suppression and the frequency cap are stored state, and an evaluator that cannot read it ' +
            'must THROW so evaluateGate records blocked_unevaluable and the send stops — which is what ' +
            'every runtime in this build does. A constant is not a smaller version of that: `true` for ' +
            'hasConsent sends promotional SMS to people who never opted in, and `false` for isSuppressed ' +
            'sends it to people who opted out. Build the evaluator over a prefetch with ' +
            'promotionalGateEvaluators().',
        )
      }
    }

    // 3. The gate is evaluated in the choke point and nowhere else. A second caller is a second policy
    //    decision, even when it happens to reach the same answer today.
    if (file !== CHOKE_POINT && !isTest(file)) {
      // The lookbehind excludes the DECLARATION — `export function evaluateGate(` in
      // packages/messaging/src/gate/index.ts — while leaving the rule live inside that module, so a gate
      // that grew a second internal caller would still be caught. Exempting the whole file by path would
      // have given that away, and the first run of this scanner reported the declaration as a violation,
      // which is how the distinction got written down.
      for (const match of code.matchAll(/(?<!\bfunction\s+)\bevaluateGate\s*\(/g)) {
        record(
          'promotional-gate-evaluated-outside-the-choke-point',
          file,
          lineOf(match.index),
          'evaluateGate() is called by sendMessage() and by nothing else. A second caller decides ' +
            'separately what to do with a refusal, a hold and an unevaluable input, and the day the two ' +
            'disagree is the day a refusal is recorded as a divert. Call sendMessage().',
        )
      }
    }

    // 4. The kill switch's state has ONE home and ONE writer. See KILL_SWITCH_WRITER.
    if (file === KILL_SWITCH_WRITER) {
      controlWritesInTheWriterSeen += [...codeWithStrings.matchAll(CONTROL_TABLE_WRITE)].length
    } else if (!isTest(file)) {
      for (const match of codeWithStrings.matchAll(CONTROL_TABLE_WRITE)) {
        record(
          'marketing-kill-switch-state-has-one-home',
          file,
          lineOf(match.index),
          'this writes messaging_control, and toggleMessagingControl() in ' +
            `${KILL_SWITCH_WRITER} is the only thing that may. That function writes the audit_event ` +
            'carrying the actor, the direction and the reason in the SAME transaction, so a write from ' +
            'anywhere else is a marketing kill switch moved with no record of who moved it or why — and ' +
            "a second writer is a second statement of the switch's state, whose symptom is a console " +
            'that says "stopped" over a sender that is still sending.',
        )
      }
    }

    // 5. A hard-coded switch value, outside the transactional-only runtimes that declare why.
    if (!isTest(file)) {
      const reason = PERMITTED_LITERAL_KILL_SWITCHES.get(file)
      for (const match of code.matchAll(LITERAL_KILL_SWITCH)) {
        if (reason !== undefined) {
          permittedLiteralKillSwitchesSeen += 1
          continue
        }
        record(
          'marketing-kill-switch-state-has-one-home',
          file,
          lineOf(match.index),
          `marketingKillSwitch: ${match[1]} is the switch with the answer written in, which is exactly ` +
            'what C-AUTO-07 called "a false that looks like a read is the switch nobody notices is not ' +
            'wired". Resolve it from its one home instead — readMessagingControls() in @berelax/db, ' +
            'through resolveMarketingKillSwitch(), which also applies the non-production default. If this ' +
            'runtime genuinely sends transactional traffic only, add it to ' +
            'PERMITTED_LITERAL_KILL_SWITCHES with the reason, because reading the control row on a ' +
            'transactional path is worse than not reading it: an unreadable marketing table would stop a ' +
            'booking confirmation.',
        )
      }
    }
  }
}

/**
 * The order inside the choke point, which is a statement about positions in one file.
 *
 * Read from the file rather than asserted in a test, because the acceptance line is structural: "the
 * compliance gate is proven to run before the staging send guard". A behavioural test proves it for the
 * cases it drives; this proves it for every case, including the one nobody wrote a test for.
 */
{
  const code = stripNonCode(readFileSync(CHOKE_POINT, 'utf8'), { blankStrings: true })
  const at = (needle) => code.indexOf(needle)
  const gate = at('evaluateGate(')
  const guard = at('guardOutbound(')
  const transport = at('transport.send(')
  const identity = at('resolveSenderIdentity(')
  const judge = at('judgeVariant(')

  const missing = [
    ['evaluateGate(', gate],
    ['guardOutbound(', guard],
    ['transport.send(', transport],
    ['resolveSenderIdentity(', identity],
    ['judgeVariant(', judge],
  ].filter(([, index]) => index === -1)

  if (missing.length > 0) {
    record(
      'choke-point-runs-the-gate-before-the-staging-guard',
      CHOKE_POINT,
      1,
      `the choke point no longer calls ${missing.map(([name]) => name).join(', ')}. Each of the five is ` +
        'a step every outbound message takes, and one that is gone is not a refactor — it is a step no ' +
        'message takes any more.',
    )
  } else if (!(judge < identity && identity < gate && gate < guard && guard < transport)) {
    record(
      'choke-point-runs-the-gate-before-the-staging-guard',
      CHOKE_POINT,
      lineOf(code, Math.min(gate, guard)),
      'the five steps are out of order. The required order is judgeVariant -> resolveSenderIdentity -> ' +
        'evaluateGate -> guardOutbound -> transport.send. The gate BEFORE the guard is the one that ' +
        'costs something if it slips: the guard diverts everything outside production, so a promotional ' +
        'message with no consent record would be recorded as `diverted` on staging and `refused` in ' +
        'production — and the one environment where the compliance path is exercised daily would be the ' +
        'one environment that never exercises it. Found at ' +
        `judgeVariant=${judge}, resolveSenderIdentity=${identity}, evaluateGate=${gate}, ` +
        `guardOutbound=${guard}, transport.send=${transport}.`,
    )
  }
}

/**
 * Where the kill switch is read, which is a statement about four positions in one file.
 *
 * Read from `decide.ts` rather than asserted in a test for the reason the order check above is: a behavioural
 * test proves it for the cases it drives. The mutation that matters here leaves a system that WORKS — move the
 * kill-switch check above the transactional return and every promotional send is still refused, every existing
 * suite is still green, and booking confirmations, reminders and OTPs stop the next time somebody engages it.
 */
{
  const source = readFileSync(GATE_DECISION, 'utf8')
  // POSITIONS come from the stripped text, so a needle cannot match inside a comment. The transactional
  // return is additionally matched WHOLE against the raw source, because `blankStrings` turns
  // `'transactional'` into `'xxxxxxxxxxxxx'` — so a stripped-text search for the whole line finds nothing,
  // and a search for the part before the string cannot tell which class the branch answers for. The first
  // version of this rule searched the stripped text for the whole line and reported it as missing.
  const code = stripNonCode(source, { blankStrings: true })
  const at = (needle) => code.indexOf(needle)

  const promotionalEntry = at('export function evaluatePromotionalGate(')
  const promotionalParameter = at('message: PromotionalOutboundMessage,')
  const transactionalReturn = source.includes(
    "if (message.messageClass === 'transactional') return ALLOW",
  )
    ? at('if (message.messageClass ===')
    : -1
  const delegation = at('return evaluatePromotionalGate(ctx, promotional,')
  const reads = [...code.matchAll(/\bctx\s*\.\s*marketingKillSwitch\b/g)]

  const absent = [
    ['export function evaluatePromotionalGate(', promotionalEntry],
    ['message: PromotionalOutboundMessage,', promotionalParameter],
    ["if (message.messageClass === 'transactional') return ALLOW", transactionalReturn],
    ['return evaluatePromotionalGate(ctx, promotional,', delegation],
  ].filter(([, index]) => index === -1)

  if (absent.length > 0) {
    record(
      'kill-switch-cannot-reach-transactional-traffic',
      GATE_DECISION,
      1,
      `the gate no longer contains ${absent.map(([name]) => name).join(', ')}. Each one is part of what ` +
        'makes the marketing kill switch unable to reach a booking confirmation: the promotional-only ' +
        'parameter type, the transactional answer that comes first, and the delegation between them. One ' +
        'that is gone is not a refactor.',
    )
  } else if (reads.length !== 1) {
    record(
      'kill-switch-cannot-reach-transactional-traffic',
      GATE_DECISION,
      reads.length > 0 ? lineOf(code, reads[0].index) : 1,
      `ctx.marketingKillSwitch is read ${reads.length} time(s) in this file and must be read exactly ONCE. ` +
        'Zero means the switch is no longer consulted at all, so an engaged switch stops nothing. More than ' +
        'one means there is a second place the answer is decided, and the second place is the one that ' +
        'eventually runs before the transactional return.',
    )
  } else if (!(transactionalReturn < delegation && promotionalEntry < reads[0].index)) {
    record(
      'kill-switch-cannot-reach-transactional-traffic',
      GATE_DECISION,
      lineOf(code, Math.min(transactionalReturn, reads[0].index)),
      'the kill switch is read outside evaluatePromotionalGate, or the transactional answer no longer ' +
        'comes before the delegation. The required shape is: evaluateGate returns ALLOW for a ' +
        'transactional message, then delegates; evaluatePromotionalGate — whose message parameter is ' +
        'PromotionalOutboundMessage, so a transactional message is not assignable to it — reads the ' +
        'switch. A read above the transactional return stops every booking confirmation, reminder and OTP ' +
        'in the system the next time marketing is stopped, and no existing test would notice. Found at ' +
        `transactionalReturn=${transactionalReturn}, delegation=${delegation}, ` +
        `evaluatePromotionalGate=${promotionalEntry}, killSwitchRead=${reads[0].index}.`,
    )
  }
}

function lineOf(code, index) {
  return code.slice(0, index).split('\n').length
}

/**
 * The control, and it comes before the verdict.
 *
 * Every assertion above is "nothing matched outside the allowlist", and nothing matches outside the
 * allowlist when nothing matches at all. ADR 0002's green tick on zero modules, and ADR 0003's rule that
 * a check nobody has seen fail may not be a check: if the discriminator stops matching — a rename, a
 * formatting change that puts the `{` on the next line in a way the regex misses — this file reports
 * success about a repository it did not read. So the permitted sends are COUNTED, and a count below the
 * number declared is a failure of the scanner rather than a pass for the tree.
 */
const declaredSends = [...PERMITTED_MESSAGE_SENDS.values()].reduce((n, m) => n + m.size, 0)
const declaredLiteralKillSwitches = PERMITTED_LITERAL_KILL_SWITCHES.size
if (
  scanned < 100 ||
  permittedSendsSeen < declaredSends ||
  permittedLiteralKillSwitchesSeen < declaredLiteralKillSwitches ||
  controlWritesInTheWriterSeen < 1
) {
  console.error(
    `Send choke-point scanner did not read what it thinks it read: ${scanned} file(s) scanned, ` +
      `${permittedSendsSeen} of ${declaredSends} declared message sends found, ` +
      `${permittedLiteralKillSwitchesSeen} of ${declaredLiteralKillSwitches} declared literal kill ` +
      `switches found, and ${controlWritesInTheWriterSeen} write(s) to messaging_control seen in ` +
      `${KILL_SWITCH_WRITER}, which must be at least one. Every rule here is a difference against an ` +
      'allowlist, and a difference against nothing is empty — so this is reported as a failure rather ' +
      'than as a clean tree. Check the MESSAGE_SEND, LITERAL_KILL_SWITCH and CONTROL_TABLE_WRITE ' +
      `discriminators against ${CHOKE_POINT}, ` +
      `${[...PERMITTED_LITERAL_KILL_SWITCHES.keys()][0]} and ${KILL_SWITCH_WRITER}.`,
  )
  process.exit(1)
}

if (violations.length > 0) {
  console.error('Send choke-point violations:\n')
  for (const violation of violations) {
    console.error(`  ${violation.rule}`)
    console.error(`    ${violation.where}  ${violation.detail}`)
  }
  console.error(
    `\n${violations.length} violation(s). One promotional SMS outside the permitted hours, to a ` +
      'suppressed contact or from the transactional identity risks sender-ID SUSPENSION (docs/04 §5) — ' +
      'which stops every booking confirmation, reminder and OTP with it.',
  )
  process.exit(1)
}

console.log(
  `Every outbound message goes through the choke point: ${scanned} files scanned across ` +
    `${ROOTS.join(', ')}, ${declaredSends} declared message send(s) all accounted for, ` +
    `${CHOKE_POINT} runs the gate before the staging guard, and the marketing kill switch is read once, ` +
    `inside ${GATE_DECISION}'s promotional-only path, from its one home — written in ` +
    `${KILL_SWITCH_WRITER} and nowhere else (${controlWritesInTheWriterSeen} write(s) seen there, ` +
    `${declaredLiteralKillSwitches} transactional-only runtime(s) declaring a literal).`,
)
