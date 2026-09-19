import { AppError } from '@berelax/shared'
import { describe, expect, it, vi } from 'vitest'
import type { AuditWriter } from '../audit.ts'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'
import {
  BOOKING_REFUSALS,
  BOOKING_SQLSTATE,
  type BookingDeliveryInput,
  bookingError,
  bookingRefusalOf,
  type CreateBookingInput,
  createBooking,
  isIdempotencyRace,
  requestFingerprint,
  type SlotRecheck,
} from './create-booking.ts'

/**
 * The halves of the booking transaction that need no database.
 *
 * The row lock, the idempotency race and the all-or-none property are properties of PostgreSQL and
 * cannot be tested against a mock — they are `packages/fixtures/src/booking-transaction.itest.ts` and
 * `booking-concurrency.itest.ts`, against a real server. What is here is everything that decides
 * *before* a statement is issued, plus the translation of the errors that arrive back:
 *
 *   - the request fingerprint, which is what tells a retry from a key reused for a different booking;
 *   - the refusals raised before any work is done, each asserted by name;
 *   - the SQLSTATE translation, including the two codes that arrive from a constraint trigger.
 *
 * Every refusal below is asserted with a **fake unit of work that fails if it is used**, so "refused
 * before anything was written" is a property of the test rather than a claim in a comment.
 */

/** A unit of work whose every statement throws. Using it is the failure the assertions are about. */
function unusableUow(): UnitOfWork {
  const explode = () => {
    throw new Error('the transaction issued a statement after it should have refused the request')
  }
  return {
    sql: explode as unknown as Sql,
    audit: { record: explode } as unknown as AuditWriter,
    publish: explode,
  }
}

const RECHECK: SlotRecheck = () => ({
  kind: 'assigned',
  roomId: 'room',
  therapistIds: ['a', 'b'],
  placesUsed: 1,
})

const CUSTOMER = '00000000-0000-4000-8000-0000000000c0'
const VARIANT = '00000000-0000-4000-8000-0000000000e1'
const ROOM = '00000000-0000-4000-8000-0000000000f1'
const THERAPIST = '00000000-0000-4000-8000-0000000000a1'

const DELIVERY: BookingDeliveryInput = {
  tradingDate: '2099-09-04',
  serviceVariantId: VARIANT,
  shape: 'solo',
  roomId: ROOM,
  therapistIds: [THERAPIST],
  treatment: { startsAt: 4_090_000_000_000, endsAt: 4_090_003_600_000 },
  price: {
    grossFils: 20_000,
    netFils: 19_048,
    vatFils: 952,
    vatRateBp: 500,
    priceListId: null,
    promotionId: null,
  },
}

const withDelivery = (patch: Partial<BookingDeliveryInput>): BookingDeliveryInput => ({
  ...DELIVERY,
  ...patch,
})

/**
 * A request, with `clientGender` and `genderMatching` spelled so `undefined` is sayable.
 *
 * `exactOptionalPropertyTypes` makes an explicit `undefined` a different type from an absent key, and
 * "we did not collect it" is exactly the case these tests are about — so the override type says
 * `| undefined` and the spread below drops the key when that is what it is.
 */
interface RequestOverrides
  extends Partial<Omit<CreateBookingInput, 'clientGender' | 'genderMatching'>> {
  readonly clientGender?: 'female' | 'male' | undefined
  readonly genderMatching?: 'strict' | 'advisory' | undefined
}

const input = (overrides: RequestOverrides = {}): CreateBookingInput => {
  const { clientGender, genderMatching, ...rest } = overrides
  const carriesGender = 'clientGender' in overrides ? clientGender !== undefined : true
  return {
    idempotencyKey: 'key-1',
    customerId: CUSTOMER,
    source: 'online',
    deliveries: [DELIVERY],
    ...(carriesGender ? { clientGender: clientGender ?? 'female' } : {}),
    ...(genderMatching === undefined ? {} : { genderMatching }),
    ...rest,
  }
}

const refused = async (
  patch: RequestOverrides,
  deps: { recheck: SlotRecheck } = { recheck: RECHECK },
): Promise<string | null> => {
  try {
    await createBooking(unusableUow(), input(patch), deps)
  } catch (err) {
    return bookingRefusalOf(err)
  }
  return null
}

describe('the fingerprint tells a retry from a key reused for something else', () => {
  it('is stable across two spellings of the same request', () => {
    // The same booking assembled with the keys in a different order and the notes and source changed.
    // Object key order is insertion order in JavaScript, so `JSON.stringify(input)` would produce two
    // different hashes here and a client's own retry would read as a reused key.
    const first = requestFingerprint(input({ source: 'online', notes: 'window seat' }))
    const second = requestFingerprint(input({ notes: 'a different note', source: 'phone' }))
    expect(second).toBe(first)
  })

  it('changes when anything about WHAT was booked changes', () => {
    const base = requestFingerprint(input())
    const variations: CreateBookingInput[] = [
      input({ customerId: '00000000-0000-4000-8000-0000000000c9' }),
      input({ deliveries: [withDelivery({ roomId: '00000000-0000-4000-8000-0000000000f9' })] }),
      input({ deliveries: [withDelivery({ shape: 'four_hands' })] }),
      input({
        deliveries: [withDelivery({ therapistIds: ['00000000-0000-4000-8000-0000000000a9'] })],
      }),
      input({
        deliveries: [
          withDelivery({ treatment: { startsAt: 4_090_000_060_000, endsAt: 4_090_003_660_000 } }),
        ],
      }),
      input({
        deliveries: [withDelivery({ price: { ...DELIVERY.price, grossFils: 19_000 } })],
      }),
      input({ deliveries: [withDelivery({ tradingDate: '2099-09-05' })] }),
      input({ deliveries: [withDelivery({ serviceVariantId: CUSTOMER })] }),
    ]
    for (const variation of variations) {
      expect(requestFingerprint(variation)).not.toBe(base)
    }
    // And the control: the untouched request still hashes to `base`, so the eight above are the fields
    // and not a function that returns something new every call.
    expect(requestFingerprint(input())).toBe(base)
  })

  it('does not depend on the order the deliveries arrive in', () => {
    const two = withDelivery({ roomId: '00000000-0000-4000-8000-0000000000f2' })
    expect(requestFingerprint(input({ deliveries: [DELIVERY, two] }))).toBe(
      requestFingerprint(input({ deliveries: [two, DELIVERY] })),
    )
  })
})

describe('the refusals raised before a single statement is issued', () => {
  it('refuses a missing idempotency key', async () => {
    await expect(refused({ idempotencyKey: '   ' })).resolves.toBe('idempotency_key_required')
  })

  it('refuses a booking with no deliveries', async () => {
    await expect(refused({ deliveries: [] })).resolves.toBe('booking_has_no_deliveries')
  })

  it('refuses a pair that is one therapist listed twice', async () => {
    const twice = withDelivery({ therapistIds: [THERAPIST, THERAPIST] })
    await expect(refused({ deliveries: [twice] })).resolves.toBe('therapist_repeated')
  })

  it('refuses a price whose net and VAT do not sum to the gross', async () => {
    // One fils out. VAT is derived as the remainder precisely so the identity is exact (ADR 0007), and a
    // pair that fails it is a one-fils discrepancy somebody has to explain to an auditor.
    const wrong = withDelivery({ price: { ...DELIVERY.price, netFils: 19_047 } })
    await expect(refused({ deliveries: [wrong] })).resolves.toBe('price_split_disagrees')
  })

  it('refuses an unknown client gender under strict matching, and accepts it under advisory', async () => {
    // B-AVAIL-05's rule, honoured rather than re-opened: strict matching returns ZERO slots with
    // `requires_client_gender` before any start is considered, and a booking path that accepted the
    // omission would book through a refusal the availability query had already made.
    await expect(refused({ clientGender: undefined })).resolves.toBe('requires_client_gender')
    // Absent means strict, so leaving the mode out must refuse too. Without this case the assertion
    // above is satisfied by a build whose default is advisory.
    await expect(refused({ clientGender: undefined, genderMatching: undefined })).resolves.toBe(
      'requires_client_gender',
    )
    await expect(refused({ clientGender: undefined, genderMatching: 'strict' })).resolves.toBe(
      'requires_client_gender',
    )
    // The control. Under advisory the same request gets past this check and reaches the database — which
    // the unusable unit of work then reports as its own error, not as a refusal.
    await expect(refused({ clientGender: undefined, genderMatching: 'advisory' })).resolves.toBe(
      null,
    )
  })

  it('refuses when no slot re-check was injected, rather than trusting the page', async () => {
    // Fail closed, the same way `setPublicDisplayName` refuses an unlinted public name. The cast is the
    // point: a caller in JavaScript, or one that built its deps object from a partial, reaches this.
    await expect(refused({}, {} as unknown as { recheck: SlotRecheck })).resolves.toBe(
      'slot_not_revalidated',
    )
  })

  it('checks the re-check before it checks the request, because a missing rule is not a bad request', async () => {
    // Both wrong at once. The refusal names the missing re-check, so an operator sees the deployment
    // defect rather than being sent to look at the caller's payload.
    let named: string | null = null
    try {
      await createBooking(
        unusableUow(),
        input({ deliveries: [] }),
        {} as unknown as {
          recheck: SlotRecheck
        },
      )
    } catch (err) {
      named = bookingRefusalOf(err)
    }
    expect(named).toBe('slot_not_revalidated')
  })
})

describe('the SQLSTATE translation', () => {
  const err = (code: string, constraint?: string): Error =>
    Object.assign(new Error(`database said ${code}`), { code, constraint })

  it('names a room over capacity as a taken slot', () => {
    const translated = bookingError(err(BOOKING_SQLSTATE.roomOverCapacity))
    expect(translated).toBeInstanceOf(AppError)
    expect(bookingRefusalOf(translated)).toBe('slot_taken')
    expect(translated?.kind).toBe('conflict')
    expect(translated?.userFacing).toBe(true)
  })

  it('names an incoherent delivery, which is an invariant rather than a conflict', () => {
    const translated = bookingError(err(BOOKING_SQLSTATE.deliveryIncoherent))
    expect(bookingRefusalOf(translated)).toBe('delivery_incoherent')
    // `invariant_violated` and not `conflict`: nobody else took the slot — the rows this transaction
    // wrote disagree with each other, which is a defect in the writer.
    expect(translated?.kind).toBe('invariant_violated')
  })

  it('names the therapist exclusion constraint as a taken slot', () => {
    expect(bookingRefusalOf(bookingError(err('23P01')))).toBe('slot_taken')
  })

  it('names only the trading-date foreign key, and passes every other 23503 through', () => {
    expect(bookingRefusalOf(bookingError(err('23503', 'appointment_trading_date_fkey')))).toBe(
      'not_a_trading_date',
    )
    // The control, and the reason the constraint name is checked at all: reporting `booking`'s customer
    // foreign key as "the premises does not trade then" would send the reader to the wrong table.
    expect(bookingError(err('23503', 'booking_customer_id_fkey'))).toBeNull()
  })

  it('returns null for anything it does not recognise, so a disk error is not a taken slot', () => {
    expect(bookingError(err('53100'))).toBeNull()
    expect(bookingError(new Error('no code at all'))).toBeNull()
    expect(bookingRefusalOf(new Error('no code at all'))).toBeNull()
  })

  it('recognises the idempotency race by constraint and not by SQLSTATE alone', () => {
    expect(isIdempotencyRace(err('23505', 'booking_idempotency_pkey'))).toBe(true)
    // Every other unique violation in this schema means something else, and treating one as a replay
    // would hand the caller somebody else's booking. `outbox_event`'s key is the one nearest to hand.
    expect(isIdempotencyRace(err('23505', 'outbox_event_idempotency_key_key'))).toBe(false)
    expect(isIdempotencyRace(err('23P01', 'booking_idempotency_pkey'))).toBe(false)
  })

  it('reads the SQLSTATE and constraint from an AppError that already carries them', () => {
    // `bookSlot` translates once and rethrows; a caller that translates again must reach the same
    // answer rather than losing it, which is what `refusalOf` is for in the catalogue repository too.
    const once = bookingError(err(BOOKING_SQLSTATE.roomOverCapacity)) as AppError
    expect(bookingRefusalOf(once)).toBe('slot_taken')
    expect(once.details['sqlState']).toBe(BOOKING_SQLSTATE.roomOverCapacity)
  })
})

describe('the refusal list is closed', () => {
  it('has no duplicates and every name is used by at least one thrower', () => {
    expect(new Set(BOOKING_REFUSALS).size).toBe(BOOKING_REFUSALS.length)
    // `bookingRefusalOf` is the only reader, and it answers null for a name not in the list — which is
    // what makes an unlisted refusal a caller that cannot branch rather than a silent success.
    expect(
      bookingRefusalOf(new AppError('conflict', 'x', { details: { refusal: 'not_a_refusal' } })),
    ).toBeNull()
  })

  it('does not call the injected re-check when the request is already refused', async () => {
    const recheck = vi.fn<SlotRecheck>(() => ({
      kind: 'assigned',
      roomId: ROOM,
      therapistIds: [],
      placesUsed: 1,
    }))
    await expect(refused({ deliveries: [] }, { recheck })).resolves.toBe(
      'booking_has_no_deliveries',
    )
    expect(recheck).not.toHaveBeenCalled()
  })
})
