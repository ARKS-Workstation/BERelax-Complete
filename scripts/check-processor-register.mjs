#!/usr/bin/env node
/**
 * The processor register and the environment inventory are checked against the config schema, or they
 * are documents.
 *
 * docs/04 §8 asks for a processor register and says what kind: *"This register drives the privacy policy
 * and the deletion logic — it is a working artefact, not a formality."* The difference between the two is
 * entirely whether something fails when they disagree. A register written once is right once; the
 * eleventh provider key is added, nothing fails, and the privacy policy names eight services while the
 * build talks to nine. That is the same defect `pnpm jobs` removes for crons and `pnpm alerts` removes
 * for alerts, one more floor up.
 *
 * So this gate fails in eight directions, each named, each with a known-bad fixture in gate block 177:
 *
 *  1. `provider-key-without-a-processor-row` — `packages/config/src/env.ts` declares a provider-mode key
 *     that `PROCESSOR_REGISTER` has no row for. This is the acceptance line, verbatim.
 *  2. `processor-row-without-a-config-key` — a row naming an `env.ts` key the schema does not declare.
 *     The other direction, and it is the one that lets the register SHRINK: a row describing a service
 *     nothing can reach is permission to believe the build still uses it.
 *  3. `processor-row-incomplete` — a row missing purpose, data classes, transfer basis or retention. The
 *     four things acceptance line 2 names, each from a closed vocabulary except retention, which is a
 *     sentence and is checked for being one.
 *  4. `processor-claims-an-unsigned-agreement` — `agreementOnFile: true`. No data processing agreement
 *     has been seen by this build, and a claimed legal instrument is worse than a blank one (brief rule
 *     15). The register's own module-load guard refuses it too; this is the backstop.
 *  5. `privacy-policy-not-generated` — a processor the generated policy section does not mention, or a
 *     name in the policy that no row declares. The policy is produced by
 *     `packages/core/src/privacy/processor-policy.ts` from the register and from nothing else; this is
 *     what proves it still is.
 *  6. `secret-inventory-missing-a-schema-key` — a REQUIRED key in the config schema that
 *     `build/secret-inventory.json` neither classifies as a secret nor lists as explicitly not one.
 *     `pnpm rotation` already holds the inventory against secret-shaped names the CODE READS; this holds
 *     it against the SCHEMA, which is the half nothing covered — a key declared in `env.ts` and read
 *     through `loadConfig()` is read by no `process.env.FOO` a scan can see.
 *  7. `secret-inventory-entry-off-schema` — an inventory entry naming an environment variable `env.ts`
 *     does not declare. Same direction-3 argument.
 *  8. `secret-inventory-entry-incomplete` — an entry with no owner or no rotation interval. Acceptance
 *     line 4 names both.
 *
 * ## What this deliberately does not do
 *
 * It reads no value from any environment, ever — only names, out of source files. A gate that loaded the
 * real environment to check a key's shape would be a gate that could print a secret, which is
 * `check-secret-rotation.mjs`'s rule and it applies unchanged here.
 *
 * It does not check that an agreement exists, or that a transfer basis is lawful. Neither is a fact this
 * repository holds. What it checks is that the register says which, and says it in a vocabulary a reader
 * can aggregate.
 *
 * Usage: `node scripts/check-processor-register.mjs`
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { processorPolicyText } from '../packages/core/src/privacy/processor-policy.ts'
import {
  PROCESSOR_DATA_CLASSES,
  PROCESSOR_PURPOSES,
  PROCESSOR_REGISTER,
  TRANSFER_BASES,
} from '../packages/shared/src/processor-register.ts'

const ROOT = join(import.meta.dirname, '..')
const ENV_SCHEMA = 'packages/config/src/env.ts'
const REGISTER = 'packages/shared/src/processor-register.ts'
const INVENTORY = 'build/secret-inventory.json'
const POLICY = 'packages/core/src/privacy/processor-policy.ts'

const problems = []
const fail = (rule, where, detail) => problems.push(`${where}  [${rule}] ${detail}`)

const read = (path) => {
  try {
    return readFileSync(join(ROOT, path), 'utf8')
  } catch {
    return null
  }
}

/**
 * Comments blanked, string contents kept.
 *
 * The prose in `env.ts` names provider keys — it has a paragraph explaining why `MEDIA_STORAGE` is in
 * the refused-outside-production list — and a scan that read those sentences as declarations would find
 * keys that do not exist. The colour gate's first run flagged the Tailwind class names in the sentence
 * explaining why Tailwind class names are forbidden, and this is the same trap.
 */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
}

const envSource = read(ENV_SCHEMA)
if (envSource === null) {
  console.error(`${ENV_SCHEMA} could not be read. The config schema is what this gate compares to.`)
  process.exit(1)
}
const envCode = codeOnly(envSource)

/**
 * Every key the config schema declares, and the ones that are PROVIDER MODE switches.
 *
 * The provider set is derived from the declaration's TYPE and not from the key's name. `providerMode` is
 * the one zod enum in that file that means "an external service, fake or real", so every external
 * provider is exactly a field declared with it — which makes a new provider detectable by structure
 * rather than by somebody remembering to name it `*_PROVIDER`. A name-suffix scan would have missed
 * `MEDIA_STORAGE`, which is in the set, and would have invented a provider out of `LLM_PROVIDER_SETTING`
 * had one existed.
 */
const schemaKeys = new Set()
const providerKeys = new Set()
for (const match of envCode.matchAll(/^\s{4}([A-Z][A-Z0-9_]*):\s*([^\n]*)$/gm)) {
  const key = match[1]
  if (key === undefined) continue
  schemaKeys.add(key)
  if (/\bproviderMode\b/.test(match[2] ?? '')) providerKeys.add(key)
}

/*
  The floor (ADR 0002), and this gate needs one more than most because every rule below is a set
  comparison: an `env.ts` whose shape the pattern no longer matches yields an empty `schemaKeys`, and
  "every register row names a declared key" over an empty set of declared keys is false for every row
  rather than silently true — but `provider-key-without-a-processor-row` over an empty provider set is
  silently SATISFIED, which is the direction that matters. So both sets have floors.
*/
if (schemaKeys.size < 20 || providerKeys.size < 4 || PROCESSOR_REGISTER.length < 4) {
  console.error(
    `Processor register gate read ${schemaKeys.size} schema key(s), ${providerKeys.size} provider ` +
      `key(s) and ${PROCESSOR_REGISTER.length} processor row(s), which is too little to mean ` +
      'anything. The declaration pattern or the import is wrong, so every answer below would be about ' +
      'nothing.',
  )
  process.exit(1)
}

// --- rules 1 to 4: the register against the schema, and each row's own completeness ----------------

const rowByProviderKey = new Map()
for (const processor of PROCESSOR_REGISTER) {
  if (processor.providerKey !== null) rowByProviderKey.set(processor.providerKey, processor)
}

for (const key of providerKeys) {
  if (rowByProviderKey.has(key)) continue
  fail(
    'provider-key-without-a-processor-row',
    `${ENV_SCHEMA} ${key}`,
    'the config schema can switch this external service on and PROCESSOR_REGISTER has no row for it. ' +
      'The privacy policy is generated from those rows, so this is a service the build talks to and ' +
      'the policy does not mention — which is the formality docs/04 §8 says this register must not be',
  )
}

for (const processor of PROCESSOR_REGISTER) {
  const where = `${REGISTER} ${processor.id}`
  const keys = [
    ...(processor.providerKey === null ? [] : [processor.providerKey]),
    ...processor.configKeys,
  ]
  for (const key of keys) {
    if (schemaKeys.has(key)) continue
    fail(
      'processor-row-without-a-config-key',
      where,
      `names "${key}", which ${ENV_SCHEMA} does not declare. A row describing a service nothing in ` +
        'this build can reach is permission to believe it is still in use',
    )
  }
  if (processor.providerKey !== null && !providerKeys.has(processor.providerKey)) {
    fail(
      'processor-row-without-a-config-key',
      where,
      `declares providerKey "${processor.providerKey}", which is not a providerMode field in ` +
        `${ENV_SCHEMA}. A switch that is not a provider switch is a different kind of setting`,
    )
  }

  if (!PROCESSOR_PURPOSES.includes(processor.purpose)) {
    fail('processor-row-incomplete', where, `purpose "${processor.purpose}" is outside the set`)
  }
  if (!TRANSFER_BASES.includes(processor.transferBasis)) {
    fail(
      'processor-row-incomplete',
      where,
      `transferBasis "${processor.transferBasis}" is outside the set`,
    )
  }
  if (processor.dataClasses.length === 0) {
    fail('processor-row-incomplete', where, 'declares no data class')
  }
  for (const dataClass of processor.dataClasses) {
    if (PROCESSOR_DATA_CLASSES.includes(dataClass)) continue
    fail('processor-row-incomplete', where, `data class "${dataClass}" is outside the set`)
  }
  // Retention is prose, so the only checkable claim is that it IS prose — a sentence somebody could
  // disagree with rather than a word. The substance is reviewed; a blank is not.
  if (typeof processor.retention !== 'string' || processor.retention.trim().length < 40) {
    fail(
      'processor-row-incomplete',
      where,
      'retention must be a sentence saying whether the period is one THIS BUILD controls or one the ' +
        'provider controls. A word is not an answer to how long somebody keeps your phone number',
    )
  }
  if (typeof processor.why !== 'string' || processor.why.trim().length < 40) {
    fail('processor-row-incomplete', where, 'why must be a sentence a reviewer could disagree with')
  }
  if (processor.agreementOnFile) {
    fail(
      'processor-claims-an-unsigned-agreement',
      where,
      'claims a data processing agreement is on file. None has been seen by this build, and a claimed ' +
        'legal instrument is worse than a blank one (brief rule 15)',
    )
  }
}

// --- rule 5: the privacy policy is GENERATED from the register -------------------------------------
{
  const policySource = read(POLICY)
  const generated = processorPolicyText()
  if (policySource === null) {
    fail('privacy-policy-not-generated', POLICY, 'the generator could not be read')
  }
  for (const processor of PROCESSOR_REGISTER) {
    if (generated.includes(processor.vendor)) continue
    fail(
      'privacy-policy-not-generated',
      `${POLICY} ${processor.id}`,
      `the generated policy does not mention "${processor.vendor}". The policy is produced from the ` +
        'register and from nothing else, so a row the policy omits is a disclosure that is not made',
    )
  }
  // And the other direction, over the generator's SOURCE: a vendor name written into the generator is a
  // processor in the policy that no row declares, which is how a policy comes to describe a service
  // the register has already removed.
  for (const processor of PROCESSOR_REGISTER) {
    if (!(policySource ?? '').includes(processor.vendor)) continue
    fail(
      'privacy-policy-not-generated',
      `${POLICY} ${processor.id}`,
      `names "${processor.vendor}" in its own source. Every processor name in the policy must come ` +
        'from the register at run time; one written here is a second statement of who has the data',
    )
  }
}

/**
 * Every environment variable name something in the tree reads straight off `process.env`.
 *
 * Needed because `env.ts` is not the only legitimate reader: the CMS owns its own bootstrap (ADR 0019)
 * and reads `PAYLOAD_SECRET` directly, and a gate that refused that would be deciding Payload's
 * configuration rather than checking documentation. Names only, never values — a gate that loaded the
 * environment to inspect a secret would be a gate that could print one.
 */
const readDirectly = new Set()
for (const root of ['apps', 'packages', 'scripts']) {
  const listing = (() => {
    try {
      return execFileSync(
        'grep',
        ['-rhoE', String.raw`process\.env\[?['"]?[A-Z][A-Z0-9_]*`, root],
        {
          cwd: ROOT,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        },
      )
    } catch {
      // grep exits 1 when nothing matched, which is a legitimate answer for a directory and not a
      // failure. An unreadable directory is covered by the floors above.
      return ''
    }
  })()
  for (const match of listing.matchAll(/([A-Z][A-Z0-9_]*)$/gm)) {
    if (match[1] !== undefined) readDirectly.add(match[1])
  }
}

// --- rules 6 to 8: the secret inventory against the config schema ----------------------------------
{
  const raw = read(INVENTORY)
  if (raw === null) {
    fail('secret-inventory-missing-a-schema-key', INVENTORY, 'the inventory could not be read')
  } else {
    const inventory = JSON.parse(raw)
    const entries = Array.isArray(inventory.entries) ? inventory.entries : []
    const notSecrets = Array.isArray(inventory.notSecrets) ? inventory.notSecrets : []
    if (entries.length < 5) {
      fail(
        'secret-inventory-entry-incomplete',
        INVENTORY,
        `only ${entries.length} entries parsed, which is too few to compare anything against`,
      )
    }

    /** Every environment variable the inventory accounts for, however it accounts for it. */
    const accounted = new Set()
    for (const entry of entries) {
      for (const field of ['env', 'versionEnv', 'retiredEnv', 'retiredVersionEnv']) {
        if (typeof entry[field] === 'string') accounted.add(entry[field])
      }
    }
    for (const entry of notSecrets) {
      if (typeof entry.name === 'string') accounted.add(entry.name)
    }

    /*
      The keys that need accounting for: the ones that carry a credential, and the ones a deployment
      MUST set.

      The first version of this set also included every provider-mode switch, and that was wrong in a
      way worth recording because the gate found it immediately. `SMS_PROVIDER=real` carries no
      credential — it is a two-valued switch with a safe default — so demanding a rotation interval and
      an owner for it is demanding a procedure for rotating the word "fake". Six entries would have been
      written to satisfy a rule, which is how an inventory becomes something nobody reads.

      So: secret-shaped by NAME, or required by SHAPE. Required means the declaration carries neither
      `.default(` nor `.optional()` — a key a deployment cannot omit — which is acceptance line 4's own
      words ("every required variable from the config schema"). Both halves are derived from the file
      rather than listed, because a list would be the reservation list ADR 0043 rejected: a claim about
      what the schema WILL hold that nothing compares to what it does hold.
    */
    const SECRET_SHAPED = /(SECRET|TOKEN|KEK|PEPPER|PASSWORD|CREDENTIAL|DSN|KEY)$/
    const required = new Set()
    for (const match of envCode.matchAll(
      /^\s{4}([A-Z][A-Z0-9_]*):\s*([\s\S]*?)(?=\n\s{4}[A-Z][A-Z0-9_]*:|\n\s{2}\})/gm,
    )) {
      const key = match[1]
      const declaration = match[2] ?? ''
      if (key === undefined) continue
      if (/\.default\(|\.optional\(/.test(declaration)) continue
      required.add(key)
    }
    const needsAccounting = new Set(
      [...schemaKeys].filter((key) => SECRET_SHAPED.test(key) || required.has(key)),
    )
    // The floor on this half too: a declaration pattern that stopped matching would make `required`
    // empty, and then this rule would be satisfied by whatever happened to be secret-shaped.
    if (required.size === 0) {
      fail(
        'secret-inventory-missing-a-schema-key',
        ENV_SCHEMA,
        'no key in the schema parsed as required, which cannot be true — APP_ENV and DATABASE_URL both ' +
          'are. The declaration pattern is wrong, so this rule would be about nothing',
      )
    }
    for (const key of needsAccounting) {
      if (accounted.has(key)) continue
      fail(
        'secret-inventory-missing-a-schema-key',
        `${INVENTORY} ${key}`,
        `${ENV_SCHEMA} declares this and the inventory neither classifies it nor lists it as ` +
          'explicitly not a secret. `pnpm rotation` holds the inventory against names the CODE READS, ' +
          'which cannot see a key reached only through loadConfig() — this is that half',
      )
    }

    for (const entry of entries) {
      const where = `${INVENTORY} ${entry.id ?? '(no id)'}`
      for (const field of ['env', 'versionEnv', 'retiredEnv', 'retiredVersionEnv']) {
        const name = entry[field]
        if (typeof name !== 'string') continue
        // Declared in the schema, OR read directly somewhere. The second clause is not a loophole, it
        // is the correction the gate's first run earned: `PAYLOAD_SECRET` is in the inventory with a
        // rotation procedure and is NOT in `env.ts`, because the CMS owns its own configuration
        // (ADR 0019) and reads it from `process.env` in `apps/web/payload.config.ts`. The rule's claim
        // is that an entry describes a variable something reads — and that one does. Demanding that
        // every secret pass through `loadConfig()` would have been this gate deciding Payload's
        // bootstrap, which is a different argument and not one a documentation check gets to make.
        if (schemaKeys.has(name) || readDirectly.has(name)) continue
        fail(
          'secret-inventory-entry-off-schema',
          where,
          `${field} names "${name}", which ${ENV_SCHEMA} does not declare and which nothing in the ` +
            'tree reads from process.env either. An inventory entry for a variable nothing reads is a ' +
            'rotation procedure for a key that does not exist',
        )
      }
      // Acceptance line 4 names both, and neither is derivable from anything else: who is responsible
      // and how often. An entry with a rotation procedure and no owner is a procedure with no subject.
      if (typeof entry.owner !== 'string' || entry.owner.trim().length < 10) {
        fail(
          'secret-inventory-entry-incomplete',
          where,
          'has no owner. A rotation procedure nobody owns is one that happens when somebody notices',
        )
      }
      if (!Number.isInteger(entry.rotatePeriodDays) || entry.rotatePeriodDays < 1) {
        fail('secret-inventory-entry-incomplete', where, 'has no rotation interval in whole days')
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`Processor register and environment inventory:\n`)
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(
    `\n${problems.length} problem(s). A register nothing compares to the services actually wired up is ` +
      'right on the day it is written and wrong a week later.',
  )
  process.exit(1)
}

console.log(
  `${PROCESSOR_REGISTER.length} processors cover all ${providerKeys.size} provider keys in ` +
    `${ENV_SCHEMA}; every row states purpose, data classes, transfer basis and retention, none claims ` +
    'an agreement on file, the privacy policy is generated from them, and the secret inventory accounts ' +
    `for every credential-carrying key the schema declares across ${schemaKeys.size} key(s).`,
)
