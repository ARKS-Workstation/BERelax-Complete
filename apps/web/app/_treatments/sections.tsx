/**
 * The one component that renders a question-shaped heading, and the reason there is only one.
 *
 * The acceptance criterion is structural: *"every h2 on all 8 treatment pages is question-shaped with a
 * stable slugified id and is immediately followed by a `<p>`"*. "Immediately followed by" is a property of
 * the DOM — `h2.nextElementSibling` is a `P` — and a property of the DOM cannot be guaranteed by a
 * convention six page files agree to follow. It can be guaranteed by there being exactly one component that
 * emits an `<h2>` on these routes, whose JSX puts the paragraph next to the heading with nothing between
 * them and nothing optional about it.
 *
 * `treatments.itest.ts` walks the served markup of all eight pages in both locales and asserts the shape;
 * `content.test.ts` asserts the question mark and the ids without a browser. This file is what makes both
 * true at once.
 *
 * ## Why the extra content is keyed by id rather than passed as children
 *
 * The price table belongs *under the answer* to "How much does it cost?", not at the end of the page. A
 * `children` prop would put it after the last section, and a second `<QuestionSections>` call per page would
 * be two places the heading shape is decided. Keyed extras keep one call, one shape, and the table where the
 * question it answers is.
 */
import type { ReactNode } from 'react'
import type { QuestionSection } from '../../src/treatments/content.ts'

export interface QuestionSectionsProps {
  readonly sections: readonly QuestionSection[]
  /** Anything that follows a section's answer, keyed by the section's id. */
  readonly extras?: Readonly<Record<string, ReactNode>>
}

export function QuestionSections({ sections, extras = {} }: QuestionSectionsProps) {
  return (
    <>
      {sections.map((section) => (
        <section key={section.id}>
          {/* The heading and its answer, adjacent. Nothing may be inserted between these two elements:
              docs/09 §"LLM SEO" asks for "a direct answer in the first sentence under each" heading, and an
              image, a rule or a wrapper between them is what makes an extractor attribute the answer to the
              wrong question. */}
          <h2 id={section.id}>{section.question}</h2>
          <p>{section.answer}</p>
          {extras[section.id] ?? null}
        </section>
      ))}
    </>
  )
}
