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

let scanned = 0
let permittedSendsSeen = 0

for (const root of ROOTS) {
  try {
    statSync(root)
  } catch {
    continue
  }
  for (const file of walk(root)) {
    if (EXEMPT.has(file)) continue
    scanned += 1
    const code = stripNonCode(readFileSync(file, 'utf8'), { blankStrings: true })
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
if (scanned < 100 || permittedSendsSeen < declaredSends) {
  console.error(
    `Send choke-point scanner did not read what it thinks it read: ${scanned} file(s) scanned and ` +
      `${permittedSendsSeen} of ${declaredSends} declared message sends found. Every rule here is a ` +
      'difference against an allowlist, and a difference against nothing is empty — so this is reported ' +
      'as a failure rather than as a clean tree. Check the MESSAGE_SEND discriminator against ' +
      `${CHOKE_POINT}.`,
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
    `${ROOTS.join(', ')}, ${declaredSends} declared message send(s) all accounted for, and ` +
    `${CHOKE_POINT} runs the gate before the staging guard.`,
)
