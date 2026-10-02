import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS } from '@berelax/config'
import { CONSENT_GATED_TARGET_IDS, consentGatedTarget } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { codeOnly } from './ltv-arch.ts'

/**
 * A-MEAS-02's fifth acceptance line, as a test: *"arch test enumerating the settings registry asserts no
 * setting key, feature flag or env var can disable the gate — it is code, not configuration"*.
 *
 * ## Why this is in `packages/fixtures`
 *
 * It needs three things no other package may hold together: `SETTINGS` from `@berelax/config`,
 * `CONSENT_GATED_TARGETS` from `@berelax/core` — which may not import config at all, being pure (ADR
 * 0001) — and the SOURCE of the modules that implement the gate, including one in `packages/db`, which
 * may never import core. `packages/fixtures` depends on all three, which is brief rule 4's own reason for
 * it existing.
 *
 * ## What it actually measures, and why a source scan is the only instrument that can
 *
 * "No setting can disable the gate" is an ABSENCE. An assertion about behaviour cannot see it: the gate
 * would behave identically on the day somebody adds `if (setting('analytics.consent_required') === false)
 * return permitted`, for every input the suite happens to pass. What makes the claim checkable is
 * enumerating every configuration name this build HAS — 50-odd setting keys and 30-odd environment
 * variables, read from their own definitions rather than listed here — and asserting that not one of them
 * appears anywhere in the gate's estate.
 *
 * Enumerating at RUNTIME and not by grepping the registry file is deliberate: a key composed from a
 * constant (`FRONT_DESK_MIN_LEAD_SETTING_KEY` and the twenty others like it) is invisible to a scan of
 * the registry's text and present in `SETTINGS`.
 *
 * ## The one allowance, and the control on it
 *
 * `DATABASE_URL` is allowed, in the route's wiring module only. It says WHERE the records live and
 * nothing about whether consent is required; refusing it would mean the endpoint could not open a
 * connection. The allowance is asserted to have been USED — an allowance that excuses nothing is a hole
 * waiting for the next thing written there, which is the control `CODE_LITERAL_ALLOWED` in
 * `scripts/check-egress-guard.mjs` carries for the same reason — and it is asserted to be used in that
 * file and in no other.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..')

/**
 * The modules that decide, and the one that wires them up.
 *
 * Named rather than inferred from a directory, so a module added to the path is a deliberate entry here
 * rather than something a glob quietly starts or stops covering. Each is asserted to EXIST, because a
 * renamed file would otherwise turn this whole test into a scan over nothing (ADR 0002).
 */
const DECIDING = [
  'packages/core/src/analytics/consent-gate.ts',
  'packages/db/src/repositories/analytics-consent.ts',
  'apps/web/app/api/v1/consent/analytics/handler.ts',
  'apps/web/app/(public)/_components/consent-banner.tsx',
  'packages/db/migrations/0125_analytics_consent.sql',
] as const

/** The wiring, which may name `DATABASE_URL` and nothing else. */
const WIRING = 'apps/web/app/api/v1/consent/analytics/route.ts'

const ESTATE = [...DECIDING, WIRING] as const

/** The one environment variable the estate may name, and where. */
const ENV_ALLOWED = new Map([
  [
    WIRING,
    'DATABASE_URL says where the consent records live and nothing about whether consent is required; ' +
      'without it the endpoint cannot open a connection at all',
  ],
])
const ENV_ALLOWED_NAMES = new Set(['DATABASE_URL'])

const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8')

/**
 * A file's CODE, with every comment blanked, which is what the mechanism cases scan.
 *
 * Without this the test fires on its own subject's documentation. `handler.ts`'s header says "There is no
 * `loadConfig()` read on this path and no `process.env`" — true, and both phrases are literal matches, so
 * the first run of the mechanism case reported the handler as reading configuration it explicitly does
 * not. That is the `readFileSync` lesson M-VAT-09 recorded as ADR 0052: a gate that reports its own prose
 * is a gate somebody switches off, and the fix is to scan code rather than to reword the comment until a
 * regexp is satisfied.
 *
 * `codeOnly` is R-REP-05's, exported from `ltv-arch.ts` and asserted in both directions there, so this is
 * one statement of what a comment is rather than a second. It handles `//` and block comments; SQL's `--`
 * is blanked here as well, because the migration is in the estate and a line comment that is not blanked
 * would reintroduce the exact failure above one file along. STRING CONTENTS are deliberately kept: a
 * setting key or a variable name inside a string is a read somebody is about to perform.
 */
function scannable(file: string, source: string): string {
  const code = codeOnly(source)
  if (!file.endsWith('.sql')) return code
  return code.replace(/--[^\n]*/g, (match) => ' '.repeat(match.length))
}

/**
 * Every environment variable this build reads, from the schema that defines them.
 *
 * Parsed out of `env.ts` rather than imported, because the zod schema is a module-private constant —
 * `parseConfig` and `Config` are what the package exports. The extraction is asserted to have found a
 * substantial set INCLUDING two names read from the module's own exported surface, so a pattern that
 * stopped matching fails here rather than silently enumerating nothing.
 */
function environmentVariableNames(): readonly string[] {
  const source = read('packages/config/src/env.ts')
  const open = source.indexOf('const schema = z')
  expect(
    open,
    'the env schema could not be found, so this test enumerated no variables',
  ).toBeGreaterThan(0)
  const names = [
    ...new Set(
      [...source.slice(open).matchAll(/^\s{4}([A-Z][A-Z0-9_]{2,}):/gm)].map(
        (match) => match[1] ?? '',
      ),
    ),
  ]
  return names.filter((name) => name !== '')
}

describe('the consent gate is code and not configuration', () => {
  it('has every module it claims to be about', () => {
    for (const file of ESTATE) {
      expect(read(file).length, `${file} is in the estate and is empty or missing`).toBeGreaterThan(
        500,
      )
    }
    expect(ESTATE.length).toBeGreaterThan(4)
  })

  it('names no setting key anywhere, over the whole registry', () => {
    const keys = SETTINGS.map((setting) => setting.key)
    // The control first: the enumeration is real. Every assertion below holds for an empty registry.
    expect(keys.length, 'the settings registry enumerated nothing').toBeGreaterThan(40)
    expect(keys).toContain('booking.turnaround_minutes_standard')
    expect(new Set(keys).size, 'two settings share a key').toBe(keys.length)

    const offences: string[] = []
    for (const file of ESTATE) {
      const code = scannable(file, read(file))
      for (const key of keys) {
        if (code.includes(key)) offences.push(`${file} names the setting ${key}`)
      }
    }
    expect(
      offences,
      'a setting key in the gate estate is a switch: the gate would answer whatever an admin last ' +
        'saved, and ADR 0076 is that there is no such switch',
    ).toEqual([])
  })

  it('names no environment variable except the one allowance, which IS used', () => {
    const names = environmentVariableNames()
    // The control: the extraction found the real set, including two names this package exports around.
    expect(names.length, 'the env schema enumerated nothing').toBeGreaterThan(20)
    expect(names).toContain('APP_ENV')
    expect(names).toContain('DATABASE_URL')

    const offences: string[] = []
    const used = new Set<string>()
    for (const file of ESTATE) {
      const code = scannable(file, read(file))
      for (const name of names) {
        if (!code.includes(name)) continue
        if (ENV_ALLOWED.has(file) && ENV_ALLOWED_NAMES.has(name)) {
          used.add(file)
          continue
        }
        offences.push(`${file} names the environment variable ${name}`)
      }
    }
    expect(
      offences,
      'an environment variable in the gate estate is a deployment that can turn consent off, and the ' +
        'one that could would be the one nobody reviews',
    ).toEqual([])
    // The allowance is used. An allowance that excuses nothing is a hole waiting for the next thing
    // written there — `scripts/check-egress-guard.mjs` carries the same control on its own allowances.
    for (const file of ENV_ALLOWED.keys()) {
      expect(used.has(file), `${file} is allowed to name DATABASE_URL and does not`).toBe(true)
    }
  })

  it('reads no configuration mechanism at all, by any of the ways there are', () => {
    /*
     * The mechanisms, not the names. A key this build has not invented yet is invisible to the two cases
     * above, and `process.env.SOMETHING_NEW` would pass both of them — so the READ is what is refused.
     *
     * `loadConfig` is allowed in the wiring module and nowhere else, and the wiring hands the handler a
     * `sql` and a `clock` and nothing else, which the next case asserts from the type.
     */
    const mechanisms = [
      'process.env',
      'readSetting',
      'settingValue',
      'getDefinition',
      'validateSetting',
      'featureFlag',
      'feature_flag',
      'app_setting',
      'current_setting',
      'killSwitch',
      'kill_switch',
      'isEnabled',
    ]
    const offences: string[] = []
    for (const file of ESTATE) {
      const code = scannable(file, read(file))
      for (const mechanism of mechanisms) {
        if (code.includes(mechanism)) offences.push(`${file} reads ${mechanism}`)
      }
      if (file !== WIRING && code.includes('loadConfig')) {
        offences.push(`${file} calls loadConfig, which only the wiring module may`)
      }
    }
    expect(offences).toEqual([])
    // The control: these patterns DO find something where they should. `getDefinition` is a real export,
    // so a scan that matched nothing anywhere would be a scan whose patterns had gone stale rather than a
    // clean estate.
    expect(
      scannable(
        'packages/config/src/settings/registry.ts',
        read('packages/config/src/settings/registry.ts'),
      ),
    ).toContain('getDefinition')
    // And the control on the stripper itself, in both directions, because the whole case rests on it:
    // a mechanism inside a comment is blanked, and the same mechanism in code is not.
    expect(scannable('x.ts', '// process.env.FOO\nconst a = 1')).not.toContain('process.env')
    expect(scannable('x.ts', 'const a = process.env.FOO')).toContain('process.env')
    expect(scannable('x.sql', '-- current_setting(1)\nselect 1;')).not.toContain('current_setting')
    expect(scannable('x.sql', "select current_setting('x');")).toContain('current_setting')
  })

  it('hands the handler a connection and a clock, and nothing a deployment could set', () => {
    const source = read('apps/web/app/api/v1/consent/analytics/handler.ts')
    const open = source.indexOf('export interface ConsentEndpointDeps {')
    expect(open, 'the handler no longer declares its dependencies under that name').toBeGreaterThan(
      0,
    )
    const body = source.slice(open, source.indexOf('}', open))
    // Exactly two fields. A third — a config object, a flag, an `enabled` boolean — is what would make
    // the gate answerable from outside the code, and it would arrive here first.
    const fields = [...body.matchAll(/^\s*readonly\s+([A-Za-z]+):/gm)].map((match) => match[1])
    expect(fields).toEqual(['sql', 'clock'])
  })

  it('states the gate in core and in the database, and holds the two tables equal in shape', () => {
    /*
     * The pure table and the migration's rows are two statements of one mapping. This case holds the
     * SHAPE equal — every server destination in core has a row in the migration and the required signals
     * agree — by reading the migration's INSERT. The rows as the DATABASE holds them are checked against
     * core in `analytics-consent.itest.ts`, which is the stronger half; this one fails before a migration
     * has been applied anywhere, which is the half that catches a mapping edited in only one place.
     */
    const sql = read('packages/db/migrations/0125_analytics_consent.sql')
    const open = sql.indexOf('insert into analytics_dispatch_destination')
    expect(open, 'the destination rows could not be found in the migration').toBeGreaterThan(0)
    const insert = sql.slice(open, sql.indexOf(';', open))
    const rows = [
      ...insert.matchAll(
        /\('([a-z_]+)',\s*(true|false),\s*(true|false),\s*(true|false),\s*(true|false)/g,
      ),
    ]
    const serverTargets = CONSENT_GATED_TARGET_IDS.filter(
      (id) => consentGatedTarget(id)?.surface === 'server_dispatch',
    )
    expect(rows.map((row) => row[1]).toSorted()).toEqual([...serverTargets].toSorted())
    // The control: there is more than one row and they are not all identical, so the comparison below is
    // about the mapping rather than about one value repeated.
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      const destination = row[1] as string
      const required = new Set(consentGatedTarget(destination)?.requires ?? [])
      expect(
        [row[2] === 'true', row[3] === 'true', row[4] === 'true', row[5] === 'true'],
        `${destination} requires a different set in the migration than in core`,
      ).toEqual([
        required.has('ad_storage'),
        required.has('ad_user_data'),
        required.has('ad_personalization'),
        required.has('analytics_storage'),
      ])
      expect(
        required.size,
        `${destination} requires nothing, which permits every session`,
      ).toBeGreaterThan(0)
    }
  })
})
