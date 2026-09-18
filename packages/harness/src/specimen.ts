/**
 * The specimen page: the design system, rendered, using real fixture data.
 *
 * This unit runs before any Next.js application exists (see the manifest note on H04), so the harness
 * needs something real to photograph. A specimen page is the right something: it exercises every
 * token, every text role and the components a booking flow is made of, in both scripts, and it stays
 * useful afterwards as the page you look at when a token changes.
 *
 * It is built from the same sources everything else is — `@berelax/ui` for tokens,
 * `@berelax/fixtures` for content — so a screenshot of it is a screenshot of the actual system, not
 * of a mock-up that agrees with it today.
 *
 * Deliberately styled with logical properties throughout (`margin-inline-start`, not `margin-left`),
 * because the RTL rule in the critique pass would otherwise flag the specimen itself — and a specimen
 * that fails its own rules teaches the wrong thing.
 */
import { formatMoney, safeText } from '@berelax/core'
import { generateSalon } from '@berelax/fixtures'
import { tokensCss } from '@berelax/ui'

const salon = generateSalon()

interface Copy {
  readonly en: string
  readonly ar: string
}

const COPY = {
  title: { en: 'BE RELAX', ar: 'بي ريلاكس' },
  tagline: { en: 'Come in tense. Leave light.', ar: 'ادخل متوتراً. اخرج خفيفاً.' },
  lede: {
    en: 'A massage centre on Al Meena Street in Al Zahiyah. Open every day from 11am until 2am, with treatments from forty-five minutes to two hours, and therapists who will match the pressure to what your shoulders are actually doing rather than to what you asked for at the desk.',
    ar: 'مركز مساج في شارع الميناء بالزاهية. نفتح كل يوم من الحادية عشرة صباحاً حتى الثانية بعد منتصف الليل، بجلسات تتراوح من خمس وأربعين دقيقة إلى ساعتين، ومعالجون يضبطون الضغط على ما تحتاجه أكتافك فعلاً لا على ما طلبته عند الاستقبال.',
  },
  treatments: { en: 'Treatments', ar: 'الجلسات' },
  book: { en: 'Book a treatment', ar: 'احجز جلسة' },
  whatsapp: { en: 'Message us on WhatsApp', ar: 'راسلنا على واتساب' },
  slots: { en: 'Available today', ar: 'المتاح اليوم' },
  therapists: { en: 'Our therapists', ar: 'المعالجون' },
  minutes: { en: 'minutes', ar: 'دقيقة' },
  from: { en: 'from', ar: 'من' },
  note: {
    en: 'All prices include VAT. Same-gender therapist matching is on by default and can be changed at the desk.',
    ar: 'جميع الأسعار تشمل الضريبة. مطابقة الجنس مفعّلة افتراضياً ويمكن تغييرها عند الاستقبال.',
  },
} satisfies Record<string, Copy>

const SLOT_TIMES = ['11:00', '12:30', '14:00', '15:30', '17:00', '18:30', '20:00', '21:30'] as const

function styles(): string {
  return `
${tokensCss()}

*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--color-ground);
  color: var(--color-ink);
  font-family: 'IBM Plex Sans', system-ui, sans-serif;
  font-size: 1.0625rem;
  line-height: 1.647;
}

.page {
  max-width: var(--container-max);
  margin-inline: auto;
  padding-inline: var(--gutter);
  padding-block: var(--space-10);
}

header { margin-block-end: var(--space-11); }
.eyebrow {
  font-size: 0.75rem;
  line-height: 1.33;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-ink-2);
  margin-block-end: var(--space-3);
}
[lang='ar'] .eyebrow { letter-spacing: 0; text-transform: none; font-size: 0.8rem; }

h1 {
  font-size: clamp(2rem, 1.4rem + 2.2vw, 2.5rem);
  line-height: 1.15;
  letter-spacing: -0.016em;
  margin: 0 0 var(--space-5);
  max-width: 26ch;
}
[lang='ar'] h1 { letter-spacing: 0; line-height: 1.3; font-weight: 500; }

h2 {
  font-size: 1.5rem;
  line-height: 1.333;
  letter-spacing: -0.008em;
  margin: 0 0 var(--space-6);
  max-width: 34ch;
}
[lang='ar'] h2 { letter-spacing: 0; line-height: 1.3; font-weight: 500; }

/* The measure is a cap, not a suggestion: docs/08 puts the hard maximum at 76ch. */
.lede { font-size: 1.25rem; line-height: 1.6; max-width: 56ch; color: var(--color-ink-2); }
p { max-width: 68ch; }
[lang='ar'] p, [lang='ar'] .lede { line-height: 1.85; font-weight: 500; }

section { margin-block-end: var(--space-11); }

.actions { display: flex; flex-wrap: wrap; gap: var(--space-6); margin-block-start: var(--space-8); }

.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 48px on the phone, which is the rule rather than the result of padding arithmetic. */
  min-height: 48px;
  padding-inline: var(--space-8);
  border-radius: var(--radius-2);
  border: 1px solid transparent;
  font-weight: 600;
  text-decoration: none;
  font-size: 1rem;
}
.button--primary { background: var(--color-accent-gold); color: var(--color-ground); }
.button--secondary {
  background: transparent;
  color: var(--color-accent-teal);
  border-color: var(--color-border-strong);
}

.treatments { display: grid; gap: var(--space-6); grid-template-columns: 1fr; }
@media (min-width: 768px) { .treatments { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 1024px) { .treatments { grid-template-columns: repeat(3, 1fr); } }

.card {
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-radius: var(--radius-1);
  padding: var(--space-8);
}
.card h3 { margin: 0 0 var(--space-3); font-size: 1.25rem; line-height: 1.6; }
.card .meta { color: var(--color-ink-2); font-size: 0.875rem; margin: 0; }
.card .price {
  margin-block-start: var(--space-6);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* A sand band: a surface token carrying a large shape, with ink on top. Never the reverse. */
.band { background: var(--color-surface-sand); padding-block: var(--space-10); }
.band .page { padding-block: 0; }

.slots { display: flex; flex-wrap: wrap; gap: var(--space-5); list-style: none; padding: 0; margin: 0; }
.slot {
  min-height: 48px;
  min-width: 88px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-2);
  background: var(--color-surface);
  font-variant-numeric: tabular-nums;
}
/* The selected slot uses the same fill pair as the primary button, which is one of the three
   combinations docs/08 measures. A teal fill with surface text looked right and measured 4.22:1 —
   the critique pass caught it, which is the second defect it found in its own specimen. */
.slot[aria-pressed='true'] { background: var(--color-accent-gold); color: var(--color-ground); border-color: var(--color-accent-gold); }

.therapists { display: grid; gap: var(--space-6); grid-template-columns: repeat(2, 1fr); list-style: none; padding: 0; margin: 0; }
@media (min-width: 768px) { .therapists { grid-template-columns: repeat(4, 1fr); } }
.therapist { text-align: start; }
/* Placeholder at the correct ratio, on purpose: layout truth should not wait on photography, and a
   placeholder at the right aspect exposes crop problems a real image would disguise. */
.portrait {
  aspect-ratio: 4 / 5;
  background: var(--color-surface-clay);
  border-radius: var(--radius-1);
  margin-block-end: var(--space-5);
}
.therapist .name { font-weight: 600; }
/* ink-2, not ink-3. ink-3 is 3.40:1 and docs/08 marks it "large text and meta only"; this label is
   body size, so it needs 4.5:1. The critique pass caught it the moment the unpublished therapist was
   added to the specimen — which is the third defect it has found in its own page. */
.therapist .unnamed { color: var(--color-ink-2); }

footer { border-top: 1px solid var(--color-hairline); padding-block-start: var(--space-8); color: var(--color-ink-2); }
footer p { font-size: 0.875rem; }
`
}

export interface SpecimenOptions {
  readonly direction: 'ltr' | 'rtl'
  readonly theme: 'light' | 'dark'
}

/** Renders the specimen page. The direction selects the language, because RTL here means Arabic. */
export function renderSpecimenHtml(options: SpecimenOptions): string {
  const rtl = options.direction === 'rtl'
  const lang = rtl ? 'ar' : 'en'
  const t = (copy: Copy): string => safeText(rtl ? copy.ar : copy.en)

  const treatments = salon.services.slice(0, 6).map((service) => {
    const name = rtl ? service.treatmentAr : `${title(service.style)} ${service.treatment}`
    return [
      '<article class="card">',
      `<h3>${safeText(name)}</h3>`,
      `<p class="meta">${service.durationMinutes} ${t(COPY.minutes)}</p>`,
      `<p class="price">${safeText(formatMoney(service.priceGross, lang))}</p>`,
      '</article>',
    ].join('')
  })

  const slots = SLOT_TIMES.map(
    (time, index) =>
      `<li><button class="slot" type="button" aria-pressed="${index === 2 ? 'true' : 'false'}">${time}</button></li>`,
  )

  // Three published and one not, deliberately. The unpublished state is a rule (ADR 0020: no page
  // without a display name and a recorded photography consent) and a specimen that only shows the
  // happy path is how a rule ends up implemented in the data model and nowhere on screen.
  const published = salon.therapists.filter((therapist) => therapist.published).slice(0, 3)
  const withheld = salon.therapists.filter((therapist) => !therapist.published).slice(0, 1)
  const therapists = [...published, ...withheld].map((therapist) => {
    // ADR 0020: a therapist without a recorded consent renders as an unlinked photo card.
    const name = therapist.published
      ? `<span class="name">${safeText(rtl ? (therapist.displayNameAr ?? therapist.displayName) : therapist.displayName)}</span>`
      : `<span class="unnamed">${t({ en: 'Name not yet published', ar: 'الاسم غير منشور بعد' })}</span>`
    return ['<li class="therapist">', '<div class="portrait"></div>', name, '</li>'].join('')
  })

  return `<!doctype html>
<html lang="${lang}" dir="${options.direction}"${options.theme === 'dark' ? ' data-theme="dark"' : ' data-theme="light"'}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BE RELAX — design specimen</title>
<style>${styles()}</style>
</head>
<body>
<div class="page">
  <header>
    <p class="eyebrow">${t(COPY.title)}</p>
    <h1>${t(COPY.tagline)}</h1>
    <p class="lede">${t(COPY.lede)}</p>
    <div class="actions">
      <a class="button button--primary" href="#book">${t(COPY.book)}</a>
      <a class="button button--secondary" href="#whatsapp">${t(COPY.whatsapp)}</a>
    </div>
  </header>

  <section>
    <h2>${t(COPY.treatments)}</h2>
    <div class="treatments">${treatments.join('')}</div>
  </section>
</div>

<div class="band">
  <div class="page">
    <section>
      <h2>${t(COPY.slots)}</h2>
      <ul class="slots">${slots.join('')}</ul>
    </section>
  </div>
</div>

<div class="page">
  <section>
    <h2>${t(COPY.therapists)}</h2>
    <ul class="therapists">${therapists.join('')}</ul>
  </section>

  <footer>
    <p>${t(COPY.note)}</p>
  </footer>
</div>
</body>
</html>`
}

function title(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
