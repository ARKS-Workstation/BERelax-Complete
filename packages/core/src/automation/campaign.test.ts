import { isAppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  type PromotionalHours,
  RAMADAN_PROMOTIONAL_HOURS,
} from '../messaging/promotional-window.ts'
import {
  ASIA_DUBAI,
  type Instant,
  instantFromIso,
  instantToIso,
  localDate,
  toLocal,
} from '../time.ts'
import {
  campaignSendWindowVerdict,
  estimateCampaign,
  estimateTotalFils,
  scheduleCampaign,
  scheduleCampaignOrThrow,
} from './campaign.ts'

/**
 * C-AUTO-10's authoring-time refusal and its 21:00 boundary.
 *
 * The window figure is an ARGUMENT in every case below, and deliberately so: the ceiling is
 * `messaging.promotional_window`'s registry default and this module knows nothing about it. A test that
 * hard-coded 07:00–21:00 and passed would be the second statement of the figure the module exists not to
 * make.
 */

/** The TDRA ceiling as the gate reads it, passed in rather than imported — see the file's note. */
const CEILING: PromotionalHours = { startHour: 7, endHour: 21 }

const at = (iso: string): Instant => instantFromIso(iso)
const decide = (iso: string, overrides?: Parameters<typeof scheduleCampaign>[0]['overrides']) =>
  scheduleCampaign({
    at: at(iso),
    local: toLocal(at(iso), ASIA_DUBAI),
    zone: ASIA_DUBAI,
    ceiling: CEILING,
    ...(overrides === undefined ? {} : { overrides }),
  })

describe('estimateCampaign', () => {
  it('states the recipients, the segments per message and the total, not only the total', () => {
    const estimate = estimateCampaign({
      provider: 'smsala',
      body: 'Your usual room is free on Friday. Reply STOP to opt out.',
      recipients: 200,
    })
    expect(estimate.recipients).toBe(200)
    expect(estimate.segmentsPerMessage).toBe(1)
    expect(estimate.encoding).toBe('GSM-7')
    // The multiplication, which is the whole claim: the total is the per-message cost times the count and
    // nothing else, so an outcome that disagrees disagrees about one of two numbers.
    expect(estimateTotalFils(estimate)).toBe(estimate.perMessage.fils * 200)
  })

  it('charges an Arabic body more segments, which is the figure that changes a decision', () => {
    const gsm = estimateCampaign({ provider: 'smsala', body: 'A'.repeat(150), recipients: 10 })
    const arabic = estimateCampaign({ provider: 'smsala', body: 'ا'.repeat(150), recipients: 10 })
    expect(gsm.segmentsPerMessage).toBe(1)
    expect(arabic.segmentsPerMessage).toBeGreaterThan(gsm.segmentsPerMessage)
    expect(arabic.encoding).toBe('UCS-2')
    expect(estimateTotalFils(arabic)).toBeGreaterThan(estimateTotalFils(gsm))
  })

  it('refuses a fractional recipient count rather than rounding it', () => {
    expect(() =>
      estimateCampaign({ provider: 'smsala', body: 'Hello', recipients: 12.5 }),
    ).toThrow()
  })
})

describe('scheduleCampaign refuses an instant outside the promotional window', () => {
  it('accepts 14:00 Asia/Dubai', () => {
    const decision = decide('2026-09-18T10:00:00.000Z')
    expect(decision.kind).toBe('accepted')
  })

  it('refuses 22:30 Asia/Dubai, naming the NEXT VALID INSTANT', () => {
    // 22:30 Asia/Dubai on 18 September 2026 is 18:30Z.
    const decision = decide('2026-09-18T18:30:00.000Z')
    // The rule name, asserted as a VALUE rather than through `decision.kind`, so a failure prints it in
    // full — a gate case asserting rejection BY NAME (ADR 0003) has to be able to find the name in the
    // output it is given, and `expected 'refused' to be 'accepted'` carries no rule at all.
    expect(decision.kind === 'refused' ? decision.rule : `accepted:${decision.kind}`).toBe(
      'campaign-scheduled-outside-the-promotional-window',
    )
    if (decision.kind !== 'refused') return
    // 07:00 Asia/Dubai the next morning is 03:00Z on the 19th. The instant, not the hours: an author
    // told "07:00–21:00" has to apply the rule themselves, and the dated overrides are the part they
    // cannot see.
    expect(instantToIso(decision.nextValidInstant)).toBe('2026-09-19T03:00:00.000Z')
    expect(decision.detail).toContain('2026-09-19T03:00:00.000Z')
  })

  it('refuses 06:00 the same morning and names 07:00 THAT day, not the next', () => {
    // 06:00 Asia/Dubai is 02:00Z. The opening has not passed yet, so the answer is today's.
    const decision = decide('2026-09-18T02:00:00.000Z')
    expect(decision.kind).toBe('refused')
    if (decision.kind !== 'refused') return
    expect(instantToIso(decision.nextValidInstant)).toBe('2026-09-18T03:00:00.000Z')
  })

  it('honours a dated narrowing, so the next valid instant is 10:00 and not 07:00', () => {
    // The narrowing is the reason the refusal carries an instant. An author told the hours would schedule
    // 07:00 inside a narrowed day and be refused a second time.
    const decision = decide('2026-09-18T18:30:00.000Z', [
      {
        fromDate: localDate('2026-09-19'),
        toDate: localDate('2026-09-19'),
        hours: RAMADAN_PROMOTIONAL_HOURS,
        reason: 'ramadan_hours',
      },
    ])
    expect(decision.kind).toBe('refused')
    if (decision.kind !== 'refused') return
    expect(instantToIso(decision.nextValidInstant)).toBe('2026-09-19T06:00:00.000Z')
  })
})

describe('scheduleCampaignOrThrow', () => {
  it('returns the instant when it is inside the window', () => {
    expect(
      scheduleCampaignOrThrow({
        at: at('2026-09-18T10:00:00.000Z'),
        local: toLocal(at('2026-09-18T10:00:00.000Z'), ASIA_DUBAI),
        zone: ASIA_DUBAI,
        ceiling: CEILING,
      }),
    ).toBe(at('2026-09-18T10:00:00.000Z'))
  })

  it('throws a named, user-facing refusal carrying the next valid instant', () => {
    let caught: unknown
    try {
      scheduleCampaignOrThrow({
        at: at('2026-09-18T18:30:00.000Z'),
        local: toLocal(at('2026-09-18T18:30:00.000Z'), ASIA_DUBAI),
        zone: ASIA_DUBAI,
        ceiling: CEILING,
      })
    } catch (error) {
      caught = error
    }
    expect(isAppError(caught)).toBe(true)
    if (!isAppError(caught)) return
    expect(caught.details['rule']).toBe('campaign-scheduled-outside-the-promotional-window')
    expect(caught.details['nextValidInstant']).toBe('2026-09-19T03:00:00.000Z')
    expect(caught.userFacing).toBe(true)
  })
})

describe('campaignSendWindowVerdict is the 21:00 boundary', () => {
  const verdict = (iso: string) =>
    campaignSendWindowVerdict({
      at: at(iso),
      local: toLocal(at(iso), ASIA_DUBAI),
      zone: ASIA_DUBAI,
      ceiling: CEILING,
    })

  it('is open at 20:55 Asia/Dubai', () => {
    // 20:55 Asia/Dubai is 16:55Z. The campaign in the acceptance line is scheduled here.
    expect(verdict('2026-09-18T16:55:00.000Z').kind).toBe('open')
  })

  it('is open at 20:59 and HALTS at 21:00, which is the boundary itself', () => {
    expect(verdict('2026-09-18T16:59:59.000Z').kind).toBe('open')
    const halted = verdict('2026-09-18T17:00:00.000Z')
    expect(halted.kind).toBe('halt')
    if (halted.kind !== 'halt') return
    expect(halted.reason).toBe('promotional_window_closed')
    // The remainder is held against the campaign and the reopening is reported, not acted on: a list sent
    // half today and half tomorrow under one campaign id advertises yesterday to the second half.
    expect(instantToIso(halted.reopensAt)).toBe('2026-09-19T03:00:00.000Z')
    expect(halted.detail).toContain('HELD')
  })

  it('halts rather than queueing, which is the one decision not inherited from the window module', () => {
    const halted = verdict('2026-09-18T21:00:00.000Z')
    expect(halted.kind).toBe('halt')
  })
})
