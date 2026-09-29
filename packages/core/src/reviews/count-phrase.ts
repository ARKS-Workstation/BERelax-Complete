import { AppError, type DetectableReviewLanguage } from '@berelax/shared'

/**
 * *"2 new reviews"* — the one phrase the count tripwire's email is about, in both languages.
 *
 * ## Why this is a function and not a template variable holding a number
 *
 * Because `{{count}} new reviews` reads *"1 new reviews"*, and the tripwire fires on an increase of one more
 * often than on any other number. A message about a review that says *1 new reviews* is the kind of thing
 * that makes an owner stop trusting the system that sent it, and there is no way to fix it inside a template:
 * the template engine substitutes values, it does not decline noun endings.
 *
 * So the template declares one variable and this function renders the phrase. The template is still the place
 * the sentence around it lives, which is what keeps the copy editable without a deploy.
 *
 * ## Why Arabic is four cases and not two
 *
 * Because Arabic counts in four: one, two (the dual, which is its own form and not a plural), three to ten
 * (a plural noun), and eleven upwards (an accusative singular). English has two. Rendering the English shape
 * into Arabic would produce *"2 تقييمات"*, which is the mistake a reader notices immediately and which no
 * test that only ever passes 2 would catch — so the cases are enumerated and every one of them is asserted.
 *
 * This is grammar, not a business rule: nothing here decides anything about the business, and no figure in it
 * is a value somebody has to confirm.
 *
 * Pure: a count and a language in, a string out. No clock, no locale lookup, no `Intl` — the whole of
 * `packages/core/src/reviews/` is under a scoped rule that bans both.
 */
export function reviewCountPhrase(count: number, language: DetectableReviewLanguage): string {
  if (!Number.isInteger(count) || count < 1) {
    // Refused rather than rendered. The tripwire only ever sends on an increase, so a phrase for zero or a
    // negative number would be a sentence describing something that cannot have happened — and an email
    // reading "0 new reviews" is the one this pass must never send.
    throw new AppError(
      'validation',
      `A new-review phrase needs a positive whole count, received ${String(count)}`,
    )
  }
  if (language === 'ar') return arabicPhrase(count)
  return count === 1 ? '1 new review' : `${count} new reviews`
}

/** The four Arabic cases, in the order the grammar applies them. */
function arabicPhrase(count: number): string {
  if (count === 1) return 'تقييم جديد واحد'
  if (count === 2) return 'تقييمان جديدان'
  if (count <= 10) return `${count} تقييمات جديدة`
  return `${count} تقييماً جديداً`
}
