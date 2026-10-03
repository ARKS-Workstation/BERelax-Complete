import type { TherapistsCopy } from './copy-shape.ts'

/** The therapist pages, in Arabic. The same mechanism, said once per language. */
export const THERAPISTS_COPY_AR: TherapistsCopy = {
  home: 'الصفحة الرئيسية',
  index: {
    title: 'المعالجون',
    lede:
      'كل معالج في المركز. تُنشر صفحة خاصة بالمعالج بعد أن يحدّد الاسم الذي يرغب في نشره ويمنح موافقته ' +
      'على التصوير؛ وحتى ذلك الحين تظهر البطاقة بدون اسم وبدون رابط.',
    empty: 'لا أحد على القائمة.',
    unnamedTherapist: 'الاسم لم يُنشر بعد',
    provisionalPortrait: 'الصورة قيد الإعداد',
  },
  detail: {
    specialisms: 'مدرَّب على',
    languages: 'يتحدث',
    languagesUnknown: 'لم تُسجَّل أي لغة لهذا المعالج بعد.',
    availability: 'أقرب موعد متاح',
    bookWith: (name: string) => `احجز مع ${name}`,
    noVariant: 'لا يوجد في القائمة ما يطابق تدريب هذا المعالج.',
    alternatives: {
      title: 'لا أوقات متاحة',
      lede: 'ثلاث طرق للمتابعة، بدلاً من قائمة فارغة.',
      nearestDays: 'أقرب الأيام التي بها متاح',
      otherTherapists: 'نفس الجلسة مع معالج آخر',
      waitlist: 'انضم إلى قائمة الانتظار لهذا اليوم',
      waitlistRefused: (reason: string) => `الانضمام إلى قائمة الانتظار غير متاح: ${reason}.`,
      noDays: 'لا يوجد يوم متاح خلال الأسبوعين السابقين أو التاليين.',
      noTherapists: 'لا يوجد معالج آخر متاح في هذا اليوم.',
    },
  },
  skills: { asian_style: 'مساج بالأسلوب الآسيوي', arabic_style: 'مساج بالأسلوب العربي' },
  skillJoin: ' و',
}
