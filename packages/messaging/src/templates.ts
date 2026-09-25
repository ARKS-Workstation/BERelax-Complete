/**
 * The default transactional templates, and the discretion rule they exist to obey.
 *
 * ## Why no message names the treatment
 *
 * A booking confirmation that reads *"Your Arabic Hot Oil Massage with Mina at 9pm is confirmed"*
 * arrives on a lock screen. It is read by whoever is holding the phone, which is not always the
 * customer — a shared handset, a partner, a colleague glancing across a desk. For a massage centre
 * that is a privacy problem the customer did not agree to, and in this market it can be a worse one
 * than that.
 *
 * So **no default transactional template contains the service name, the treatment style or the
 * therapist's name.** The message carries the time, the place and a link. Everything else is behind
 * the link, which is per-booking and expiring. `docs/06` D2 records the reasoning; a test iterates
 * every template here and fails if any of it leaks back in.
 *
 * This is a default, not a prohibition: an owner who wants detail in the message can change the
 * template. It matters that the *default* is the discreet one, because a default is what most
 * businesses ship with.
 *
 * ## Why none of them says "BE RELAX"
 *
 * The sender ID does. Every message leaves from a TDRA-registered identity that reads `BERELAX`, and
 * repeating it in the body costs nine characters.
 *
 * Nine characters is not a rounding error in Arabic. An Arabic body is UCS-2 at **70 characters per
 * segment**, against English's 160, so a reminder that fits comfortably in English spills into a
 * second segment in Arabic — doubling the cost of the message this business sends most often, every
 * day, forever. The first draft of these templates did exactly that: all three Arabic booking
 * templates measured two segments, and `costOf` is what said so.
 *
 * A test asserts every shipped SMS default renders inside one segment in both languages. It is a
 * cost gate wearing a correctness gate's clothes, and it is worth having: the difference is roughly
 * half the SMS bill.
 *
 * ## Why one shipped template is promotional, and why it ships in `draft`
 *
 * `review.request` is here for two reasons, and the first is the ordinary one: asking a satisfied customer
 * for a review is a real thing this business will do, it is unambiguously **promotional** under TDRA
 * (docs/04 §5) rather than a service update, and `review_request` is already one of the two send-gating
 * consent purposes migration 0056 declares. Modelling it as transactional would be the misclassification
 * `message_class`'s immutability exists to make expensive.
 *
 * The second reason is that a corpus with nothing promotional in it makes several assertions *vacuous*.
 * "No promotional template can resolve to the transactional identity" and "the kill switch refuses every
 * promotional send in the corpus" are both satisfied perfectly by an all-transactional corpus, and both
 * were, for as long as there was one. So the corpus now contains both classes and a test asserts it
 * always will (brief rule 3).
 *
 * It ships with `approvalState: 'draft'` — the only shipped template that does — and that is the honest
 * statement rather than a placeholder in the body. The words here are a starting point, not approved
 * marketing copy, and a promotional SMS additionally needs an opt-out route this build has no preference
 * centre for yet (C-CRM-04). `draft` is a state the send path REFUSES: `judgeVariant` returns
 * `template_not_approved` and `sendMessage` blocks, so these words cannot reach a customer until somebody
 * with the authority to approve marketing copy has done so. A body carrying a `[DRAFT]` marker would be
 * the weaker version of the same idea — sendable, and embarrassing.
 */
import type { TemplateVariant } from './template.ts'

/** Words that must never appear in a default transactional body. */
export const DISCRETION_FORBIDDEN_VARIABLES = [
  'service_name',
  'treatment',
  'treatment_style',
  'therapist_name',
  'therapist',
  'style',
] as const

export interface DefaultTemplate extends TemplateVariant {
  readonly messageClass: 'transactional' | 'promotional'
  readonly purpose: string
}

/**
 * Shipped defaults.
 *
 * Each exists in both languages, because a customer who booked in Arabic and is reminded in English
 * has been told the system does not remember them. The Arabic bodies isolate every Latin run — a
 * time range written `11:00 - 02:00` renders as `02:00 - 11:00` in an Arabic sentence otherwise, and
 * nothing about the result looks wrong (ADR 0011).
 */
export const DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [
  {
    key: 'booking.confirmed',
    messageClass: 'transactional',
    approvalState: 'approved',
    purpose: 'Sent when a booking is made. Time and place only; detail is behind the link.',
    channel: 'sms',
    locale: 'en',
    body: 'Booking confirmed for {{date}} at {{time}}. Details or changes: {{link}}',
    variables: ['date', 'time', 'link'],
  },
  {
    key: 'booking.confirmed',
    messageClass: 'transactional',
    approvalState: 'approved',
    purpose: 'Sent when a booking is made. Time and place only; detail is behind the link.',
    channel: 'sms',
    locale: 'ar',
    body: 'تم تأكيد حجزك {{date}} الساعة {{time}}. التفاصيل: {{link}}',
    variables: ['date', 'time', 'link'],
  },
  {
    key: 'booking.reminder',
    messageClass: 'transactional',
    approvalState: 'approved',
    purpose: 'Sent before the appointment. Same discretion rule.',
    channel: 'sms',
    locale: 'en',
    body: 'Reminder: your booking tomorrow at {{time}}. Details or changes: {{link}}',
    variables: ['time', 'link'],
  },
  {
    key: 'booking.reminder',
    messageClass: 'transactional',
    approvalState: 'approved',
    purpose: 'Sent before the appointment. Same discretion rule.',
    channel: 'sms',
    locale: 'ar',
    body: 'تذكير بحجزك غداً الساعة {{time}}. التفاصيل: {{link}}',
    variables: ['time', 'link'],
  },
  {
    key: 'booking.cancelled',
    messageClass: 'transactional',
    approvalState: 'approved',
    purpose: 'Sent when a booking is cancelled, by either side.',
    channel: 'sms',
    locale: 'en',
    body: 'Your booking on {{date}} at {{time}} is cancelled. Rebook: {{link}}',
    variables: ['date', 'time', 'link'],
  },
  {
    key: 'booking.cancelled',
    messageClass: 'transactional',
    approvalState: 'approved',
    purpose: 'Sent when a booking is cancelled, by either side.',
    channel: 'sms',
    locale: 'ar',
    body: 'تم إلغاء حجزك {{date}} الساعة {{time}}. لإعادة الحجز: {{link}}',
    variables: ['date', 'time', 'link'],
  },
  /*
    P-HR-04's. The customer notice a reassignment sends: their booking is intact and somebody else is
    delivering it.

    The discretion rule binds it twice over. It names no treatment, as none of these do — and it names
    neither therapist, which is a second reason on top of the lock-screen one: a therapist has no display
    name until an admin sets one (ADR 0020, brief rule 10), so a message naming the new one would either
    invent a name or print an id. `مقدّم الجلسة` and "a different therapist" are ROLES rather than people,
    which is also what makes one wording serve a Four Hands, where two of them changed.

    It says the time and place are UNCHANGED, and that is the point of the message rather than padding:
    the notification most like this one is a cancellation, and a customer who reads "something about your
    booking has changed" assumes the worse of the two. The link is where the detail is.

    The Arabic body drops `الساعة` — "at" — which its siblings carry. Nine characters of Arabic is not a
    rounding error at 70 UCS-2 units per segment: with it this body measures 69 units against a link and
    a date that are only as long as today's, and a template with one character of headroom is a template
    that silently costs double the day a date is written out in full. Trimmed it measures 62.
  */
  {
    key: 'booking.therapist_changed',
    messageClass: 'transactional',
    approvalState: 'approved',
    purpose:
      'Sent when an appointment is reassigned to a different therapist (P-HR-04). Says the time and ' +
      'place are unchanged; names no therapist and no treatment.',
    channel: 'sms',
    locale: 'en',
    body: 'Your booking on {{date}} at {{time}} is unchanged. A different therapist will see you: {{link}}',
    variables: ['date', 'time', 'link'],
  },
  {
    key: 'booking.therapist_changed',
    messageClass: 'transactional',
    approvalState: 'approved',
    purpose:
      'Sent when an appointment is reassigned to a different therapist (P-HR-04). Says the time and ' +
      'place are unchanged; names no therapist and no treatment.',
    channel: 'sms',
    locale: 'ar',
    body: 'حجزك {{date}} {{time}} كما هو. تغيّر مقدّم الجلسة: {{link}}',
    variables: ['date', 'time', 'link'],
  },
  {
    key: 'auth.otp',
    messageClass: 'transactional',
    approvalState: 'approved',
    purpose: 'One-time code for a customer viewing their own booking or clinical flags.',
    channel: 'sms',
    locale: 'en',
    body: 'Your code is {{code}}, valid {{minutes}} minutes. Never share it.',
    variables: ['code', 'minutes'],
  },
  {
    key: 'auth.otp',
    messageClass: 'transactional',
    approvalState: 'approved',
    purpose: 'One-time code for a customer viewing their own booking or clinical flags.',
    channel: 'sms',
    locale: 'ar',
    body: 'رمزك {{code}}، صالح {{minutes}} دقائق. لا تشاركه مع أحد.',
    variables: ['code', 'minutes'],
  },
  /*
    M-VAT-11's two. These are the first defaults addressed to a MEMBER OF STAFF rather than to a customer,
    and the discretion rule still binds them for a reason that is not obvious: the message arrives on a
    personal phone, and a body naming the licence number, the permit number or the TRN would put a
    regulatory identifier on a lock screen. It names the obligation KEY and the date and nothing else —
    `trade_licence_renewal` is meaningless to a stranger and actionable to the owner, which is exactly the
    trade the customer templates make with the magic link.

    Both exist in Arabic as well. The selector does not use it yet and says why: no table records which
    language a member of staff reads, and picking one per ROLE would be a guess about a person (ADR 0020).
    Seeding it now means the day a staff locale exists the template is already approved, rather than the
    day somebody notices the Arabic half was never written.
  */
  {
    key: 'compliance.obligation_reminder',
    messageClass: 'transactional',
    purpose:
      'Sent to the role that owes a statutory obligation, at each declared number of days before its ' +
      'deadline (M-VAT-11). The obligation key and the date only: no licence number, permit number or TRN.',
    channel: 'sms',
    locale: 'en',
    body: 'Compliance due {{date}}: {{obligation}}. Owed by the {{role}}.',
    variables: ['date', 'obligation', 'role'],
    approvalState: 'approved',
  },
  {
    key: 'compliance.obligation_reminder',
    messageClass: 'transactional',
    purpose:
      'Sent to the role that owes a statutory obligation, at each declared number of days before its ' +
      'deadline (M-VAT-11). The obligation key and the date only: no licence number, permit number or TRN.',
    channel: 'sms',
    locale: 'ar',
    // The Latin runs are isolated, as every Arabic template here isolates them (ADR 0011): an obligation
    // key and a date written inside an Arabic sentence otherwise render in the wrong order.
    body: 'استحقاق {{date}}: {{obligation}}. على {{role}}.',
    variables: ['date', 'obligation', 'role'],
    approvalState: 'approved',
  },
  {
    key: 'compliance.obligation_escalation',
    messageClass: 'transactional',
    purpose:
      'Sent to the role ABOVE the one that owes an obligation, when the deadline has passed and nobody ' +
      'has acknowledged it. Separate wording from the reminder because it reports a different fact: not ' +
      'that something falls due, but that nobody has picked it up.',
    channel: 'sms',
    locale: 'en',
    body: 'Overdue, unacknowledged: {{obligation}}, due {{date}}. Now with the {{role}}.',
    variables: ['obligation', 'date', 'role'],
    approvalState: 'approved',
  },
  {
    key: 'compliance.obligation_escalation',
    messageClass: 'transactional',
    purpose:
      'Sent to the role ABOVE the one that owes an obligation, when the deadline has passed and nobody ' +
      'has acknowledged it. Separate wording from the reminder because it reports a different fact: not ' +
      'that something falls due, but that nobody has picked it up.',
    channel: 'sms',
    locale: 'ar',
    body: 'متأخر ولم يُقر: {{obligation}}، {{date}}. إلى {{role}}.',
    variables: ['obligation', 'date', 'role'],
    approvalState: 'approved',
  },
  {
    key: 'invoice.issued',
    messageClass: 'transactional',
    approvalState: 'approved',
    purpose: 'Emails the tax invoice. Email may carry detail; the SMS channel may not.',
    channel: 'email',
    locale: 'en',
    subject: 'Your tax invoice {{invoice_number}}',
    body: 'Your tax invoice {{invoice_number}} for {{date}} is attached. Total {{total}}.',
    variables: ['invoice_number', 'date', 'total'],
  },
  {
    key: 'invoice.issued',
    messageClass: 'transactional',
    approvalState: 'approved',
    purpose: 'Emails the tax invoice. Email may carry detail; the SMS channel may not.',
    channel: 'email',
    locale: 'ar',
    subject: 'فاتورتك الضريبية {{invoice_number}}',
    body: 'فاتورتك الضريبية {{invoice_number}} بتاريخ {{date}} مرفقة. المجموع {{total}}.',
    variables: ['invoice_number', 'date', 'total'],
  },
  /*
    G-CONN-08's three keys. The re-auth ladder's words, and the only shipped templates whose subject is a
    CREDENTIAL rather than a booking.

    The reassurance clause is `REAUTH_REASSURANCE_SENTENCE` in `@berelax/shared`, verbatim, and it is the
    load-bearing part of the body rather than politeness. docs/10 §4 puts it in the banner and on the
    settings card for a reason — the owner's first question on being told the Google connection is dead is
    whether work has been lost — and an email that reworded it would be a second promise about the same
    fact. `template-corpus.test.ts` asserts the constant appears in every English re-auth body, so the
    three surfaces cannot drift apart.

    `{{link}}` is an ABSOLUTE link built from `reconnectLink` and the validated site origin, never a URL
    written here: the email arrives on the day the connection has already stopped working, so a link to the
    wrong path is a dead end in the one message whose whole purpose is to get somebody to press a button.

    The Arabic variants exist for M-VAT-11's reason and carry its caveat: no table in this build records
    which language a member of staff reads, so the selector asks for `en`, and picking a locale per ROLE
    would be a guess about a person (ADR 0020). Seeding the Arabic half now means the day a staff locale
    exists the words are already approved, rather than the day somebody notices they were never written.

    Only the REACTIVE key has an SMS variant, and that is a decision rather than an omission. An SMS about
    a deadline nothing has hit yet is noise on a lock screen, and the predictive notice is precisely the
    one that says nothing is wrong yet. The SMS carries no link either: the body has to fit one segment in
    Arabic at 70 UCS-2 units against English's 160, and the email beside it is where a link belongs.
  */
  {
    key: 'google.reauth_required',
    messageClass: 'transactional',
    approvalState: 'approved',
    purpose:
      'Tells the owner and the manager that the Google connection has stopped working and needs ' +
      'reconnecting (G-CONN-08). Names no credential and no scope URL: the connection and the screen.',
    channel: 'email',
    locale: 'en',
    subject: 'The Google connection needs reconnecting',
    body:
      'The Google connection for this business stopped working on {{since}}. Open {{link}} and press ' +
      'Reconnect this account to fix it. Until that is done, review replies will keep being drafted for ' +
      'you to post by hand; nothing is lost.',
    variables: ['since', 'link'],
  },
  {
    key: 'google.reauth_required',
    messageClass: 'transactional',
    approvalState: 'approved',
    purpose:
      'Tells the owner and the manager that the Google connection has stopped working and needs ' +
      'reconnecting (G-CONN-08). Names no credential and no scope URL: the connection and the screen.',
    channel: 'email',
    locale: 'ar',
    subject: 'يحتاج الاتصال بحساب جوجل إلى إعادة ربط',
    body:
      'توقف الاتصال بحساب جوجل الخاص بالمنشأة بتاريخ {{since}}. افتح {{link}} واضغط على إعادة ربط ' +
      'الحساب. حتى ذلك الحين ستظل ردود التقييمات تُصاغ لك لنشرها يدوياً، ولن يضيع شيء.',
    variables: ['since', 'link'],
  },
  {
    key: 'google.reauth_required',
    messageClass: 'transactional',
    approvalState: 'approved',
    purpose:
      'The same fact by SMS, for the owner who is not at a screen. OFF by default ' +
      '(google.reauth_sms_enabled). Transactional and immutably so, which is what stops the marketing ' +
      'kill switch suppressing it and stops it leaving from the AD- promotional identity.',
    channel: 'sms',
    locale: 'en',
    body: 'The Google connection stopped working on {{since}}. Reconnect it in Settings.',
    variables: ['since'],
  },
  {
    key: 'google.reauth_required',
    messageClass: 'transactional',
    approvalState: 'approved',
    purpose:
      'The same fact by SMS, for the owner who is not at a screen. OFF by default ' +
      '(google.reauth_sms_enabled). Transactional and immutably so, which is what stops the marketing ' +
      'kill switch suppressing it and stops it leaving from the AD- promotional identity.',
    channel: 'sms',
    locale: 'ar',
    body: 'توقف الاتصال بجوجل بتاريخ {{since}}. أعد الربط من الإعدادات.',
    variables: ['since'],
  },
  {
    key: 'google.reauth_expiring',
    messageClass: 'transactional',
    approvalState: 'approved',
    purpose:
      'The predictive half of G-CONN-08: the Google connection is about to stop working, either because ' +
      'a Testing consent screen expires inside 48 hours or because nothing has been read successfully ' +
      'for 48 hours. Sent once per expiry instant and never repeated for it.',
    channel: 'email',
    locale: 'en',
    subject: 'The Google connection is due to stop working',
    body:
      'The Google connection for this business is due to stop working on {{expires}}. Open {{link}} and ' +
      'press Reconnect this account before then. Nothing is wrong yet, and if it does lapse, review ' +
      'replies will keep being drafted for you to post by hand; nothing is lost.',
    variables: ['expires', 'link'],
  },
  {
    key: 'google.reauth_expiring',
    messageClass: 'transactional',
    approvalState: 'approved',
    purpose:
      'The predictive half of G-CONN-08: the Google connection is about to stop working, either because ' +
      'a Testing consent screen expires inside 48 hours or because nothing has been read successfully ' +
      'for 48 hours. Sent once per expiry instant and never repeated for it.',
    channel: 'email',
    locale: 'ar',
    subject: 'الاتصال بحساب جوجل على وشك التوقف',
    body:
      'الاتصال بحساب جوجل الخاص بالمنشأة على وشك التوقف بتاريخ {{expires}}. افتح {{link}} واضغط على ' +
      'إعادة ربط الحساب قبل ذلك. لا يوجد خطأ حتى الآن، وإن توقف ستظل ردود التقييمات تُصاغ لك لنشرها ' +
      'يدوياً، ولن يضيع شيء.',
    variables: ['expires', 'link'],
  },
  {
    key: 'review.request',
    messageClass: 'promotional',
    // Ships in DRAFT, and it is the only shipped template that does. See the header section below.
    approvalState: 'draft',
    purpose:
      'Asks a customer for a review after a visit. Promotional, so it is consent-gated, confined to ' +
      '07:00-21:00 and leaves from the AD- identity.',
    channel: 'sms',
    locale: 'en',
    body: 'Thank you for your visit. A short review would mean a lot to us: {{link}}',
    variables: ['link'],
  },
  {
    key: 'review.request',
    messageClass: 'promotional',
    approvalState: 'draft',
    purpose:
      'Asks a customer for a review after a visit. Promotional, so it is consent-gated, confined to ' +
      '07:00-21:00 and leaves from the AD- identity.',
    channel: 'sms',
    locale: 'ar',
    body: 'شكراً لزيارتك. تقييم قصير منك يعني لنا الكثير: {{link}}',
    variables: ['link'],
  },
]

/** The transactional subset, which is what the discretion rule applies to. */
export function transactionalDefaults(): DefaultTemplate[] {
  return DEFAULT_TEMPLATES.filter((template) => template.messageClass === 'transactional')
}

/**
 * The promotional subset.
 *
 * Exported for the same reason `transactionalDefaults` is, and for one more: several claims about
 * promotional traffic — that no promotional template can resolve to the transactional identity, that the
 * marketing kill switch stops all of them — are assertions over the *corpus*, and a corpus with nothing
 * promotional in it satisfies every one of them while proving nothing (brief rule 3). This function is
 * what a test iterates, and `template-corpus.test.ts` asserts it is not empty.
 */
export function promotionalDefaults(): DefaultTemplate[] {
  return DEFAULT_TEMPLATES.filter((template) => template.messageClass === 'promotional')
}
