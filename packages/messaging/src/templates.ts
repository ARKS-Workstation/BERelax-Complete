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
 */
import type { TemplateDefinition } from './render.ts'

/** Words that must never appear in a default transactional body. */
export const DISCRETION_FORBIDDEN_VARIABLES = [
  'service_name',
  'treatment',
  'treatment_style',
  'therapist_name',
  'therapist',
  'style',
] as const

export interface DefaultTemplate extends TemplateDefinition {
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
    purpose: 'Sent when a booking is made. Time and place only; detail is behind the link.',
    channel: 'sms',
    locale: 'en',
    body: 'Booking confirmed for {{date}} at {{time}}. Details or changes: {{link}}',
    variables: ['date', 'time', 'link'],
  },
  {
    key: 'booking.confirmed',
    messageClass: 'transactional',
    purpose: 'Sent when a booking is made. Time and place only; detail is behind the link.',
    channel: 'sms',
    locale: 'ar',
    body: 'تم تأكيد حجزك {{date}} الساعة {{time}}. التفاصيل: {{link}}',
    variables: ['date', 'time', 'link'],
  },
  {
    key: 'booking.reminder',
    messageClass: 'transactional',
    purpose: 'Sent before the appointment. Same discretion rule.',
    channel: 'sms',
    locale: 'en',
    body: 'Reminder: your booking tomorrow at {{time}}. Details or changes: {{link}}',
    variables: ['time', 'link'],
  },
  {
    key: 'booking.reminder',
    messageClass: 'transactional',
    purpose: 'Sent before the appointment. Same discretion rule.',
    channel: 'sms',
    locale: 'ar',
    body: 'تذكير بحجزك غداً الساعة {{time}}. التفاصيل: {{link}}',
    variables: ['time', 'link'],
  },
  {
    key: 'booking.cancelled',
    messageClass: 'transactional',
    purpose: 'Sent when a booking is cancelled, by either side.',
    channel: 'sms',
    locale: 'en',
    body: 'Your booking on {{date}} at {{time}} is cancelled. Rebook: {{link}}',
    variables: ['date', 'time', 'link'],
  },
  {
    key: 'booking.cancelled',
    messageClass: 'transactional',
    purpose: 'Sent when a booking is cancelled, by either side.',
    channel: 'sms',
    locale: 'ar',
    body: 'تم إلغاء حجزك {{date}} الساعة {{time}}. لإعادة الحجز: {{link}}',
    variables: ['date', 'time', 'link'],
  },
  {
    key: 'auth.otp',
    messageClass: 'transactional',
    purpose: 'One-time code for a customer viewing their own booking or clinical flags.',
    channel: 'sms',
    locale: 'en',
    body: 'Your code is {{code}}, valid {{minutes}} minutes. Never share it.',
    variables: ['code', 'minutes'],
  },
  {
    key: 'auth.otp',
    messageClass: 'transactional',
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
  },
  {
    key: 'invoice.issued',
    messageClass: 'transactional',
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
    purpose: 'Emails the tax invoice. Email may carry detail; the SMS channel may not.',
    channel: 'email',
    locale: 'ar',
    subject: 'فاتورتك الضريبية {{invoice_number}}',
    body: 'فاتورتك الضريبية {{invoice_number}} بتاريخ {{date}} مرفقة. المجموع {{total}}.',
    variables: ['invoice_number', 'date', 'total'],
  },
]

/** The transactional subset, which is what the discretion rule applies to. */
export function transactionalDefaults(): DefaultTemplate[] {
  return DEFAULT_TEMPLATES.filter((template) => template.messageClass === 'transactional')
}
