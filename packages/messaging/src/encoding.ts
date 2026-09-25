/**
 * What a message will cost, computed at authoring time.
 *
 * The arithmetic and the price are both `@berelax/core`'s — `segmentSms` for GSM-7 versus UCS-2 at 160 or
 * 70 characters to a segment (153 or 67 once concatenated), and `smsCost` for the fils. This module is
 * the channel-shaped wrapper: it decides that email and WhatsApp are not segment-billed, and it hands the
 * figures to the person writing the template, which is the only moment they can still change anything.
 *
 * The number that surprises people: **an Arabic message holds 70 characters per segment against
 * English's 160**, because one Arabic character forces the whole body to UCS-2. The same campaign costs
 * several times as much in Arabic, and a template author who finds that out from an invoice has already
 * sent it.
 *
 * ## Why there is no rate in this file any more
 *
 * There was: `PROVISIONAL_FILS_PER_SEGMENT = 9`, beside a second copy in the SMSala fake and a third
 * figure nowhere. C-AUTO-02 moved the rate into `SMS_SEGMENT_PRICES` in `@berelax/core` and deleted both
 * copies, because two rates is the one defect this whole estate exists to prevent: the authoring preview
 * reads one, the vendor bills the other, and the price an author was shown stops being the price on the
 * invoice — silently, and only for the bodies whose encoding differs from the one somebody tested.
 */
import { type SmsEncoding, type SmsSegmentation, segmentSms, smsCost } from '@berelax/core'
import type { Channel } from './port.ts'

export interface MessageCost {
  readonly channel: Channel
  readonly encoding: SmsEncoding
  readonly segments: number
  /** Units consumed: septets for GSM-7, UTF-16 code units for UCS-2. */
  readonly units: number
  readonly costFils: number
  /** Units still free in the current segment, so an author can see how close the next one is. */
  readonly remaining: number
  /**
   * Characters that forced UCS-2, if any.
   *
   * Surfaced because the usual cause is invisible: a typographic apostrophe pasted from a word
   * processor looks identical to an ASCII one and costs 90 characters of capacity.
   */
  readonly forcedUnicodeBy: readonly string[]
  /**
   * The OPEN-QUESTIONS id that replaces the rate this cost was computed from, or null off the SMS path.
   *
   * Carried rather than assumed, so a screen showing a total can say the rate is unconfirmed. Null for a
   * channel that is not segment-billed, where the zero is a fact about the channel and not a placeholder.
   */
  readonly provisionalUntil: string | null
}

/** Cost of a body on a channel. Email and WhatsApp are not segment-billed, so they cost nothing here. */
export function costOf(channel: Channel, body: string): MessageCost {
  const segmentation: SmsSegmentation = segmentSms(body)
  if (channel !== 'sms') {
    return {
      channel,
      encoding: segmentation.encoding,
      segments: 0,
      units: segmentation.units,
      costFils: 0,
      remaining: segmentation.remaining,
      forcedUnicodeBy: segmentation.forcedBy,
      provisionalUntil: null,
    }
  }
  // One provider, because one is contracted (docs/05 §1) and `vendorFor('sms')` answers the same name.
  const cost = smsCost('smsala', body)
  return {
    channel,
    encoding: segmentation.encoding,
    segments: segmentation.segments,
    units: segmentation.units,
    costFils: cost.total.fils,
    remaining: segmentation.remaining,
    forcedUnicodeBy: segmentation.forcedBy,
    provisionalUntil: cost.provisionalUntil,
  }
}

/** Cost of sending one body to many recipients — the number a campaign screen has to show. */
export function campaignCost(channel: Channel, body: string, recipients: number): number {
  return costOf(channel, body).costFils * recipients
}
