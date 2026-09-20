import { DesignSystemStyles } from '@berelax/ui/layout'
import type { Metadata } from 'next'
import { HERO_VIDEO_OPEN_QUESTION } from '../../../../src/media/hero-demo-asset.ts'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { HeroDemo, type HeroDemoCopy } from '../../../_dev/hero-demo.tsx'
import { RouteNav } from '../../../_routes/route-nav.tsx'

/**
 * The hero demo, in Arabic. The RTL half of W-SYS-07's entrance-animation ban.
 *
 * A second document rather than `dir="rtl"` on the English one, for the reason the Arabic kitchen sink
 * records: `dir` and `lang` belong to `<html>`, every rule in `theme/arabic.css` is inherited from there,
 * and an overridden `dir` would audit a mirrored *English* document. Two of this unit's criteria are
 * explicitly "in both themes and both directions", and one of them — the pause control sitting at the
 * bottom **inline-end** — is a claim that is only false in one direction. A mirrored English page would
 * have passed it.
 *
 * The media references come from the same module as the English route's: the photograph has no language,
 * and a second copy of the content address would be a second thing to keep in step.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'وسائط الواجهة — الصورة الثابتة وجزيرة إرفاق الفيديو',
  description:
    'الأسلوب الذي يجعل فيديو الواجهة بلا تكلفة: صورة حقيقية هي أكبر عنصر يُرسم، وفيديو بلا مصدر وبلا صورة ' +
    'غلاف حتى يكتمل القياس.',
  ...routeMetadata('hero-demo', 'ar'),
}

const COPY: HeroDemoCopy = {
  eyebrow: 'بي ريلاكس — نظام الوسائط',
  heading: 'الواجهة صورة حتى يصبح الفيديو مجانيًا.',
  lede:
    'أكبر عنصر في هذه الصفحة صورة حقيقية داخل عنصر picture موجَّه فنيًا: بنسبة 4:5 تحت 768 بكسل و16:9 ' +
    'فوقها، مع تحميل مسبق لكل مقاس وبأولوية عالية. أما الفيديو فيُرسَل بلا مصدر وبلا صورة غلاف، فلا يدخل ' +
    'في قياس أكبر عنصر مرسوم أصلًا. تُرفق الجزيرة المصدرَ بعد اكتمال تحميل الصفحة، وعندها فقط.',
  alt: 'خمس معالِجات بالزي الأخضر الفاتح جالسات معًا في صالة الاستقبال، وخلفهن شمعة مضاءة وأزهار مجففة.',
  control: {
    pause: 'إيقاف فيديو الخلفية مؤقتًا',
    play: 'تشغيل فيديو الخلفية',
  },
  statesHeading: 'متى لا يُرفق الفيديو أبدًا',
  states:
    'عند تفضيل تقليل الحركة لا ترفق الجزيرة شيئًا ولا تعرض أي زر: لا توجد حركة، فلا شيء يستدعي الإيقاف، ' +
    'وزر التشغيل هنا مطالبة للقارئ بأن يعيد تأكيد تفضيل ضبطه فعلًا. والأمر نفسه عند تقليل الشفافية. وإذا ' +
    'قِيست سرعة الاتصال من توقيتات موارد هذه الصفحة بأقل من 600 كيلوبت في الثانية — لا من ' +
    'navigator.connection غير الموجود في سفاري — تبقى الصورة ولا تُطلب البايتات. وإذا أوقف القارئ الفيديو ' +
    'حُفظ اختياره وعاد الزر في الزيارة التالية بحالة التشغيل.',
  footageHeading: 'لا توجد لقطات بعد',
  footage:
    `لا توجد لقطات لواجهة الموقع حتى الآن (${HERO_VIDEO_OPEN_QUESTION})، فلم يُرفع أي ملف مصدر ولم تُنتج ` +
    'أي نسخة. العناوين الأربعة أدناه هي المسارات التي سينتجها خط الإنتاج، مشتقة من الصورة الثابتة حتى لا ' +
    'يبدو أي منها عنوانًا حقيقيًا لملف غير موجود؛ وهي اليوم تُرجع 404، فترفقها الجزيرة ثم تفشل وتُبقي ' +
    'الصورة — وهو تمامًا ما يحدث عند نشر نسخة لم تُبنَ بعد.',
}

export default function HeroDemoPageAr() {
  return (
    <main>
      <DesignSystemStyles />
      <HeroDemo copy={COPY} />
      <RouteNav id="hero-demo" locale="ar" />
    </main>
  )
}
