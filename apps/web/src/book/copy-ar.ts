/**
 * `/book` in Arabic.
 *
 * Not a translation pass over `copy-en.ts` — the same page written in Arabic, with two things that only
 * matter here:
 *
 * **The figures stay Latin.** docs/08 §7 chose `ar-AE-u-nu-latn`, which is UAE commercial practice: a price
 * and a clock time are read in Latin digits on an Arabic page, and `formatAmount` and `wallClock` both
 * produce exactly one spelling for both documents. So a duration and an amount are interpolated as they
 * arrive and never re-formatted here.
 *
 * **Nothing is tracked and nothing is uppercased.** Those are stylesheet rules (`theme/arabic.css`), and
 * they are the reason no label here carries a typographic decision: this file is words.
 */

import type { BookCopy } from './copy.ts'

export const BOOK_COPY_AR: BookCopy = {
  title: 'احجز جلستك',
  lede: 'اختر الجلسة، ثم اليوم والوقت. لا يتم تأكيد أي حجز قبل الخطوة الأخيرة، ولا حاجة لإنشاء حساب.',

  choose: {
    treatmentLegend: 'الجلسة ومدتها',
    treatmentLabel: 'الجلسة',
    treatmentPlaceholder: 'اختر الجلسة',
    variantOption: (name, minutes, amount) => `${name} — ${minutes} دقيقة — ${amount} درهم`,
    genderLegend: 'لمن هذه الجلسة',
    genderLabel: 'الضيف',
    genderNote:
      'الجلسات تُقدَّم من معالج من نفس الجنس، لذلك تعتمد الأوقات المتاحة على هذه الإجابة. ' +
      'تُستخدم لحساب التوفر فقط ولا يتم الاحتفاظ بها بعد الحجز.',
    genderPlaceholder: 'اختر',
    female: 'سيدة',
    male: 'رجل',
    therapistLegend: 'المعالج',
    anyTherapist: 'أي معالج متاح',
    unnamedTherapist: 'لم يُنشر الاسم بعد',
    noPublishedTherapists:
      'لا يوجد معالج له صفحة منشورة بعد، لذلك لا يمكن الاختيار بالاسم. كل جلسة يقدمها معالج مؤهل لها.',
    chosenTherapist: (label) => `طلبت ${label}.`,
    clearTherapist: 'أي معالج بدلاً من ذلك',
    submit: 'اعرض الأوقات',
  },

  picker: {
    daysLabel: 'الأيام',
    timesLabel: (day) => `أوقات البداية في ${day}`,
    groups: { morning: 'صباحًا', afternoon: 'بعد الظهر', evening: 'مساءً' },
    groupLabel: (group, day) => `أوقات ${group} في ${day}`,
    slotLabel: (time, day, minutes) => `${time} في ${day}، ${minutes} دقيقة`,
    announceDay: (day) => `تُعرض الأوقات المتاحة في ${day}.`,
    heading: (day) => `أوقات ${day}`,
    count: (count) => (count === 1 ? 'وقت واحد متاح' : `${count} أوقات متاحة`),
  },

  chosen: {
    heading: 'اختيارك',
    summary: (time, day, treatment) => `${treatment} في ${time} يوم ${day}.`,
    next:
      'الخطوة التالية تطلب رقم هاتفك وترسل رمز تأكيد. لم تُبنَ هذه الخطوة بعد، ' +
      'لذلك لم يُحجز شيء باختيار وقت هنا.',
    callInstead: (phone) => `اتصل بالاستقبال على ${phone}`,
  },

  needs: {
    treatment: 'اختر الجلسة ومدتها، وستظهر الأوقات المتاحة هنا.',
    gender: 'أخبرنا لمن هذه الجلسة، وستظهر أوقات معالج من نفس الجنس هنا.',
    noTradingDays: 'لا يوجد يوم في التقويم يمكننا استلام حجز له بعد. يرجى الاتصال بالاستقبال.',
    noTreatments: 'لا توجد جلسة قابلة للحجز عبر الموقع حاليًا. يرجى الاتصال بالاستقبال.',
  },

  none: {
    heading: (day) => `لا يوجد وقت متاح في ${day}`,
    lede: 'كل أوقات ذلك اليوم محجوزة. وهذا ما بقي متاحًا.',
    nearestHeading: 'أقرب الأيام التي بها متسع',
    nearestEmpty: 'لا يوجد يوم خلال أسبوع من ذلك اليوم به متسع لهذه الجلسة.',
    nearestDay: (day, count, time) =>
      `${day} — ${count === 1 ? 'وقت واحد' : `${count} أوقات`} متاح، من ${time}`,
    therapistsHeading: 'نفس الجلسة مع معالج آخر',
    therapistsEmpty: 'اليوم محجوز بالكامل لكل المعالجين، وليس فقط للمعالج الذي طلبته.',
    therapistOption: (label, count, time) =>
      `${label} — ${count === 1 ? 'وقت واحد' : `${count} أوقات`} متاح، من ${time}`,
    waitlistHeading: 'انتظر إلغاءً',
    waitlistLede: 'الإلغاءات تحدث. انضم إلى قائمة الانتظار لهذا اليوم وسنرسل لك رسالة إن تحرر وقت.',
    waitlistCta: 'انضم إلى قائمة الانتظار',
    waitlistReasons: {
      not_a_trading_date: 'المركز مغلق في ذلك اليوم، فلا شيء لانتظاره.',
      variant_not_found: 'هذه الجلسة لم تبق على القائمة.',
      shape_not_offered: 'هذه الجلسة لا تُقدَّم بالشكل الذي طلبته.',
      no_compatible_room_type: 'لا توجد غرفة عندنا تناسب هذه الجلسة.',
      requires_client_gender: 'أخبرنا أولًا لمن هذه الجلسة.',
      slots_are_available: 'ذلك اليوم به متسع، فلا شيء لانتظاره.',
    },
    waitlistAlready: 'أنت مسجل بالفعل في قائمة انتظار هذا اليوم.',
  },

  waitlistStep: {
    heading: 'انتظر إلغاءً',
    lede:
      'نحتاج رقم هاتف لنرسل إليه. الخطوة التي تجمعه لم تُبنَ بعد، لذلك لم يُضف شيء إلى القائمة — ' +
      'ويمكن للاستقبال إضافتك الآن هاتفيًا.',
    back: 'العودة إلى الأوقات',
  },
}
