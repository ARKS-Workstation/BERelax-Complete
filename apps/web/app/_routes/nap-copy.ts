import type { NapBlockCopy } from '@berelax/ui/patterns'

/**
 * The NAP block's labels, per locale. Labels only — never a fact.
 *
 * `NapBlock` renders the `/api/facts` payload and owns none of its own words, for the reason every pattern
 * in `@berelax/ui/patterns` gives: copy belongs to the route, because the route is the locale. `(en)` and
 * `(ar)` are two documents with two root layouts, not one document with a toggle.
 *
 * Both sets live in one module rather than beside each page so that a label added to `NapBlockCopy` fails to
 * compile in both locales at once. The alternative — Arabic copy in the Arabic page — is how a new field
 * ends up rendered in English on the Arabic document, which no test would catch and no English-reading
 * reviewer would see.
 *
 * `dayNames` is index 0 = Sunday, matching `premises_hours.day_of_week`. Not the reader's week start: a list
 * beginning on Monday shifts the whole schedule by a day, and the symptom looks like a data problem.
 *
 * It was `app/_dev/nap-copy.ts` until W-SITE-07 and moved here unchanged. The kitchen sink was the only
 * surface rendering the block, which made `_dev` the right home for one unit; `/contact` and `/spa` are the
 * two routes docs/09 §4 actually names for it, and a public page importing its labels out of a folder called
 * `_dev` reads as a development shortcut rather than as the shared copy it is.
 */
export const NAP_COPY_EN: NapBlockCopy = {
  addressHeading: 'Where we are',
  hoursHeading: 'When we are open',
  dayNames: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  dayRangeSeparator: ' to ',
  everyDay: 'Every day',
  sessionSeparator: ' until ',
  closesNextDay: '(the following day)',
  closedLabel: 'Closed',
  callLabel: 'Call',
  mapLabel: 'See it on a map',
  directionsLabel: 'Get directions',
  alsoKnownAs: 'Also known as',
  whatsappUnconfirmed:
    'No WhatsApp number is published. Two different ones appear on the older web properties of ' +
    'this business and neither has been confirmed, so the numbers above are the ones to use.',
}

export const NAP_COPY_AR: NapBlockCopy = {
  addressHeading: 'موقعنا',
  hoursHeading: 'أوقات العمل',
  dayNames: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
  dayRangeSeparator: ' إلى ',
  everyDay: 'كل يوم',
  sessionSeparator: ' حتى ',
  closesNextDay: '(في اليوم التالي)',
  closedLabel: 'مغلق',
  callLabel: 'اتصل',
  mapLabel: 'الموقع على الخريطة',
  directionsLabel: 'الحصول على الاتجاهات',
  alsoKnownAs: 'ويُعرف أيضًا باسم',
  whatsappUnconfirmed:
    'لم يُنشر رقم واتساب. يظهر رقمان مختلفان على المواقع الأقدم لهذا المركز ولم يُؤكَّد أيٌّ منهما، ' +
    'لذا يُرجى استخدام الأرقام أعلاه.',
}
