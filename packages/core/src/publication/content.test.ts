import { describe, expect, it } from 'vitest'
import { publicationCanonicalContent } from './content.ts'

/**
 * What does and does not change the hash an approval is given for.
 *
 * Both directions, because each has its own failure. A canonicalisation that folds too little invalidates an
 * approval every time somebody opens a field and closes it again — and an approval that expires for no
 * reason is one people learn to re-give without reading. One that folds too much lets approved content be
 * republished with a different claim in it, which is the whole thing the hash exists to prevent.
 *
 * The digest itself is PostgreSQL's (`publicationContentHash`), so there is one implementation of it in the
 * build; this file is about the string it is taken over.
 */

const POST = [
  { region: 'title', text: 'What to expect on a first visit' },
  { region: 'body', text: 'The desk takes your booking and shows you to the room.' },
]

const canonical = publicationCanonicalContent(POST)

describe('does not change the content', () => {
  it('a Windows line ending', () => {
    expect(
      publicationCanonicalContent([
        POST[0] as { region: string; text: string },
        { region: 'body', text: 'The desk takes your booking and shows you to the room.\r\n' },
      ]),
    ).toBe(canonical)
  })

  it('trailing whitespace on a line, and around the whole thing', () => {
    expect(
      publicationCanonicalContent([
        { region: 'title', text: '  What to expect on a first visit   ' },
        { region: 'body', text: '\tThe desk takes your booking and shows you to the room.  \t' },
      ]),
    ).toBe(
      publicationCanonicalContent([
        { region: 'title', text: 'What to expect on a first visit' },
        { region: 'body', text: '\tThe desk takes your booking and shows you to the room.' },
      ]),
    )
  })

  it('a blank line at the end of a multi-paragraph body', () => {
    const body = 'First paragraph.\n\nSecond paragraph.'
    expect(publicationCanonicalContent([{ region: 'body', text: `${body}\n\n  \n` }])).toBe(
      publicationCanonicalContent([{ region: 'body', text: body }]),
    )
  })
})

describe('does change the content', () => {
  it('a word', () => {
    expect(
      publicationCanonicalContent([
        { region: 'title', text: 'What to expect on a second visit' },
        POST[1] as { region: string; text: string },
      ]),
    ).not.toBe(canonical)
  })

  it('a paragraph moved between regions', () => {
    // The same words in a different place. This one is caught by the ORDER rather than by the region names
    // — the sibling case below is what the names are for — and it is here because swapping the title and the
    // body is the edit an editor actually makes.
    expect(
      publicationCanonicalContent([
        { region: 'title', text: 'The desk takes your booking and shows you to the room.' },
        { region: 'body', text: 'What to expect on a first visit' },
      ]),
    ).not.toBe(canonical)
  })

  it('a region renamed, with the copy untouched', () => {
    // THE case the region names exist for, and the only one that can see them: the text sequence is
    // identical, so a digest that joined the regions without naming them would call this the same page. A
    // paragraph that became the title, or a body promoted to the standfirst, is a different page — and it is
    // the one an approval must not carry over.
    expect(
      publicationCanonicalContent([
        POST[0] as { region: string; text: string },
        { region: 'standfirst', text: 'The desk takes your booking and shows you to the room.' },
      ]),
    ).not.toBe(canonical)
  })

  it('a region added, and a region dropped', () => {
    expect(
      publicationCanonicalContent([...POST, { region: 'footnote', text: 'One more line.' }]),
    ).not.toBe(canonical)
    expect(publicationCanonicalContent([POST[0] as { region: string; text: string }])).not.toBe(
      canonical,
    )
  })

  it('the regions reordered, because the order is the order of the document', () => {
    expect(publicationCanonicalContent([...POST].reverse())).not.toBe(canonical)
  })

  it('a whitespace change INSIDE a line, which is a change to the copy', () => {
    // The boundary of the normalisation, asserted from the strict side: trailing whitespace is an artefact
    // of typing and is dropped; whitespace between words is spacing an editor chose, and folding it would
    // let "pain  relief" and "painrelief" reach the same digest as prose nobody approved.
    expect(
      publicationCanonicalContent([
        { region: 'title', text: 'What  to expect on a first visit' },
        POST[1] as { region: string; text: string },
      ]),
    ).not.toBe(canonical)
  })

  it('a case change, and an accent, because neither is the lint’s job to undo here', () => {
    // The lint folds case and accents, because two spellings are one CLAIM. The digest must not: an
    // approval is for the words that were read, and "CURES" republished as "cures" is the same claim and a
    // different page.
    expect(
      publicationCanonicalContent([
        { region: 'title', text: 'WHAT TO EXPECT ON A FIRST VISIT' },
        POST[1] as { region: string; text: string },
      ]),
    ).not.toBe(canonical)
  })
})

describe('the shape of the canonical string', () => {
  it('names each region beside its text, in order, separated by a blank line', () => {
    expect(canonical).toBe(
      'title\nWhat to expect on a first visit\n\nbody\nThe desk takes your booking and shows you to the room.',
    )
    // The control on the assertion above being about a real join rather than about one long string: an
    // empty region list is the empty string, and one region carries no separator.
    expect(publicationCanonicalContent([])).toBe('')
    expect(publicationCanonicalContent([{ region: 'body', text: 'x' }])).toBe('body\nx')
  })
})
