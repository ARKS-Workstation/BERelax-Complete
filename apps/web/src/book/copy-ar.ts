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
      'لم يُحجز شيء بعد. الخطوة التالية تطلب رقم هاتفك وترسل إليه رمزًا للتأكيد، ' +
      'ثم تختار أنت إن كنت تريد الحجز.',
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
    lede: 'نحتاج رقم هاتف لنرسل إليه رسالة. أكّد رقمك أدناه وسنضيفك إلى قائمة انتظار هذا اليوم.',
    back: 'العودة إلى الأوقات',
  },

  details: {
    heading: 'رقم هاتفك',
    lede: 'نرسل إليك رمزًا لتأكيد الرقم، ثم نعرض لك ما أنت على وشك حجزه. لا حساب ولا كلمة مرور.',
    phoneLabel: 'رقم الجوال',
    // لا مثال لرقم: الرقم الذي يبدو معقولًا يملكه شخص ما فعلًا (قاعدة 15 في الدليل).
    phoneHint: 'رقم جوال إماراتي، بأي صيغة تكتبها. نحن نوحّدها.',
    countryLabel: 'الدولة',
    why:
      'الرقم هو ما نعرفك به، وما نرسل إليه التأكيد، وما يتصل به الاستقبال إن تغيّر شيء. ' +
      'ولا يُستخدم للعروض إلا إذا طلبت ذلك في الخطوة التالية.',
    submit: 'أرسل لي رمزًا',
    back: 'العودة إلى الأوقات',
  },

  otp: {
    heading: 'أدخل الرمز',
    lede: (phone) => `أرسلنا رمزًا إلى ${phone}.`,
    codeLabel: 'الرمز',
    codeHint: (digits) => `${digits} أرقام، من الرسالة النصية.`,
    submit: 'تأكيد الرقم',
    resend: 'أرسل رمزًا آخر',
    resendIn: (seconds) =>
      seconds === '1' ? 'رمز آخر بعد ثانية واحدة' : `رمز آخر بعد ${seconds} ثانية`,
    notArrived: 'الرمز لم يصل',
    changeNumber: 'استخدم رقمًا آخر',
  },

  confirm: {
    heading: 'أكّد حجزك',
    summary: (time, day, treatment, minutes) =>
      `${treatment}، ${minutes} دقيقة، في ${time} يوم ${day}.`,
    priceLine: (amount) => `${amount} درهم، شاملة ضريبة القيمة المضافة.`,
    phoneLine: (phone) => `الرقم المؤكَّد: ${phone}`,
    submit: 'احجز هذا الوقت',
    back: 'تغيير الوقت',
    consentHeading: 'العروض والأخبار',
    consentLede:
      'اختياري، ولا يؤثر شيء هنا على حجزك. اتركه غير مُعلَّم ولن نرسل إليك إلا ما يتعلق بهذا الموعد.',
    consentVersion: (purpose, version) => `${purpose} — نسخة النص ${version}`,
    consentUnavailable:
      'لا يوجد نص معتمد لهذا بعد، لذلك لا نسأل. يمكنك الموافقة لاحقًا عند الاستقبال.',
    checkInstead: 'لست متأكدًا إن تم الحجز؟',
  },

  booked: {
    heading: 'تم الحجز',
    lede: 'أرسلنا إليك رسالة تأكيد. يرجى الحضور عشر دقائق قبل موعدك.',
    reference: (id) => `الرقم المرجعي ${id}`,
    summary: (time, day) => `${time} يوم ${day}.`,
    addToCalendar: 'أضف إلى التقويم',
    calendarNote:
      'موعد التقويم يذكر الوقت والمكان فقط. أي تفصيل أكثر سيظهر على شاشة القفل لمن يحمل هاتفك.',
    manageHeading: 'التغيير أو الإلغاء',
    manageLede:
      'صفحة الخدمة الذاتية لم تُبنَ بعد، لذلك يمرّ التغيير عبر الاستقبال. اذكر الرقم المرجعي أعلاه وسننقل الموعد.',
    bookAnother: 'احجز جلسة أخرى',
  },

  waitlistJoin: {
    heading: 'انضم إلى قائمة الانتظار',
    lede: (day) => `سنرسل إليك رسالة إن تحرر وقت في ${day}. الانضمام لا يحجز شيئًا ولا يكلّف شيئًا.`,
    submit: 'أضفني إلى القائمة',
    back: 'العودة إلى الأوقات',
  },

  waitlisted: {
    heading: 'أنت على القائمة',
    lede: (day) =>
      `إن تحرر وقت في ${day} سنرسل إليك رسالة. ويمكنك حجز يوم آخر في الأثناء — ` +
      'فالانضمام إلى القائمة لا يحجز شيئًا.',
    back: 'العودة إلى الأوقات',
  },

  edge: {
    slot_taken: {
      heading: 'هذا الوقت لم يبق متاحًا',
      body: 'حجزه شخص آخر أثناء تفكيرك. لم يُخصم شيء ولم يُحجز شيء. والأوقات أدناه هي ما بقي متاحًا.',
      action: 'اختر وقتًا آخر',
    },
    otp_not_arrived: {
      heading: 'الرمز لم يصل',
      body:
        'قد تتأخر الرسالة دقيقة، ولن تصل إطلاقًا إن كان في الرقم خطأ. يمكنك إرسال رمز آخر، ' +
        'أو تصحيح الرقم، أو ترك الاستقبال يستلم الحجز هاتفيًا.',
      action: 'استخدم رقمًا آخر',
    },
    network_drop: {
      heading: 'لا نعرف إن تم الحجز',
      body:
        'انقطع اتصالك أثناء استلام الحجز، فقد يكون تم وقد لا يكون. تحقّق بدلًا من الحجز مرة أخرى — ' +
        'التحقق آمن، والحجز مرة أخرى هو ما ينتج موعدين في ليلة واحدة.',
      action: 'تحقّق إن تم الحجز',
    },
    double_submission: {
      heading: 'محجوز بالفعل',
      body: 'وصل الحجز نفسه مرتين — والثانية لم تفعل شيئًا. لديك موعد واحد، وهذا هو.',
      action: null,
    },
    therapist_became_unavailable: {
      heading: 'هذا المعالج لم يبق متاحًا',
      body: 'تغيّر دوامه بعد اختيارك. وقد يبقى الوقت نفسه متاحًا مع معالج آخر، وكل معالج هنا مؤهل لهذه الجلسة.',
      action: 'أي معالج متاح',
    },
    required_room_taken: {
      heading: 'الغرفة التي تحتاجها هذه الجلسة محجوزة',
      body:
        'هذه الجلسة تُقدَّم في غرفة معيّنة فقط، وهي محجوزة في ذلك الوقت. ' +
        'معالج آخر لن يحل المسألة — وقت آخر أو يوم آخر سيحلها.',
      action: 'اختر وقتًا آخر',
    },
    duration_no_longer_fits: {
      heading: 'هذه الجلسة لم تبق تنتهي قبل الإغلاق',
      body:
        'تغيّر وقت الإغلاق في ذلك اليوم بعد اختيارك، وهذه الجلسة ستمتد بعده. ' +
        'بداية أبكر في اليوم نفسه، أو جلسة أقصر، ستناسب.',
      action: 'اختر وقتًا أبكر',
    },
    session_expired: {
      heading: 'انتهت صلاحية رقمك المؤكَّد',
      body:
        'نحفظ الرقم المؤكَّد دقائق قليلة فقط. لم يُحجز شيء ولم يُخصم شيء. ' +
        'أكّد الرقم مرة أخرى، واختيارك للوقت ما زال هنا.',
      action: 'أكّد الرقم مرة أخرى',
    },
    back_after_confirm: {
      heading: 'هذا الحجز تم بالفعل',
      body:
        'عدت إلى النموذج بعد الحجز. تعبئته مرة أخرى ستأخذ موعدًا ثانيًا، ' +
        'ولذلك هذا هو الموعد الذي لديك.',
      action: null,
    },
  },

  flowErrors: {
    already_booked: 'هذا الحجز تم بالفعل — وهذا هو، ولم يُؤخذ شيء مرتين.',
    phone_not_eligible:
      'لا يبدو هذا رقم جوال يمكنه استقبال رسالة نصية. والهاتف الأرضي لا يمكنه، فلن يصل الرمز أبدًا.',
    wrong_code: 'هذا الرمز غير صحيح. راجع الرسالة وحاول مرة أخرى.',
    code_expired: 'انتهت صلاحية هذا الرمز. أرسل رمزًا آخر.',
    no_live_challenge: 'لا يوجد رمز في انتظار الاستخدام. أرسل رمزًا جديدًا.',
    locked:
      'أُدخلت رموز خاطئة كثيرة، فأُقفل هذا الرقم لفترة قصيرة. ويمكن للاستقبال استلام الحجز هاتفيًا في الأثناء.',
    rate_limited: 'طلبت عدة رموز. يرجى الانتظار قبل طلب رمز آخر.',
    send_failed: 'لم نتمكن من إرسال الرسالة. المشكلة عندنا — حاول مرة أخرى أو اتصل بالاستقبال.',
    nothing_chosen: 'اختر أولًا جلسة ويومًا ووقتًا.',
    not_available: 'هذا الوقت لم يبق متاحًا.',
    waitlist_unavailable: 'قائمة الانتظار غير مفتوحة لذلك اليوم.',
    invalid_request: 'تعذّر قراءة شيء في هذا الإرسال. يرجى المحاولة مرة أخرى.',
  },

  noJs: {
    heading: 'جافاسكربت مُعطَّلة',
    body:
      'كل خطوة هنا تعمل: كل زر نموذج يجيب عنه الخادم. الناقص هو التسهيلات الصغيرة — ' +
      'يُوحَّد الرقم عند الإرسال بدل أن يُوحَّد عند مغادرة الحقل، ' +
      'ومدة الانتظار قبل إرسال رمز آخر رقمٌ بدل عدّ تنازلي.',
  },
}
