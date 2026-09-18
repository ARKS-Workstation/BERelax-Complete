import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import type { UnitOfWork } from '../tx.ts'
import {
  CATALOGUE_REFUSALS,
  CATALOGUE_SQLSTATE,
  catalogueError,
  refusalOf,
  SERVICE_PATH_PREFIX,
  servicePath,
  setPublicDisplayName,
  TREATMENTS_INDEX_PATH,
} from './catalogue.ts'

/**
 * B-CAT-05 — the halves of the catalogue repository that need no database.
 *
 * The rest of it is asserted against real PostgreSQL in `catalogue.itest.ts`, because every guard rail
 * it names is a trigger or a foreign key and a mock would assert the mock. What is here is the error
 * translation and the fail-closed lint check: both are pure decisions about values, and both are the
 * kind of code that is only ever exercised on the failure path — which is exactly the path that gets
 * shipped untested.
 */

/** A driver error as postgres.js raises one: a message, a SQLSTATE and sometimes a constraint. */
const driverError = (code: string, constraint?: string): Error =>
  Object.assign(new Error(`probe failure ${code}`), {
    code,
    ...(constraint === undefined ? {} : { constraint_name: constraint }),
  })

describe('servicePath', () => {
  it('builds the public path from the slug', () => {
    expect(servicePath('asian-normal-massage')).toBe('/treatments/asian-normal-massage')
    expect(SERVICE_PATH_PREFIX).toBe('/treatments')
  })

  it('sends an archived service to the treatments index, which always resolves', () => {
    expect(TREATMENTS_INDEX_PATH).toBe('/treatments')
  })
})

describe('catalogueError', () => {
  const cases: readonly (readonly [string, string])[] = [
    [CATALOGUE_SQLSTATE.publishWithoutCompatRow, 'service_publish_without_compat_row'],
    [CATALOGUE_SQLSTATE.publishWithoutResourceShape, 'service_publish_without_resource_shape'],
    [CATALOGUE_SQLSTATE.publishWithoutPricedVariant, 'service_publish_without_priced_variant'],
    [CATALOGUE_SQLSTATE.slugChangeWithoutRedirect, 'slug_change_without_redirect'],
    [CATALOGUE_SQLSTATE.redirectTargetUnresolved, 'redirect_target_unresolved'],
    [CATALOGUE_SQLSTATE.redirectChainNotCollapsed, 'redirect_chain_not_collapsed'],
  ]

  for (const [code, refusal] of cases) {
    it(`translates ${code} into ${refusal}`, () => {
      const translated = catalogueError(driverError(code))
      expect(translated).toBeInstanceOf(AppError)
      expect(translated?.details['refusal']).toBe(refusal)
      expect(translated?.details['sqlState']).toBe(code)
      expect(refusalOf(driverError(code))).toBe(refusal)
    })
  }

  it('names every refusal it can raise in CATALOGUE_REFUSALS', () => {
    // The list is what a caller switches on. A refusal missing from it is one `refusalOf` reports as
    // null, which is how a handled failure becomes an unhandled one.
    for (const [, refusal] of cases) expect(CATALOGUE_REFUSALS).toContain(refusal)
  })

  it('reads a SQLSTATE carried on an already-translated error, so translation is idempotent', () => {
    // The deferred triggers fail at COMMIT, so a caller may translate the same error twice: once
    // around the statement and once around the transaction. A second pass that reported "not one of
    // ours" would turn a named refusal back into an unknown failure at the outermost layer.
    const once = catalogueError(driverError(CATALOGUE_SQLSTATE.slugChangeWithoutRedirect))
    expect(catalogueError(once)?.details['refusal']).toBe('slug_change_without_redirect')
  })

  describe('the two standard codes, where the constraint name is the meaning', () => {
    it('translates the appointment foreign key into service_has_appointments', () => {
      const translated = catalogueError(driverError('23503', 'appointment_service_variant_id_fkey'))
      expect(translated?.details['refusal']).toBe('service_has_appointments')
      expect(translated?.kind).toBe('conflict')
      expect(translated?.userFacing).toBe(true)
      expect(translated?.message).toContain('Archive it instead')
    })

    it('leaves any other foreign key violation alone', () => {
      // A 23503 from `appointment.trading_date` means the premises does not trade that day. Reporting
      // it as "the service has appointments" would send the reader to the wrong table entirely.
      expect(catalogueError(driverError('23503', 'appointment_trading_date_fkey'))).toBeNull()
      expect(catalogueError(driverError('23503'))).toBeNull()
    })

    it('translates the archived-and-published check, and no other check', () => {
      expect(
        catalogueError(driverError('23514', 'service_archived_is_not_published'))?.details[
          'refusal'
        ],
      ).toBe('service_archived_is_not_published')
      expect(catalogueError(driverError('23514', 'service_turnaround_bounded'))).toBeNull()
    })

    it('reads the constraint from either spelling a driver uses', () => {
      const alternate = Object.assign(new Error('probe'), {
        code: '23503',
        constraint: 'appointment_service_variant_id_fkey',
      })
      expect(catalogueError(alternate)?.details['refusal']).toBe('service_has_appointments')
    })
  })

  it('returns null for an error that is not this schema refusing', () => {
    expect(catalogueError(driverError('57P01'))).toBeNull()
    expect(catalogueError(new Error('connection reset'))).toBeNull()
    expect(catalogueError('a string')).toBeNull()
    expect(refusalOf(new Error('connection reset'))).toBeNull()
    expect(refusalOf(new AppError('conflict', 'something else'))).toBeNull()
  })
})

describe('the public name lint is fail-closed', () => {
  /** A unit of work whose every use would throw, so the refusal must happen before any of it. */
  const unusable = {
    get sql(): never {
      throw new Error('setPublicDisplayName reached the database without linting the name')
    },
    get audit(): never {
      throw new Error('setPublicDisplayName reached the audit writer without linting the name')
    },
    publish: () => Promise.reject(new Error('unreachable')),
  } as unknown as UnitOfWork

  it('refuses the write when no lint was supplied, rather than defaulting to permitting it', async () => {
    // The plausible defect is a caller that forgot the lint — from JavaScript, or through a cast, or
    // because a wrapper dropped the field. An unlinted public name is indistinguishable from a
    // compliant one until somebody reads it on the site, so the write is refused.
    const input = { serviceId: 'e6b3', publicDisplayName: 'Therapeutic Massage' } as unknown as {
      serviceId: string
      publicDisplayName: string
      lint: (name: string) => void
    }
    await expect(setPublicDisplayName(unusable, input)).rejects.toThrow(
      /public_display_name_unlinted/,
    )
  })

  it('lets the lint refuse the name, and never reaches the database when it does', async () => {
    const refused = (): never => {
      throw new AppError('validation', 'public_display_name_refused: banned_claim_term')
    }
    await expect(
      setPublicDisplayName(unusable, {
        serviceId: 'e6b3',
        publicDisplayName: 'Therapeutic Massage',
        lint: refused,
      }),
    ).rejects.toThrow(/public_display_name_refused/)
  })

  it('passes the name it is about to write to the lint, not a normalised copy of it', async () => {
    // A lint shown a different string from the one stored is a lint of something else. The call is
    // asserted on the exact value, because the one bug this shape can still have is trimming.
    const seen: string[] = []
    await expect(
      setPublicDisplayName(unusable, {
        serviceId: 'e6b3',
        publicDisplayName: '  Normal Massage (Asian)  ',
        lint: (name) => {
          seen.push(name)
        },
      }),
    ).rejects.toThrow(/without linting the name/)
    expect(seen).toEqual(['  Normal Massage (Asian)  '])
  })
})
