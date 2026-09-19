/**
 * The Arabic copy for the catalogue-derived pages.
 *
 * The same templates as `copy-en.ts`, in Arabic, and the same rule: every value is interpolated from the
 * fact sheet and nothing here states a fact of its own. What is worth recording is the two things this file
 * deliberately does **not** translate.
 *
 * **The treatment names.** `service.public_display_name` is one column with one value (docs/13 §4 prints the
 * menu in English), and it is the value the lexicon lint has passed and the value the `Offer` JSON-LD
 * publishes. An Arabic rendering of it here would be a second name for the same treatment, unlinted,
 * disagreeing with the schema block on the same page — and it would be this file's invention rather than the
 * business's. The Arabic page therefore shows the catalogue's name inside Arabic sentences, which is what an
 * Arabic-language menu in this market does anyway. The translated name arrives with the `service_narrative`
 * CMS collection, where an editor writes it and the publication lint reads it (W-SITE-10).
 *
 * **The figures.** docs/08 §7 chose Latin numerals for Arabic (`ar-AE-u-nu-latn`), which is UAE commercial
 * practice, so `formatAmount` produces the same string on both documents. Nothing here reformats a number.
 */
import type { Facts } from '@berelax/shared'
import {
  type AnswerInput,
  bookingPhones,
  type MenuCopy,
  priceRangeOf,
  priceSentenceFor,
  type TreatmentCopy,
  tradingWindowOf,
} from './content.ts'

/** The style as an Arabic reader sees it. A `Record` over the enum, for `copy-en.ts`'s reason. */
const STYLE_LABEL: Readonly<Record<string, string>> = { asian: 'آسيوي', arabic: 'عربي' }

const styleOf = (style: string): string => STYLE_LABEL[style] ?? style

/** "45 أو 60 أو 90 أو 120 دقيقة" — the durations, from the rows. */
function durationList(input: AnswerInput): string {
  const minutes = input.service.variants.map((variant) => variant.durationMinutes)
  return `${minutes.join(' أو ')} دقيقة`
}

function tradingSentence(facts: Facts): string {
  const open = facts.hours.weekly.filter((day) => !day.isClosed)
  const window = tradingWindowOf(facts)
  const uniform = open.length === facts.hours.weekly.length && open.length > 0
  const every = uniform ? 'كل أيام الأسبوع' : `${open.length} أيام في الأسبوع`
  const midnight = facts.hours.crossesMidnight
    ? ' الإغلاق بعد منتصف الليل، لذا يُحسب الموعد في الساعة 01:30 على يوم العمل السابق.'
    : ''
  return `${window}، ${every}، بالتوقيت المحلي (${facts.hours.timezone}).${midnight}`
}

export const TREATMENT_COPY_AR: TreatmentCopy = {
  home: 'الصفحة الرئيسية',
  index: 'الجلسات',
  questions: {
    'what-is-it': 'ما هذه الجلسة؟',
    'how-long-does-it-take': 'كم تستغرق من الوقت؟',
    'how-much-does-it-cost': 'كم سعرها؟',
    'where-is-it-delivered': 'أين تُقدَّم؟',
    'when-can-i-book-it': 'متى يمكنني الحجز؟',
    'how-do-i-book-it': 'كيف أحجز؟',
  },
  answers: {
    'what-is-it': (input) =>
      `«${input.service.name}» مدرجة في قائمة ${input.facts.names.display}، بالأسلوب ` +
      `${styleOf(input.service.style)}، وبـ${input.service.variants.length} مدد مختلفة.`,
    'how-long-does-it-take': (input) =>
      `تُحجز بمدة ${durationList(input)}. المدة هي العامل الوحيد الذي يغيّر السعر: صفحة واحدة للجلسة ` +
      'وسطر لكل مدة.',
    'how-much-does-it-cost': (input) => {
      const { cheapest, dearest } = priceRangeOf(input.service)
      return (
        `من ${priceSentenceFor(cheapest, input.locale)} لمدة ${cheapest.durationMinutes} دقيقة إلى ` +
        `${priceSentenceFor(dearest, input.locale)} لمدة ${dearest.durationMinutes} دقيقة. جميع ` +
        'المبالغ إجمالية وتشمل ضريبة القيمة المضافة.'
      )
    },
    'where-is-it-delivered': (input) =>
      `في ${input.facts.names.display}، ${input.facts.address.oneLine}. ويُكتب اسم المنطقة أيضًا ` +
      `${input.facts.address.areaAliases.join(' و')}.`,
    'when-can-i-book-it': (input) => tradingSentence(input.facts),
    'how-do-i-book-it': (input) => {
      const phones = bookingPhones(input.facts)
      if (phones.length === 0) return 'لا يوجد رقم هاتف مسجَّل للمركز بعد.'
      return `اتصل بالاستقبال على ${phones.join(' أو ')} وحدِّد المدة التي تريدها.`
    },
  },
  table: {
    caption: (name) => `${name} — كل المدد وأسعارها`,
    duration: 'المدة',
    amount: 'السعر (درهم، شامل ضريبة القيمة المضافة)',
  },
  durationLabel: (minutes) => `${minutes} دقيقة`,
  seeTreatment: (name) => `اطّلع على ${name}`,
  seeAllPrices: 'اطّلع على جميع الأسعار',
  priceOnRequest: 'السعر عند الطلب',
}

export const MENU_COPY_AR: MenuCopy = {
  home: 'الصفحة الرئيسية',
  title: 'الجلسات',
  lede: 'كل الجلسات المدرجة في القائمة، وسعر كل مدة.',
  pricingTitle: 'الأسعار',
  pricingLede: 'كل مدة من كل جلسة، بمبلغ إجمالي شامل ضريبة القيمة المضافة، كما يتقاضاه الاستقبال.',
  questions: {
    'what-is-on-the-menu': 'ما المدرج في القائمة؟',
    'how-is-a-price-decided': 'كيف يُحدَّد السعر؟',
    'what-is-priced-on-request': 'ما الذي يكون سعره عند الطلب؟',
  },
  answers: {
    'what-is-on-the-menu': (facts) =>
      `${facts.catalogue.services.length} جلسات، لكل منها أسلوب واحد، وبينها ` +
      `${facts.catalogue.pricePointCount} سعرًا: سعر لكل مدة من كل جلسة.`,
    'how-is-a-price-decided': (facts) =>
      `المدة هي التي تحدِّده. جميع الأسعار بعملة ${facts.catalogue.currency}، إجمالية وشاملة ضريبة ` +
      'القيمة المضافة، وهي المبلغ الذي يتقاضاه الاستقبال.',
    'what-is-priced-on-request': (facts) =>
      facts.catalogue.onRequest.length === 0
        ? 'لا شيء: لكل جلسة في القائمة سعر لكل مدة.'
        : `${facts.catalogue.onRequest.map((offering) => offering.label).join('، ')} — ` +
          'تُرتَّب هذه عند الاستقبال، لأن السعر يتوقف على طريقة تنظيم العمل ولم يُحدَّد له مبلغ بعد.',
  },
  table: {
    caption: (count) => `${count} سعرًا: كل جلسة بكل مدة`,
    duration: 'المدة',
    amount: 'السعر (درهم، شامل ضريبة القيمة المضافة)',
  },
  durationLabel: (minutes) => `${minutes} دقيقة`,
  seeTreatment: (name) => `اطّلع على ${name}`,
  priceOnRequest: 'السعر عند الطلب',
}
