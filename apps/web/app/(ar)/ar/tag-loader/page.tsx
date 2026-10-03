import type { Metadata } from 'next'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import {
  TagLoaderFixture,
  type TagLoaderFixtureCopy,
} from '../../../_analytics/tag-loader-fixture.tsx'

/**
 * `/ar/tag-loader` — the tag loader fixture, in Arabic. A-MEAS-04.
 *
 * A second document rather than `dir="rtl"` on the English one, for the reason the Arabic collector
 * fixture records: `lang` and `dir` belong to `<html>`, every rule in `theme/arabic.css` is inherited from
 * there, and an overridden `dir` would exercise a mirrored English document.
 *
 * It exists for a second reason that is the registry's: a document route must be served in BOTH locales,
 * because an `hreflang` set pointing at a 404 invalidates the set. It also makes the Arabic page a real
 * subject for the reporter — the direction the metric was produced under is one of the four dimensions
 * every web-vitals row carries, and `rtl` has to come from somewhere real.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'نموذج محمّل الوسوم — وسم لا يُحمّل إلا بعد الموافقة',
  description:
    'وسم واحد معلن، تحكمه بوابة الموافقة الوحيدة، ومعه مُبلّغ مؤشرات الويب الحيوية، حتى تثبت اختبارات ' +
    'المتصفح أن لا شيء يُحمّل قبل الموافقة وأن شيئًا يُحمّل بعدها.',
  ...routeMetadata('tag-loader', 'ar'),
}

const COPY: TagLoaderFixtureCopy = {
  heading: 'وسم واحد، والقرار الوحيد الذي يسمح بتحميله.',
  lede:
    'الوسم على هذه الصفحة من المصدر نفسه ولا يخدمه شيء: تعترض مجموعة الاختبارات الطلب، وهكذا يُثبت أن ' +
    'الوسم حُمّل دون تسمية أي مزوّد. أما إمكانية التحميل فهي إجابة mayLoadClientTag — الدالة نفسها التي ' +
    'تحكم أي إرسال من الخادم — مسؤولة عن كوكي هذا المستند. لا شيء هنا يقرأ سمة الشريط، ولا شيء هنا يقرر.',
  interactLabel: 'اضغط هنا، ليكون للصفحة تفاعل يُقاس',
  shiftLabel: 'فقرة، ليكون لانتقال التخطيط عنصر يُنسب إليه.',
}

export default function ArabicTagLoaderFixturePage() {
  return <TagLoaderFixture copy={COPY} locale="ar" />
}
