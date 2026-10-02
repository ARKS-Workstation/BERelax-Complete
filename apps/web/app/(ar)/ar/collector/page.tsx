import type { Metadata } from 'next'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import {
  CollectorFixture,
  type CollectorFixtureCopy,
} from '../../../_analytics/collector-fixture.tsx'

/**
 * `/ar/collector` — the collector fixture, in Arabic.
 *
 * A second document rather than `dir="rtl"` on the English one, for the reason the Arabic kitchen sink and
 * the Arabic hero demo both record: `lang` and `dir` belong to `<html>`, every rule in `theme/arabic.css`
 * is inherited from there, and an overridden `dir` would exercise a mirrored *English* document.
 *
 * It exists for a second reason that is this unit's own: `registry.test.ts` requires a document route to be
 * served in BOTH locales, because an `hreflang` set that points at a 404 invalidates the set. A dev route
 * is not exempt from that, and making it exempt would be a hole in the one check that keeps the alternate
 * sets reciprocal.
 *
 * The declared attributes come from the shared body, so the two documents cannot declare different events
 * — which is the whole point of there being one body and two pages.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'نموذج جامع القياس — التفاعلات المعلنة والدفعة التي تنتج عنها',
  description:
    'عنصر واحد لكل حدث يمكن إعلانه في قائمة أحداث القياس، حتى تتمكن اختبارات المتصفح من إثبات أن كل تفاعل ' +
    'معلن ينتج حدثًا واحدًا بالضبط.',
  ...routeMetadata('collector', 'ar'),
}

const COPY: CollectorFixtureCopy = {
  eyebrow: 'بي ريلاكس — القياس',
  heading: 'كل حدث يمكن للعناصر إعلانه، في صفحة واحدة.',
  lede:
    'يُعلن التتبّع على العنصر نفسه: سمة تحمل اسم الحدث، وسمة لكل حقل من حقول البيانات. لا يوجد في هذه ' +
    'الصفحة مكوّن يعرف أنه متتبَّع، ولا يحتفظ الجامع بقائمة أسماء خاصة به — بل يقرأ قائمة الأحداث ' +
    'المعتمدة، والاسم غير المدرج فيها يُفشل البناء بدلًا من أن يصل إلى الخادم.',
  interactionsHeading: 'عنصر واحد لكل حدث قابل للإعلان',
  whatsapp: 'دعوة للتواصل عبر واتساب',
  call: 'دعوة للاتصال الهاتفي',
  book: 'دعوة لإتمام الحجز',
  service: 'تمت قراءة خدمة',
  price: 'تمت قراءة سعر',
  twiceHeading: 'العنصر نفسه، بنقرتين',
  twice:
    'من يضغط عنصرًا مرتين لأن شيئًا لم يظهر له قد فعل شيئًا واحدًا، أما معالج النقر الذي يعمل مع شطري ' +
    'النقر المزدوج فقد رأى شيئين. النقرة الثانية داخل ٣٠٠ مللي ثانية تُرفض باسمها، والعنصر المجاور لا ' +
    'يعلن أي حدث — فلو كان المستمع يتتبّع كل نقرة في الصفحة لفشل ذلك التحقق.',
  twiceLabel: 'اضغط هنا مرتين',
  undeclared: 'لا يعلن شيئًا',
}

export default function ArabicCollectorFixturePage() {
  return <CollectorFixture copy={COPY} locale="ar" />
}
