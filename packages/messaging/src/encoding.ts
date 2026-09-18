/**
 * What a message will cost, computed at authoring time.
 *
 * The arithmetic is `segmentSms` in `@berelax/core` — GSM-7 versus UCS-2, 160 or 70 characters to a
 * segment, 153 or 67 once concatenated. This module turns that into money and puts it in front of the
 * person writing the template, which is the only moment it can still change anything.
 *
 * The number that surprises people: **an Arabic message holds 70 characters per segment against
 * English's 160**, because one Arabic character forces the whole body to UCS-2. The same campaign
 * costs over twice as much in Arabic, and a template author who finds that out from an invoice has
 * already sent it.
 */
import { type SmsEncoding, type SmsSegmentation, segmentSms } from '@berelax/core'
import type { Channel } from './port.ts'

/**
 * Fils per SMS segment.
 *
 * Provisional — the real rate is on the SMSala contract, tracked as `Y6-sms-rate` in
 * docs/OPEN-QUESTIONS.md. It is a single constant so that correcting it is one edit rather than an
 * archaeology exercise, and so the Unconfirmed Assumptions panel has something to point at.
 */
export const PROVISIONAL_FILS_PER_SEGMENT = 9

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
}

/** Cost of a body on a channel. Email and WhatsApp are not segment-billed, so they cost nothing here. */
export function costOf(channel: Channel, body: string): MessageCost {
  const segmentation: SmsSegmentation = segmentSms(body)
  const billable = channel === 'sms'
  return {
    channel,
    encoding: segmentation.encoding,
    segments: billable ? segmentation.segments : 0,
    units: segmentation.units,
    costFils: billable ? segmentation.segments * PROVISIONAL_FILS_PER_SEGMENT : 0,
    remaining: segmentation.remaining,
    forcedUnicodeBy: segmentation.forcedBy,
  }
}

/** Cost of sending one body to many recipients — the number a campaign screen has to show. */
export function campaignCost(channel: Channel, body: string, recipients: number): number {
  return costOf(channel, body).costFils * recipients
}
