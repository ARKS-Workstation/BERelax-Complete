import { describe, expect, it } from 'vitest'
import { UNREACHABLE_OPT_OUT_PHRASES, unreachableOptOutPhrasesIn } from './optout-copy.ts'

/**
 * C-CRM-07 — the words no template may carry, because the mechanism they name does not exist here.
 *
 * The module is four lines, and every one of them is a way the check could quietly stop checking: a
 * case-sensitive match misses "reply stop", a phrase list that lost an entry passes the corpus it was
 * written for, and an `includes` against the un-lowered haystack passes an Arabic body carrying the Latin
 * keyword in lower case. Each has its own case below, and each has the positive control beside it.
 */
describe('unreachableOptOutPhrasesIn', () => {
  it('finds the instruction in the shape a template actually writes it', () => {
    expect(unreachableOptOutPhrasesIn('Offers from BE RELAX. Reply STOP to end.')).toEqual([
      'Reply STOP',
      'STOP to',
    ])
    expect(unreachableOptOutPhrasesIn('To unsubscribe send STOP to 1234.')).toEqual(['STOP to'])
  })

  it('is case-insensitive, because the promise is the same in lower case', () => {
    expect(unreachableOptOutPhrasesIn('reply stop at any time')).toEqual(['Reply STOP'])
    expect(unreachableOptOutPhrasesIn('REPLY STOP')).toEqual(['Reply STOP'])
  })

  it('finds it inside an Arabic body, where an SMS keyword is still Latin', () => {
    // The templates most likely to carry the convention in from another market are the Arabic ones, because
    // fewer readers of this repository read them.
    expect(unreachableOptOutPhrasesIn('عروض من بي ريلاكس. Reply STOP للإلغاء.')).toEqual([
      'Reply STOP',
    ])
    // And only that one: the second phrase is `STOP to`, and an Arabic sentence puts an Arabic word after
    // the keyword. Asserting both here would have been an expectation about the fixture rather than about
    // the rule, which is how a case comes to be edited until it passes.
    expect(unreachableOptOutPhrasesIn('أرسل STOP to 1234 للإلغاء.')).toEqual(['STOP to'])
  })

  it('passes the copy this business actually sends, including the words around a full stop', () => {
    for (const body of [
      'Booking confirmed for 18 Sep at 20:00. Details or changes: brlx.ae/b/AbCdEf',
      'Offers from BE RELAX. To change what we send you: brlx.ae/p/AbCdEf',
      'Our last treatment is non-stop until 02:00.',
      'STOPPING here is fine.',
      'تم تأكيد حجزك 18 سبتمبر الساعة 20:00. التفاصيل: brlx.ae/b/AbCdEf',
    ]) {
      expect(unreachableOptOutPhrasesIn(body), body).toEqual([])
    }
  })

  it('answers in declaration order, so a failure message reads the same way every time', () => {
    // Both phrases are present and the answer is the LIST's order rather than the order they appear in the
    // text — a filter over the constant, not a scan over the haystack, which is what makes it stable.
    expect(unreachableOptOutPhrasesIn('send STOP to us, or Reply STOP')).toEqual([
      ...UNREACHABLE_OPT_OUT_PHRASES,
    ])
  })

  it('has a phrase list nothing else may shorten silently', () => {
    // The control on the list itself. A single-entry list would satisfy every case above that names one
    // phrase, so the count is asserted and the two entries are named.
    expect([...UNREACHABLE_OPT_OUT_PHRASES]).toEqual(['Reply STOP', 'STOP to'])
  })
})
