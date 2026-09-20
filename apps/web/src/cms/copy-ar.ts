/**
 * The Arabic copy for `/ar/spa`, `/ar/contact`, `/ar/about`, `/ar/faq` and `/ar/journal`.
 *
 * The same structure rendered by the same components with the same anchor ids: `/ar/spa#where-do-i-park` and
 * `/spa#where-do-i-park` are the same anchor on two documents, because the id comes from the key and never
 * from the copy.
 *
 * ## What arrives in this document in English, and why
 *
 * Three kinds of value: the address (`premises` holds one spelling and it is the English one — W-SITE-02
 * deleted an Arabic address rather than assert one no column holds), the free-text notes the owner writes
 * (`parking_notes`, `directions_notes` — one column, one language), and a service name
 * (`public_display_name`, which is also what the `Offer` JSON-LD publishes). W-SITE-05 took the same decision
 * for the same reason and recorded it: an Arabic rendering invented here would be a second, unlinted name for
 * the same thing, disagreeing with the schema block beside it. The Arabic sentences carry those values
 * rather than translating them.
 *
 * ## What the banned-claims lint does and does not see here
 *
 * `lexiconTokens` splits on `/[^a-z0-9]+/`, so Arabic script contributes no tokens at all: the lint judges
 * the Latin values interpolated into these sentences and nothing else. That is the scope B-CAT-05's lexicon
 * states for itself ("Latin-script names") and it is a real gap rather than a resolved one — an Arabic
 * health claim written by an editor would pass. Closing it needs an Arabic claim lexicon, which is a
 * decision about vocabulary rather than code; the escalation lexicon's Arabic half (G-REV-03) is the
 * nearest thing that exists and it answers a different question. Deferred to W-SITE-10, which owns the
 * Arabic narrative.
 */
import type { Facts } from '@berelax/shared'
import {
  areaPhrase,
  bookingPhones,
  buildingParts,
  type ContentCopy,
  type FactsAnswerInput,
  tradingWindowOf,
} from './content.ts'

function openingSentence(facts: Facts): string {
  const open = facts.hours.weekly.filter((day) => !day.isClosed)
  const window = tradingWindowOf(facts)
  if (window === '' || open.length === 0) {
    return 'لا توجد أوقات عمل مسجلة للمكان بعد.'
  }
  const every =
    open.length === facts.hours.weekly.length ? 'كل يوم' : `${open.length} أيام في الأسبوع`
  const midnight = facts.hours.crossesMidnight
    ? ' الإغلاق بعد منتصف الليل، فالحجز في الواحدة والنصف يُحسب على اليوم السابق.'
    : ''
  return `${window}، ${every}، بالتوقيت المحلي في ${facts.hours.timezone}.${midnight}`
}

/** `oneLine` already carries the building and the floor; see the English copy on why nothing is appended. */
function addressSentence(facts: Facts): string {
  return `${facts.names.display}، ${facts.address.oneLine}.`
}

/** What to look for on arrival: the building and floor from the row, and the owner's note if there is one. */
function arrivalSentence(facts: Facts): string {
  const building = buildingParts(facts)
  const look = building.length === 0 ? '' : `ابحث عن ${building.join('، ')}. `
  const note =
    facts.directionsNotes ??
    'لا توجد ملاحظة وصول أخرى مسجلة للمكان، فلا يُنشر شيء عنها. الرابطان أدناه يفتحان العنوان نفسه ' +
      'الذي يعمل به المكتب.'
  return `${look}${note}`
}

function contactSentence(facts: Facts): string {
  const phones = bookingPhones(facts)
  if (phones.length === 0) {
    return 'لا يوجد رقم هاتف مسجل للمكان بعد.'
  }
  const whatsapp =
    facts.contact.whatsapp.status === 'unconfirmed'
      ? ' لا يُنشر رقم واتساب: يظهر رقمان مختلفان على المواقع القديمة لهذا العمل ولم يُؤكد أي منهما، فلا يُنشر أي رقم هنا.'
      : ` واتساب: ${facts.contact.whatsapp.display}.`
  const email = facts.contact.email === null ? '' : ` البريد الإلكتروني: ${facts.contact.email}.`
  return `اتصل بالمكتب على ${phones.join(' أو ')}.${whatsapp}${email}`
}

const NOT_RECORDED = 'هذا غير مسجل للمكان بعد، فلا يُنشر عنه شيء.'

export const CONTENT_COPY_AR: ContentCopy = {
  home: 'الصفحة الرئيسية',
  spa: {
    title: 'السبا',
    lede: 'أين يقع، وكيف تصل إليه، ومتى تُفتح الأبواب.',
    questions: {
      'where-is-it': 'أين يقع السبا؟',
      'how-do-i-get-in': 'كيف أدخل؟',
      'where-do-i-park': 'أين أوقف سيارتي؟',
      'how-do-i-get-here-without-a-car': 'كيف أصل بدون سيارة؟',
      'what-are-the-rooms-like': 'كيف هي الغرف؟',
      'when-is-it-open': 'ما هي أوقات العمل؟',
    },
    answers: {
      'where-is-it': ({ facts }: FactsAnswerInput) =>
        `${addressSentence(facts)} الحي هو ${areaPhrase(facts, 'و')}، في ${facts.address.emirate}.`,
      'how-do-i-get-in': ({ facts }: FactsAnswerInput) => arrivalSentence(facts),
      'where-do-i-park': ({ facts }: FactsAnswerInput) => facts.parkingNotes ?? NOT_RECORDED,
      'how-do-i-get-here-without-a-car': () =>
        'لا يُنشر شيء عن الحافلات أو أقرب المعالم. سجل الموقع لا يحتوي على حقل لأي منهما، وخط حافلات ' +
        'مكتوب من الذاكرة أسوأ من لا شيء: سيقف القارئ في المكان الخطأ. العنوان ورابط الخريطة أعلاه هما ' +
        'ما يقوله المكتب على الهاتف.',
      'what-are-the-rooms-like': () =>
        'لا تُوصف الغرف هنا بعد. الجرد المسجل مؤقت، وعدد غرف لا يستطيع المكتب الالتزام به يكون وعدًا ' +
        'وليس حقيقة.',
      'when-is-it-open': ({ facts }: FactsAnswerInput) => openingSentence(facts),
    },
  },
  contact: {
    title: 'اتصل بنا',
    lede: 'المكتب والعنوان والأوقات التي يوجد فيها من يجيب.',
    questions: {
      'how-do-i-reach-the-desk': 'كيف أتصل بالمكتب؟',
      'where-is-it': 'أين يقع السبا؟',
      'when-can-i-call': 'متى يمكنني الاتصال؟',
      'how-do-i-get-directions': 'كيف أحصل على الاتجاهات؟',
    },
    answers: {
      'how-do-i-reach-the-desk': ({ facts }: FactsAnswerInput) => contactSentence(facts),
      'where-is-it': ({ facts }: FactsAnswerInput) =>
        `${addressSentence(facts)} الحي هو ${areaPhrase(facts, 'و')}.`,
      'when-can-i-call': ({ facts }: FactsAnswerInput) => openingSentence(facts),
      'how-do-i-get-directions': ({ facts }: FactsAnswerInput) =>
        `الرابطان أدناه يفتحان ${facts.address.oneLine} على الخريطة وكمسار من مكانك. كلاهما مبني من سجل ` +
        'العنوان نفسه الذي يقوله المكتب على الهاتف.',
    },
  },
  about: {
    title: 'عن المكان',
    lede: 'ما هذا المكان، وأين يقع، وكيف تميزه عن سبا المطار.',
    questions: {
      'what-is-this-place': 'ما هذا المكان؟',
      'where-is-it': 'أين يقع؟',
      'what-is-on-the-menu': 'ما الموجود في القائمة؟',
      'how-do-i-know-it-is-the-right-place': 'كيف أعرف أنه المكان الصحيح؟',
    },
    answers: {
      'what-is-this-place': ({ facts }: FactsAnswerInput) =>
        `${facts.names.display} هو مركز مساج وسبا في ${areaPhrase(facts, 'و')}، ` +
        `${facts.address.emirate}. يعمل تجاريًا باسم ${facts.names.trading} والكيان المسجل هو ` +
        `${facts.names.legal}.`,
      'where-is-it': ({ facts }: FactsAnswerInput) => addressSentence(facts),
      'what-is-on-the-menu': ({ facts }: FactsAnswerInput) =>
        `${facts.catalogue.services.length} أنواع مساج، لكل منها عدة مدد: ` +
        `${facts.catalogue.pricePointCount} سعرًا بينها، كلها بعملة ${facts.catalogue.currency} وكلها ` +
        'شاملة ضريبة القيمة المضافة. القائمة وقائمة الأسعار الكاملة مرتبطتان أدناه.',
      'how-do-i-know-it-is-the-right-place': ({ facts }: FactsAnswerInput) =>
        `بالاسم الكامل والعنوان: ${facts.names.display}، ${facts.address.oneLine}. توجد سلسلة سبا ` +
        'مطارات دولية تعمل باسم قصير مشابه ولها فرع في مطار هذه المدينة، فالاسم القصير وحده لا يحدد ' +
        'أيًا منا. كل صفحة هنا تحمل الاسم الكامل، وورقة الحقائق المقروءة آليًا تحمل العنوان الذي ينتمي إليه.',
    },
  },
  journal: {
    title: 'المدونة',
    lede: 'ملاحظات عن الزيارة والحجز وما يحدث في الغرفة.',
    questions: {
      'what-is-in-the-journal': 'ما الموجود في المدونة؟',
      'who-writes-it': 'من يكتبها؟',
      'where-do-i-start': 'من أين أبدأ؟',
    },
    answers: {
      'what-is-in-the-journal': ({ posts }) =>
        posts.length === 0
          ? 'لا شيء بعد. لم يُنشر أي مقال، والقائمة الفارغة هي الحال الصادقة بدلًا من صفحة مملوءة بكلام ' +
            'لم يوقعه أحد.'
          : `${posts.length} مقالًا، الأحدث أولًا.`,
      'who-writes-it': () =>
        'كل مقال يحمل اسم من كتبه واسم من راجعه وتاريخ نشره. المقال الذي ينقصه أي من الثلاثة لا يُنشر — ' +
        'يرفضه الفحص بالاسم — واسم كاتب لشخص غير موجود أسوأ من اسم ناقص.',
      'where-do-i-start': ({ facts }) =>
        `القائمة هي نقطة البداية: ${facts.catalogue.services.length} أنواع مساج بكل المدد وكل الأسعار. ` +
        'وهي مرتبطة أدناه.',
    },
  },
  faq: {
    title: 'أسئلة وأجوبة',
    lede: 'الأسئلة التي تُطرح على المكتب أكثر من غيرها.',
    empty:
      'لم تُنشر أي أسئلة بعد. تُكتب في لوحة الإدارة وتظهر هنا، وفي مجموعة الأجوبة المقروءة آليًا، في ' +
      'اللحظة نفسها — حتى لا يختلف ما يقرأه الزائر عما يقتبسه المساعد الآلي.',
  },
  labels: {
    menu: 'القائمة',
    prices: 'الأسعار',
    faq: 'أسئلة وأجوبة',
    spa: 'السبا',
    contact: 'اتصل بنا',
    about: 'عن المكان',
    journal: 'المدونة',
    map: 'افتح العنوان على الخريطة',
    directions: 'احصل على الاتجاهات إلى الباب',
    nav: 'الصفحات',
    healthNote: 'ملاحظة صحية',
    journalEmpty: 'لم يُنشر أي مقال بعد.',
    byline: (name) => `كتبه ${name}`,
    reviewedBy: (name) => `راجعه ${name}`,
    publishedOn: (date) => `نُشر في ${date}`,
    notRecorded: NOT_RECORDED,
  },
}
