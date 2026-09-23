import type { HomeCopy } from './content.ts'

/**
 * The home page in Arabic.
 *
 * Total over the same type as the English copy, so a heading added without an Arabic counterpart fails to
 * compile rather than rendering an English sentence on the Arabic document — the failure
 * `app/_routes/nap-copy.ts` records for the NAP labels, applied to the page that has the most copy.
 *
 * The locality is **not** transliterated here, and that absence is deliberate. W-SITE-02 found the Arabic
 * street and district hard-coded in `app/(ar)/layout.tsx` and `app/(ar)/ar/page.tsx` — a second NAP the grep
 * gate could not see, because its patterns are Latin script — and removed both. `premises` holds one
 * spelling of the address and it is the English one, so the Arabic document renders the same row through the
 * same NAP block. An Arabic address would have to come from an Arabic column that does not exist.
 */
export const HOME_COPY_AR: HomeCopy = {
  home: 'الصفحة الرئيسية',
  eyebrow: 'أبوظبي',
  heading: 'بي ريلاكس',
  lede: 'مركز مساج وسبا، يفتح من آخر الصباح حتى الساعات الأولى بعد منتصف الليل.',
  hero: {
    alt: 'السبا، من تصوير المركز نفسه.',
    play: 'تشغيل الفيلم في الخلفية',
    pause: 'إيقاف الفيلم في الخلفية',
  },
  onThisPage: 'في هذه الصفحة',
  sections: {
    about: {
      heading: 'ما هذا المكان',
      lede: 'الاسم الكامل والمنطقة، لأن هناك مركزًا آخر في المدينة يعمل باسم قصير مشابه وليس المركز نفسه.',
    },
    services: {
      heading: 'القائمة',
      lede: 'لكل مساج في القائمة صفحة خاصة به، فيها المدد وسعر كل مدة.',
    },
    team: {
      heading: 'أخصائيو المساج',
      lede:
        'من يعمل هنا. لا يُنشر أي اسم قبل موافقة صاحبه كتابةً وتسجيل هذه الموافقة، لذا تحمل معظم هذه ' +
        'البطاقات رقمًا داخليًا لا اسمًا.',
    },
    gallery: {
      heading: 'الغرف',
      // See the English copy: what the three photographs show is not on record, so this does not say.
      lede: 'المكان، من تصوير المركز نفسه.',
    },
    reviews: {
      heading: 'ما يقوله الزوار',
      lede: 'تقييمات مكتوبة على خرائط جوجل، منقولة كما كُتبت. لا شيء في هذه الصفحة كتبه المركز عن نفسه.',
    },
    contact: {
      heading: 'كيف تجدنا',
      lede: 'العنوان والأرقام وأوقات العمل، من السجل الوحيد الذي يحملها.',
    },
  },
  labels: {
    and: 'و',
    seeTreatment: (name: string) => `${name} — اقرأ المزيد`,
    durationSeparator: ' · ',
    unnamedTherapist: 'الاسم لم يُنشر بعد',
    skills: { asian_style: 'الطريقة الآسيوية', arabic_style: 'الطريقة العربية' },
    skillSeparator: '، ',
    noReviews:
      'لم يُسجَّل أي تقييم في هذا النظام بعد. وعندما يُسجَّل سيظهر هنا منقولًا عن جوجل — فالمركز لا ينشر ' +
      'تقييمات من عنده.',
    reviewBy: (name: string) => `— ${name}، على جوجل`,
    bookBar: 'اتصل للحجز',
    bookBarLabel: (telephone: string) => `اتصل بالرقم ${telephone} للحجز`,
    galleryAlt: (index: number) => `صورة من داخل السبا، من تصوير المركز نفسه (${index} من 3).`,
    menuSize: (services: number, pricePoints: number) =>
      `${services} أنواع مساج في القائمة، و${pricePoints} مدة بأسعارها.`,
    rosterSize: (therapists: number) => `${therapists} شخصًا على جدول العمل.`,
  },
}
