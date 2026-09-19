import type { DetectableReviewLanguage } from '@berelax/shared'

/**
 * The house-voice skeletons: every byte a public reply can be made of.
 *
 * docs/07 §4 asks for "template-plus-LLM rather than free generation: a small set of house-voice
 * skeletons with the LLM personalising specifics". This module is the skeletons, and the decision that
 * makes the rest of the unit provable is **what "personalising" is allowed to mean**.
 *
 * ## The model selects; it does not write
 *
 * The model's entire influence over the reply is {@link ReplyAspect} — which of eight things the reply
 * acknowledges — chosen from a closed list. Not one byte of the published reply comes from the model, and
 * therefore not one byte can come from the review. That is the whole prompt-injection defence stated as a
 * data-flow property rather than as a promise about prompt wording: there is no path from the untrusted
 * region to the output, so there is nothing for an instruction inside it to reach.
 *
 * The cost is real and is the right trade here: the model cannot coin a phrase, so a reply cannot
 * mention the specific treatment by name or answer a specific question. What is bought is that every
 * published reply is a sentence a human wrote and signed off, in a business where a reply is a public
 * statement by licensed health-adjacent premises, and where the failure mode of the alternative is a
 * reply that offers a refund or names the therapist who was on shift. docs/07 §4's hard rules are then
 * not things the generator must remember — they are sentences that do not exist in the vocabulary.
 *
 * ## Why aspects rather than one fixed reply per rating
 *
 * "Boilerplate at scale reads as spam to both humans and Google" (docs/07 §4). Four skeletons times two
 * languages times the aspect subsets gives a few hundred distinct replies, which is enough that a
 * listing does not read as a mail-merge, while every one of them is a sentence from this file.
 *
 * ## Determinism
 *
 * Nothing here reads a clock, a random source or an id. The aspects are rendered in the **declared**
 * order rather than the order the model listed them, and capped at {@link MAX_RENDERED_ASPECTS}, so the
 * same review yields the same bytes on every run — which is what makes the approval queue's screenshots
 * diffable, and what makes a change to a reply show up as a change to this file.
 */

/** The eight things a reply may acknowledge. A closed list: the model chooses from it and adds nothing. */
export const REPLY_ASPECTS = [
  'treatment',
  'team',
  'cleanliness',
  'atmosphere',
  'welcome',
  'booking',
  'value',
  'location',
] as const
export type ReplyAspect = (typeof REPLY_ASPECTS)[number]

/**
 * At most two aspects appear in a rendered reply.
 *
 * A reply that lists five things it is glad about reads as generated, which is the failure docs/07 §4
 * names. Two is also what keeps the reply inside the length cap without the cap ever being the binding
 * constraint.
 */
export const MAX_RENDERED_ASPECTS = 2

/** The noun phrase each aspect renders as, per language. House bytes, and the only ones. */
const ASPECT_PHRASES: Readonly<
  Record<ReplyAspect, Readonly<Record<DetectableReviewLanguage, string>>>
> = Object.freeze({
  treatment: { en: 'the treatment itself', ar: 'الجلسة نفسها' },
  // "the team", never a person. There is no aspect that can name an individual, which is how
  // "never disclose a therapist's name or roster" becomes a property of the vocabulary.
  team: { en: 'the care our team took', ar: 'اهتمام فريقنا' },
  cleanliness: { en: 'how clean the rooms are kept', ar: 'نظافة الغرف' },
  atmosphere: { en: 'the calm of the place', ar: 'هدوء المكان' },
  welcome: { en: 'the welcome at reception', ar: 'الاستقبال' },
  booking: { en: 'how the booking went', ar: 'سهولة الحجز' },
  value: { en: 'what the visit was worth', ar: 'قيمة الزيارة' },
  location: { en: 'how easy we are to reach', ar: 'سهولة الوصول إلينا' },
})

/** Every skeleton id, in the order a reader of the file meets them. */
export const REPLY_SKELETONS = [
  'star_only_thanks',
  'positive_thanks',
  'mixed_acknowledgement',
  'low_rating_acknowledgement',
] as const
export type ReplySkeletonId = (typeof REPLY_SKELETONS)[number]

/** The fixed parts of one skeleton in one language. */
export interface SkeletonFrame {
  readonly opening: string
  /** Introduces the aspect list. Absent from the rendering when no aspect was selected. */
  readonly aspectLead: string
  readonly closing: string
}

export interface ReplySkeleton {
  readonly id: ReplySkeletonId
  /** The lowest and highest rating this skeleton is written for, inclusive. */
  readonly ratings: readonly [number, number]
  /**
   * Whether the skeleton is for a review that carries free text.
   *
   * `false` is the star-only case (docs/10 §7 calls it common, and the four- and five-star star-only
   * review is the only shape docs/07 §4 ever permits auto-sending). `true` is everything else.
   */
  readonly hasText: boolean
  readonly frames: Readonly<Record<DetectableReviewLanguage, SkeletonFrame>>
}

/**
 * The four skeletons.
 *
 * The low-rating one exists even though a one- or two-star review is always escalated (docs/07 §4 row 2):
 * escalated means a human approves the reply, not that no draft is offered. An owner facing a one-star
 * review at 23:00 with an empty box writes something worse than an owner editing a sentence that already
 * declines to argue. What the draft must never do is concede anything, which is why its closing moves the
 * conversation off the public listing rather than answering on it.
 */
const SKELETONS: Readonly<Record<ReplySkeletonId, ReplySkeleton>> = Object.freeze({
  star_only_thanks: {
    id: 'star_only_thanks',
    ratings: [4, 5],
    hasText: false,
    frames: {
      en: {
        opening: 'Thank you for the rating.',
        aspectLead: 'It is good to hear about',
        closing: 'We look forward to welcoming you back.',
      },
      ar: {
        opening: 'شكراً لك على التقييم.',
        aspectLead: 'يسعدنا سماع ملاحظاتك عن',
        closing: 'نتطلع إلى استقبالك مرة أخرى.',
      },
    },
  },
  positive_thanks: {
    id: 'positive_thanks',
    ratings: [4, 5],
    hasText: true,
    frames: {
      en: {
        opening: 'Thank you for taking the time to write this.',
        aspectLead: 'It is good to hear about',
        closing: 'We look forward to welcoming you back.',
      },
      ar: {
        opening: 'شكراً لك على وقتك في كتابة هذا التقييم.',
        aspectLead: 'يسعدنا سماع ملاحظاتك عن',
        closing: 'نتطلع إلى استقبالك مرة أخرى.',
      },
    },
  },
  mixed_acknowledgement: {
    id: 'mixed_acknowledgement',
    ratings: [3, 3],
    hasText: true,
    frames: {
      en: {
        opening: 'Thank you for the feedback, which we have read carefully.',
        aspectLead: 'We are glad you valued',
        // No apology and no promise. "We would like to hear more" is an invitation to a private
        // channel; an apology on a public listing is read as an admission whatever it was meant as.
        closing:
          'We would like to hear more, and the front desk can put you through to the manager.',
      },
      ar: {
        opening: 'شكراً لك على ملاحظاتك، وقد قرأناها بعناية.',
        aspectLead: 'يسعدنا أنك قدّرت',
        closing: 'يسعدنا أن نسمع المزيد، ويمكن لمكتب الاستقبال توصيلك بالمسؤول.',
      },
    },
  },
  low_rating_acknowledgement: {
    id: 'low_rating_acknowledgement',
    ratings: [1, 2],
    hasText: true,
    frames: {
      en: {
        opening: 'Thank you for telling us. We take this seriously.',
        aspectLead: 'We are glad you valued',
        closing:
          'Please ask the front desk for the manager so we can look into it with you directly.',
      },
      ar: {
        opening: 'شكراً لإبلاغنا، ونحن نأخذ الأمر بجدية.',
        aspectLead: 'يسعدنا أنك قدّرت',
        closing: 'نرجو أن تطلب المسؤول من مكتب الاستقبال لننظر في الأمر معك مباشرة.',
      },
    },
  },
})

/** Every skeleton, for a test that enumerates them and for an operator-facing list. */
export const REPLY_SKELETON_ROWS: Readonly<Record<ReplySkeletonId, ReplySkeleton>> = SKELETONS

/**
 * Which skeleton a review gets. Total, and `null` only for a rating no skeleton covers.
 *
 * A star-only review below four stars has no skeleton on purpose: there is nothing to acknowledge and
 * nothing to reply to, so the honest answer is that the generator declines and a human decides whether
 * to say anything at all. Returning the low-rating frame instead would publish "we take this seriously"
 * against a review that said nothing.
 */
export function skeletonForReview(args: {
  readonly rating: number
  readonly hasText: boolean
}): ReplySkeletonId | null {
  for (const id of REPLY_SKELETONS) {
    const skeleton = SKELETONS[id]
    const [low, high] = skeleton.ratings
    if (args.rating < low || args.rating > high) continue
    if (skeleton.hasText !== args.hasText) continue
    return id
  }
  return null
}

/** The aspects a skeleton will render, in declared order and capped. Duplicates collapse. */
export function renderableAspects(selected: readonly ReplyAspect[]): readonly ReplyAspect[] {
  const wanted = new Set(selected)
  return REPLY_ASPECTS.filter((aspect) => wanted.has(aspect)).slice(0, MAX_RENDERED_ASPECTS)
}

/** Joins the aspect phrases the way each language joins a short list. */
function joinPhrases(phrases: readonly string[], language: DetectableReviewLanguage): string {
  if (phrases.length <= 1) return phrases[0] ?? ''
  const head = phrases.slice(0, -1).join(language === 'ar' ? '، ' : ', ')
  return `${head}${language === 'ar' ? ' و' : ' and '}${phrases[phrases.length - 1] as string}`
}

/**
 * Renders one reply. A pure function of (skeleton, aspects, language) and nothing else.
 *
 * `renderReplySkeleton` is deliberately the ONLY way a draft comes into existence, and the linter
 * re-runs it to check that a candidate draft is a rendering of a declared skeleton
 * (`not_a_house_skeleton_rendering`). That is what makes the draft's provenance checkable rather than
 * asserted: a draft nobody can reproduce from this function did not come from here.
 */
export function renderReplySkeleton(args: {
  readonly skeleton: ReplySkeletonId
  readonly aspects: readonly ReplyAspect[]
  readonly language: DetectableReviewLanguage
}): string {
  const frame = SKELETONS[args.skeleton].frames[args.language]
  const aspects = renderableAspects(args.aspects)
  const parts: string[] = [frame.opening]
  if (aspects.length > 0) {
    const phrases = aspects.map((aspect) => ASPECT_PHRASES[aspect][args.language])
    parts.push(`${frame.aspectLead} ${joinPhrases(phrases, args.language)}.`)
  }
  parts.push(frame.closing)
  return parts.join(' ')
}
