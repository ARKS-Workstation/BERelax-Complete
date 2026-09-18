/**
 * The kitchen sink, in Arabic. The RTL half of W-SYS-03's twelve-render axe sweep.
 *
 * ## Why a second route and not `dir="rtl"` on the English one
 *
 * Because `dir` belongs to the document. W-SYS-01 landed two root layouts — `(en)` and `(ar)` — after
 * an earlier draft set `lang`/`dir` on a `<main>` wrapper inside one English layout: it built, it
 * rendered mirrored text, and it did none of the four things `theme/arabic.css` exists to do, because
 * every rule there is inherited from `<html>`. A `dir` override would therefore have audited a mirrored
 * *English* document — Latin font stack, `--font-size-scalar: 1`, Latin line-height, tracking still on —
 * and reported it as the Arabic one. The three things this unit actually asserts in RTL are the portal
 * direction, the radii and the axe pass, and the first of those is decided by `DirectionProvider`, which
 * the shell feeds from the locale of the layout that rendered it.
 *
 * It is an abbreviated sink rather than a translation of every paragraph on the English route: the
 * components are all here — the three container-query patterns and the whole primitive set, through the
 * one shared `PrimitiveGallery` — and the long-form copy that W-SYS-02's measure assertions are taken
 * against stays on the English route, which is where they are taken.
 *
 * The portraits are served by the English route's handler at `/kitchen-sink/portrait/[index]`. Route
 * groups do not appear in a URL and the handler reads from `assets/media/`, so there is nothing
 * locale-specific about it and a second copy would be a second thing to keep in step.
 */
import { aed, formatMoney } from '@berelax/core'
import { DesignSystemStyles, Grid, GridCell, Measure, Section } from '@berelax/ui/layout'
import { ServiceRow, SlotGrid, TherapistCard } from '@berelax/ui/patterns'
import type { Metadata } from 'next'
import { PrimitiveGallery, type PrimitiveGalleryCopy } from '../../../_dev/primitive-gallery.tsx'
import { portraits } from '../../../(en)/(dev)/kitchen-sink/portraits.ts'

export const metadata: Metadata = {
  title: 'معرض المكونات — نظام التصميم لبي ريلاكس',
  description: 'كل مكون من مكونات نظام التصميم على صفحة واحدة.',
  robots: { index: false, follow: false },
}

/** The Asian menu at 60 minutes, from docs/13 §4. Gross, VAT-inclusive, formatted for ar-AE. */
const MENU = [
  { name: 'مساج عادي', minutes: 60, price: aed(200) },
  { name: 'مساج بالزيت الساخن', minutes: 60, price: aed(250) },
  { name: 'حمام مغربي أو جاكوزي', minutes: 60, price: aed(300) },
] as const

const SLOTS = [
  { label: '11:00', available: true },
  { label: '12:30', available: true },
  { label: '14:00', available: true, selected: true },
  { label: '15:30', available: false },
  { label: '17:00', available: true },
  { label: '18:30', available: true },
  { label: '20:00', available: true },
  { label: '21:30', available: true },
] as const

/** No therapist has a display name until an admin sets one and records a consent. ADR 0020. */
const UNNAMED = 'لم يُنشر الاسم بعد'

const PRIMITIVE_COPY: PrimitiveGalleryCopy = {
  buttons: {
    primary: 'احجز جلسة',
    quiet: 'اطلع على القائمة',
    ghost: 'اتصل بالاستقبال',
    withIcon: 'اختر التاريخ',
    // The icon-only button's accessible name. The component does not compile without it.
    iconOnly: 'ابحث في الجلسات',
    disabled: 'الحجز مكتمل اليوم',
  },
  nav: { label: 'في هذه الصفحة', today: 'المتاح اليوم', hours: 'الجلسات' },
  chips: ['آسيوي', 'عربي', '60 دقيقة'],
  panel: {
    title: 'لوحة بزاوية بمقدار بكسلين',
    body:
      'نصف قطر الزاوية هو أوضح قرار في القسم السابع من وثيقة التصميم: زاوية بمقدار بكسلين على خلفية ' +
      'دافئة مع حد رقيق تُقرأ كمطبوعة، أما ستة عشر بكسلاً فتُقرأ كتطبيق. القياسات الأصلية لمكونات ' +
      'shadcn تُستبدل هنا ولا تُعاد صياغتها بالألوان فقط.',
  },
  fields: {
    mobile: 'رقم الهاتف المتحرك',
    mobileHint: 'يُؤكَّد الحجز على هذا الرقم برسالة نصية.',
    notes: 'ما ينبغي أن يعرفه المعالج',
    notesPlaceholder: 'قوة الضغط، الإصابات، التفضيلات',
    duration: 'المدة',
    durations: [
      { value: '45', label: '45 دقيقة' },
      { value: '60', label: '60 دقيقة' },
      { value: '90', label: '90 دقيقة' },
      { value: '120', label: '120 دقيقة' },
    ],
    durationDefault: '60',
  },
  popover: {
    trigger: 'ما الذي يشمله السعر؟',
    label: 'ما الذي يشمله السعر',
    body:
      'كل سعر هو المبلغ الإجمالي شاملاً ضريبة القيمة المضافة، وهو المبلغ المستحق. تُستخرج الضريبة من ' +
      'هذا المبلغ ولا تُضاف إليه، فلا يتغير الرقم على الفاتورة.',
  },
  dialog: {
    trigger: 'سياسة الإلغاء',
    title: 'إلغاء الحجز',
    description:
      'يمكن تعديل الحجز أو إلغاؤه حتى ساعتين قبل موعده، في الاستقبال أو بالرد على رسالة التأكيد.',
    close: 'إغلاق',
  },
  sheet: {
    trigger: 'اختر وقت البداية',
    title: 'أوقات البداية المتاحة اليوم',
    description:
      'يمتد العمل من الساعة 11:00 حتى 02:00، لذا يسبق آخر موعد للبداية وقت الإغلاق بمقدار مدة الجلسة.',
    close: 'إغلاق',
  },
}

export default function ArabicKitchenSinkPage() {
  return (
    <main>
      <DesignSystemStyles />

      <Section as="header">
        <Grid>
          <p className="text-eyebrow text-ink-2">بي ريلاكس — نظام التصميم</p>
          <Measure cap="h1" as="h1" className="text-3xl">
            ادخل متوترًا. اخرج خفيفًا.
          </Measure>
          <Measure cap="lede" className="text-lg text-ink-2">
            الشبكة نفسها، والمقاس نفسه، وحلقة التركيز نفسها، والمكونات نفسها — معروضة في مستند عربي،
            لأن الاتجاه خصيصة للمستند لا لعنصر داخله.
          </Measure>
        </Grid>
      </Section>

      <Section id="menu">
        <Grid>
          <Measure cap="h2" as="h2" className="text-xl be-section__heading">
            الجلسات
          </Measure>
          <GridCell span="wide">
            {MENU.map((item) => (
              <ServiceRow
                key={item.name}
                name={item.name}
                meta={`آسيوي · ${item.minutes} دقيقة`}
                price={formatMoney(item.price, 'ar')}
                action={{ label: 'احجز', href: '#slots' }}
              />
            ))}
          </GridCell>
        </Grid>
      </Section>

      <Section surface="sunk" id="slots">
        <Grid>
          <Measure cap="h2" as="h2" className="text-xl be-section__heading">
            المتاح اليوم
          </Measure>
          <SlotGrid slots={SLOTS} ariaLabel="أوقات البداية المتاحة اليوم" />
        </Grid>
      </Section>

      <Section>
        <Grid>
          <Measure cap="h2" as="h2" className="text-xl be-section__heading">
            المعالجون
          </Measure>
          <GridCell span="wide" as="ul" className="grid list-none gap-8 p-0 md:grid-cols-3">
            {portraits(3).map((portrait) => (
              <li key={portrait.index}>
                <TherapistCard
                  unnamedLabel={UNNAMED}
                  reference={`معالج ${String(portrait.index + 1).padStart(2, '0')}`}
                  href="#slots"
                  portrait={{
                    src: `/kitchen-sink/portrait/${portrait.index}`,
                    objectPosition: portrait.objectPosition,
                  }}
                  qualifications="آسيوي · عربي"
                />
              </li>
            ))}
          </GridCell>
        </Grid>
      </Section>

      <Section surface="surface" id="primitives">
        <Grid>
          <Measure cap="h2" as="h2" className="text-xl be-section__heading">
            المكونات
          </Measure>
          <GridCell span="wide">
            <PrimitiveGallery copy={PRIMITIVE_COPY} />
          </GridCell>
        </Grid>
      </Section>
    </main>
  )
}
