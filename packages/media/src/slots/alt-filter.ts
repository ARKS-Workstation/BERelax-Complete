/**
 * The junk-alt filter: the half of "required alt text" that is actually worth having.
 *
 * A required field is satisfied by any keystroke. `image`, `photo`, `IMG_2044`, the filename, the heading
 * repeated verbatim — every one of those passes a presence check and fails a screen reader, and the
 * failure is invisible to everybody who can see the picture. Alt text is also indexed, so the same junk is
 * an SEO liability: a page whose four images are described as "image", "photo", "hero" and "banner" has
 * told a crawler nothing and has four duplicated strings for its trouble.
 *
 * So there are two things to get right, and the second is the harder one.
 *
 * **1. Empty alt is sometimes correct.** WCAG 1.1.1 says a decorative image takes `alt=""`; announcing a
 * linen texture behind a pull-quote interrupts the quote to describe the wallpaper. A rule that demanded
 * fifteen characters everywhere would force somebody to write that sentence. So the filter distinguishes
 * *empty by decision* from *empty by omission* — a media row may declare itself decorative, and the slot
 * registry decides which slots may hold decoration at all (`decorativePermitted`). Exactly one does.
 *
 * **2. A prefix match is the wrong shape.** docs/08 §6 writes the filter as
 * `/^(image|photo|picture|img|hero|banner|untitled|dsc[_-]?\d+|img[_-]?\d+)/i`, anchored at the start.
 * Applied literally that rejects "Photograph of a massage bed made up with fresh white linen" and
 * "Mirror image of the treatment room reflected in the stone basin", which are good alt text, and it
 * accepts "an image" and "the photo", which are not. It is also trivially defeated by padding: `image
 * image image` is nineteen characters and passes every anchored rule.
 *
 * What replaces it is a *residue* test. Strip the boilerplate words, the articles and the punctuation; if
 * nothing describing anything is left, the string is junk however long it is and wherever the boilerplate
 * sits. `photo` fails, `image image image` fails, `the photo of the image` fails, and `Photograph of a
 * massage bed…` passes because six describing words survive. The corpus in `alt-filter.test.ts` holds the
 * nine strings the acceptance names, a padded variant of each so the length rule cannot be what is doing
 * the work, and twenty good strings — three of which deliberately contain "photograph", "banner" and
 * "image" used properly — asserted to produce no violation at all.
 *
 * Every rule returns a name, so a refusal says which rule fired and a gate can assert that the fixture
 * written for a rule was rejected *by that rule* (ADR 0003).
 */
import { AppError } from '@berelax/shared'
import type { MediaSlot } from './registry.ts'

/** docs/08 §6: "minimum 15 characters". Counted in code points, so Arabic and an emoji count once each. */
export const ALT_MIN_LENGTH = 15

/**
 * The minimum number of letters, as distinct from characters.
 *
 * `0123456789012345` is sixteen characters, is not a filename, is not boilerplate, and describes nothing.
 * Ten letters is the floor a fifteen-character sentence clears easily — the shortest of the twenty good
 * strings has forty-three — and it is what stops digits and punctuation being used as padding.
 */
export const ALT_MIN_LETTERS = 10

export const ALT_VIOLATION_RULES = [
  'alt-missing',
  'alt-whitespace-only',
  'alt-too-short',
  'alt-has-too-few-letters',
  'alt-is-boilerplate',
  'alt-is-a-filename',
  'alt-is-a-url',
  'alt-repeats-the-context',
  'alt-is-a-keyword-list',
  'alt-decorative-must-be-empty',
  'alt-decorative-not-permitted-in-slot',
] as const

export type AltViolationRule = (typeof ALT_VIOLATION_RULES)[number]

export interface AltViolation {
  readonly rule: AltViolationRule
  /** The admin field the message is attached to. */
  readonly field: 'alt' | 'decorative'
  /** What the rule requires, in the words an editor reads. */
  readonly constraint: string
  /** What was actually supplied. Quoted, so trailing space and case are visible. */
  readonly measured: string
  /** The field-level message: the constraint, the measured value, and why the rule exists. */
  readonly message: string
}

export interface AltSubject {
  readonly slot: MediaSlot
  readonly alt: string | null | undefined
  /** An explicit editorial decision that this image says nothing. Permitted only where the slot allows. */
  readonly decorative?: boolean
  /** The uploaded file's name, when there is one. Used to catch alt text that is just the filename. */
  readonly filename?: string | undefined
  /**
   * Strings the alt must not merely repeat — the treatment name, the page heading, the quote it sits
   * behind. Supplied by the caller because the CMS knows them and this module must not.
   */
  readonly context?: readonly string[]
}

/**
 * Words that carry no information about a picture.
 *
 * Two kinds, both of which appear in real alt text. Words for "a picture" (`image`, `photo`, `graphic`,
 * `thumbnail`), and words from the filing system that reached the alt field by copy-paste (`final`,
 * `copy`, `v2`, `untitled`, `jpg`). `hero` and `banner` are here because they name a *slot*, which is
 * where the image goes rather than what it shows.
 */
const BOILERPLATE_WORDS = new Set([
  'alt',
  'asset',
  'avif',
  'background',
  'banner',
  'copy',
  'default',
  'description',
  'draft',
  'file',
  'final',
  'gif',
  'graphic',
  'hero',
  'image',
  'images',
  'img',
  'imgs',
  'jpeg',
  'jpg',
  'media',
  'na',
  'new',
  'old',
  'photo',
  'photograph',
  'photography',
  'photos',
  'pic',
  'pics',
  'picture',
  'pictures',
  'placeholder',
  'png',
  'screenshot',
  'shot',
  'snap',
  'tbd',
  'temp',
  'test',
  'text',
  'thumb',
  'thumbnail',
  'tiff',
  'tmp',
  'todo',
  'unnamed',
  'untitled',
  'upload',
  'v1',
  'v2',
  'version',
  'webp',
])

/**
 * Words that are grammar rather than description.
 *
 * They are removed before the residue test, because "the photo of the image" must fail it. They are also
 * what `alt-is-a-keyword-list` looks for the *absence* of: a sentence has function words and a keyword
 * list does not, which is a more reliable signal than counting commas.
 */
const FUNCTION_WORDS = new Set([
  'a',
  'across',
  'after',
  'against',
  'an',
  'and',
  'are',
  'around',
  'as',
  'at',
  'be',
  'been',
  'before',
  'behind',
  'below',
  'beside',
  'between',
  'by',
  'during',
  'for',
  'from',
  'has',
  'have',
  'her',
  'his',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'onto',
  'or',
  'our',
  'over',
  'that',
  'the',
  'their',
  'this',
  'through',
  'to',
  'under',
  'was',
  'were',
  'where',
  'while',
  'who',
  'whose',
  'with',
  'within',
])

/**
 * Whitespace, including the kinds that are invisible in a form field.
 *
 * A required field is often satisfied with a space, and on a phone keyboard it can be a non-breaking one.
 * `String.prototype.trim` handles U+00A0 and the U+2000 block but not the zero-width characters, and a
 * field holding one zero-width space is indistinguishable from an empty one on screen.
 *
 * Written as Unicode property escapes rather than as `\uXXXX` codepoints on purpose: Biome rewrites a
 * `\u200B` escape into the literal character it denotes, which puts a zero-width space in this source file
 * and fails `pnpm invisibles`. `\p{Cf}` covers the zero-width set, the word joiner, the byte-order mark
 * and the bidi controls — none of which describes a photograph — and `\p{White_Space}` covers the rest.
 */
const INVISIBLE = /[\p{White_Space}\p{Cf}]+/gu

const LETTER = /\p{L}/gu

/** A filename extension, anywhere in the string: `team-05.jpg`, `hero final.PNG`. */
const IMAGE_EXTENSION = /\.(jpe?g|png|gif|tiff?|webp|avif|heic|heif|svg|bmp)\b/iu

/**
 * Camera-roll and screenshot names.
 *
 * `DSC_0031` and `IMG-2044` are the two the acceptance names; the rest are the other devices that produce
 * the same thing. Anchored at a word boundary rather than the start of the string, because
 * `final IMG_2044 crop` is the same mistake as `IMG_2044`.
 */
const CAMERA_ROLL = [
  /\b(dsc|dscn|dscf|img|imgp|pxl|gopr|mvimg|vid|p)[-_ ]?\d{3,}\b/iu,
  /\b(photo|image|picture|screenshot|screen[ -]?shot)[-_ ]?\d+\b/iu,
  /\b\d{8}[-_]\d{6}\b/u,
]

/** A pasted URL or path. Nobody reads one out on purpose. */
const URL_SHAPED = /^(https?:\/\/|data:|\/\/|\/)|:\/\//iu

/** Three or more list separators is a list; see `alt-is-a-keyword-list`. */
const LIST_SEPARATOR = /[,|;·••]/gu

function codePoints(text: string): number {
  return [...text].length
}

function letterCount(text: string): number {
  return (text.match(LETTER) ?? []).length
}

/** Trim including the invisible characters. */
function collapse(text: string): string {
  return text.replace(INVISIBLE, ' ').trim()
}

/** Lower-cased letters and digits only — for comparing an alt string with a filename or a heading. */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** The words of a string, lower-cased, with punctuation and digits dropped. */
function words(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '')
}

/**
 * The words that are left once boilerplate and grammar are removed.
 *
 * The whole filter turns on this function. A bare digit run is dropped too: `image 2` says no more than
 * `image`, and a version number is filing, not description.
 */
function describingWords(text: string): readonly string[] {
  return words(text).filter(
    (word) =>
      !BOILERPLATE_WORDS.has(word) &&
      !FUNCTION_WORDS.has(word) &&
      !/^\d+$/u.test(word) &&
      word !== '',
  )
}

/** The basename of a path, without its extension. */
function basename(filename: string): string {
  const last = filename.replace(/\\/gu, '/').split('/').pop() ?? ''
  const dot = last.lastIndexOf('.')
  return dot <= 0 ? last : last.slice(0, dot)
}

/** Whether the alt text is a heading with boilerplate bolted on: "Hot Stone Massage photo". */
function isContextPlusBoilerplate(alt: string, context: string): boolean {
  const target = fold(context)
  if (target.length < 4) return false
  if (fold(alt) === target) return true
  return fold(describingWords(alt).join('')) === fold(describingWords(context).join(''))
}

function violation(
  rule: AltViolationRule,
  field: AltViolation['field'],
  constraint: string,
  measured: string,
  why: string,
): AltViolation {
  return {
    rule,
    field,
    constraint,
    measured,
    message: `[${rule}] ${constraint} Supplied: ${measured}. ${why}`,
  }
}

/**
 * The decorative branch, which is the one that makes "required alt text" survive WCAG 1.1.1.
 *
 * Returned on its own because nothing else applies once an image has declared that it says nothing: the
 * remaining rules are all about what it says.
 */
function decorativeViolations(subject: AltSubject, quoted: string): AltViolation[] {
  const { slot } = subject
  const raw = subject.alt ?? ''
  const out: AltViolation[] = []
  if (!slot.decorativePermitted) {
    out.push(
      violation(
        'alt-decorative-not-permitted-in-slot',
        'decorative',
        `Slot “${slot.label}” cannot hold a decorative image.`,
        'decorative = true',
        `${slot.why} An image in this slot is content, so it needs a description.`,
      ),
    )
  }
  if (collapse(raw) !== '') {
    out.push(
      violation(
        'alt-decorative-must-be-empty',
        'alt',
        'A decorative image carries empty alt text.',
        quoted,
        'Alt text plus role="presentation" is a contradiction: the text is stored, and whichever of ' +
          'the two a reader honours, one of the two decisions was wrong. Clear the alt text, or clear ' +
          'the decorative flag and describe the image.',
      ),
    )
  }
  return out
}

/** Absent, or present and invisible. Either way there is nothing to judge, so it returns early. */
function emptinessViolation(subject: AltSubject, quoted: string): AltViolation | undefined {
  const { slot } = subject
  const raw = subject.alt ?? ''
  const out: AltViolation[] = []
  if (subject.alt === undefined || subject.alt === null || raw === '') {
    // Absent and empty-string are one rule, not two. An editor who deleted the contents of the field and
    // one who never typed in it have done the same thing, and telling them apart helps nobody.
    out.push(
      violation(
        'alt-missing',
        'alt',
        `Slot “${slot.label}” requires alt text of at least ${ALT_MIN_LENGTH} characters.`,
        quoted,
        slot.decorativePermitted
          ? 'If the image genuinely says nothing, mark it decorative — that is a decision, and an empty ' +
              'field is an omission.'
          : 'An image with no alt text is announced by its filename or skipped entirely, and neither is ' +
              'what a reader needs.',
      ),
    )
  }
  if (collapse(raw) === '') {
    out.push(
      violation(
        'alt-whitespace-only',
        'alt',
        'Alt text must contain something other than whitespace.',
        quoted,
        'A space satisfies a required field and reads as no alt text at all. Zero-width and non-breaking ' +
          'spaces count as whitespace here, because a field containing one looks empty on screen.',
      ),
    )
  }
  return out[0]
}

/**
 * The rules about what the string says: length, letters, boilerplate, filenames, URLs, repeats and lists.
 *
 * Every one of them is reported, not just the first. An editor fixing one error per save through a form is
 * the reason a required field ends up holding `image`, and a gate asserting a fixture was rejected by a
 * *named* rule needs that rule reported even when the coarser length floor also fired.
 */
function contentViolations(subject: AltSubject, text: string, quoted: string): AltViolation[] {
  const out: AltViolation[] = []
  if (codePoints(text) < ALT_MIN_LENGTH) {
    out.push(
      violation(
        'alt-too-short',
        'alt',
        `Alt text must be at least ${ALT_MIN_LENGTH} characters (docs/08 §6).`,
        `${quoted} — ${codePoints(text)} characters`,
        'Fifteen characters is about four words, which is the shortest thing that can describe a ' +
          'photograph rather than label it.',
      ),
    )
  }

  if (letterCount(text) < ALT_MIN_LETTERS) {
    out.push(
      violation(
        'alt-has-too-few-letters',
        'alt',
        `Alt text must contain at least ${ALT_MIN_LETTERS} letters.`,
        `${quoted} — ${letterCount(text)} letters`,
        'Digits and punctuation pad a string past a length check without describing anything: ' +
          '“0123456789012345” is sixteen characters long and says nothing.',
      ),
    )
  }

  if (describingWords(text).length === 0) {
    out.push(
      violation(
        'alt-is-boilerplate',
        'alt',
        'Alt text must say what the image shows, not that it is an image.',
        quoted,
        'Every word here is either a word for “a picture”, the name of a slot, a file-naming habit, or ' +
          'grammar — so a reader learns only that a picture is present, which they already knew. Padding ' +
          'it out does not help: the rule looks at what is left after those words are removed, which is ' +
          'why “image image image” fails too.',
      ),
    )
  }

  if (URL_SHAPED.test(text)) {
    out.push(
      violation(
        'alt-is-a-url',
        'alt',
        'Alt text must be a description, not a URL or a path.',
        quoted,
        'A screen reader reads a URL out character by character, and the URL of an image is the one thing ' +
          'a reader who cannot see it can least use.',
      ),
    )
  }

  const filenameLike =
    IMAGE_EXTENSION.test(text) || CAMERA_ROLL.some((pattern) => pattern.test(text))
  const stem = subject.filename === undefined ? '' : basename(subject.filename)
  const matchesUpload = stem.length >= 5 && fold(text).startsWith(fold(stem)) && fold(stem) !== ''
  if (filenameLike || matchesUpload) {
    out.push(
      violation(
        'alt-is-a-filename',
        'alt',
        'Alt text must describe the image, not name the file.',
        quoted,
        matchesUpload && !filenameLike
          ? `It begins with the uploaded file's own name (“${stem}”), which is what the field already ` +
              'holds elsewhere.'
          : 'A camera-roll name or a filename extension tells a reader which file was chosen and nothing ' +
              'about what is in it. It is also the single most common way a required alt field gets ' +
              'filled: the filename is on screen, so it gets pasted.',
      ),
    )
  }

  for (const context of subject.context ?? []) {
    if (isContextPlusBoilerplate(text, context)) {
      out.push(
        violation(
          'alt-repeats-the-context',
          'alt',
          'Alt text must add something the surrounding words do not already say.',
          `${quoted} against “${context}”`,
          'Repeating the heading gives a screen-reader user the same words twice and describes the ' +
            'photograph not at all; to an indexer it is a duplicated string on the same page. Naming the ' +
            'treatment inside a real description is fine — this fires only when the description is the ' +
            'heading and nothing else.',
        ),
      )
      break
    }
  }

  const separators = (text.match(LIST_SEPARATOR) ?? []).length
  const functionWords = words(text).filter((word) => FUNCTION_WORDS.has(word)).length
  if (separators >= 3 && functionWords === 0) {
    out.push(
      violation(
        'alt-is-a-keyword-list',
        'alt',
        'Alt text must be a description, not a list of keywords.',
        `${quoted} — ${separators} separators, no connecting words`,
        'Four comma-separated noun phrases with no grammar between them is a search-engine keyword list. ' +
          'A reader gets no sentence out of it, and an indexer treats alt text as page copy, so stuffing ' +
          'it is the same liability there as stuffing a paragraph. A real sentence with commas in it has ' +
          'connecting words and is not caught.',
      ),
    )
  }
  return out
}

/**
 * Every rule an alt string breaks, not just the first.
 *
 * Three stages, and the order is the whole structure: a decorative image is judged on being empty, an
 * empty one on being absent, and only a string that is actually there is judged on what it says.
 */
export function altViolations(subject: AltSubject): readonly AltViolation[] {
  const raw = subject.alt ?? ''
  const quoted = subject.alt === undefined || subject.alt === null ? '(nothing)' : `“${raw}”`

  if (subject.decorative === true) return decorativeViolations(subject, quoted)

  const empty = emptinessViolation(subject, quoted)
  if (empty !== undefined) return [empty]

  return contentViolations(subject, collapse(raw), quoted)
}

/** Whether a string would be rejected in this slot. The convenience wrapper over `altViolations`. */
export function isJunkAlt(subject: AltSubject): boolean {
  return altViolations(subject).length > 0
}

/**
 * Refuses unacceptable alt text, naming every rule it broke.
 *
 * One error carrying every rule rather than one error per rule: the caller is a form, and an editor who
 * is told "too short" then "it is a filename" then "it is boilerplate" over three saves concludes the
 * field is broken.
 */
export function assertAltAcceptable(subject: AltSubject): void {
  const violations = altViolations(subject)
  if (violations.length === 0) return
  throw new AppError('validation', violations.map((entry) => entry.message).join('\n'), {
    userFacing: true,
    details: {
      slot: subject.slot.name,
      rules: violations.map((entry) => entry.rule),
      violations: violations.length,
    },
  })
}
