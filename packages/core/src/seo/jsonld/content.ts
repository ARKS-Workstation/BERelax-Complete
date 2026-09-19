/**
 * `Person`, `FAQPage`, `BreadcrumbList`, `ImageObject` and `VideoObject`.
 *
 * The five node types whose content comes from somewhere other than the premises row, and the three of them
 * that emit **nothing** today. Each absence is a fact about what the database holds, and each one is a
 * deliberate refusal rather than a gap:
 *
 *   - **`Person`.** `employee` has no `display_name` column at all (0030) and there is no photography
 *     consent register. ADR 0020 requires both before a therapist may be published, so
 *     {@link personNodesFor} filters on both and the list is empty. Nineteen photographs and zero names is
 *     the real handover position (Y12-names).
 *   - **`ImageObject`.** The hero photograph exists in `assets/media/` but no derivative is committed and
 *     no route serves one, so there is no URL a crawler could fetch. An `ImageObject` whose `contentUrl`
 *     404s is worse than none: it is a claim the page carries an image that is not there.
 *   - **`VideoObject`.** There is no video. The prototype had a `#video` anchor and the media library has
 *     none — 25 assets, all stills (`assets/media/manifest.json`). A `VideoObject` describing a video that
 *     does not exist is structured-data spam.
 *
 * All five builders are complete and unit-tested, because the absence is in the data and not in the code:
 * the day a display name, a consent row or a served derivative exists, the node appears without anything
 * here changing.
 */
import { AppError } from '@berelax/shared'
import type {
  AnswerNode,
  BreadcrumbListNode,
  FaqPageNode,
  ImageObjectNode,
  ListItemNode,
  PersonNode,
  QuestionNode,
  VideoObjectNode,
} from './types.ts'
import { type LicenceClass, personTypesFor } from './vocabulary.ts'

// ------------------------------------------------------------------------------------------------
// Person — the publishing guard
// ------------------------------------------------------------------------------------------------

/**
 * A therapist as the publishing guard sees one.
 *
 * `displayName` and `photographyConsentRecordedAt` are `string | null` rather than optional, because that
 * is what a nullable column reads as and a consumer that has to handle both `undefined` and `null` handles
 * neither (the same argument `PostalAddress` in `@berelax/shared` makes).
 *
 * There is no column behind either field yet. `employee.staff_reference` is an internal handle and 0030
 * states the reason it is not a name: *"a therapist has no display name until an admin sets one, and
 * publishing one needs a recorded photography consent as well (ADR 0020, Y12-names). There is deliberately
 * no `display_name` column here — a nullable one is what an admin screen fills in without a consent row,
 * and the guard would be invisible."* This interface is therefore the shape the guard will read, declared
 * here so the guard exists before the columns do rather than being remembered afterwards.
 */
export interface TherapistCandidate {
  /** The internal handle — `Therapist 07`. Never published; it is here to name a rejection. */
  readonly staffReference: string
  readonly displayName: string | null
  /** When a photography consent was recorded, ISO 8601. Null means none. */
  readonly photographyConsentRecordedAt: string | null
  readonly skills?: readonly string[]
  readonly languages?: readonly string[]
  readonly jobTitle?: string
  /** The published portrait URL, when one is served. */
  readonly portraitUrl?: string
  /** The therapist page, when the route exists. */
  readonly url?: string
}

/** Why a therapist may not be published. The reason is named so an admin screen can say which. */
export type TherapistPublishingRefusal = 'no_display_name' | 'no_photography_consent'

/**
 * The reasons this therapist may not be published, or an empty list.
 *
 * Both, not the first. An admin who is told about the missing name sets it, comes back and is then told
 * about the consent; two refusals shown at once are one conversation instead of two, and the same argument
 * `lintPublicDisplayName` makes for returning every finding.
 */
export function therapistPublishingRefusals(
  candidate: TherapistCandidate,
): readonly TherapistPublishingRefusal[] {
  const refusals: TherapistPublishingRefusal[] = []
  if (candidate.displayName === null || candidate.displayName.trim() === '') {
    refusals.push('no_display_name')
  }
  if (candidate.photographyConsentRecordedAt === null) refusals.push('no_photography_consent')
  return refusals
}

/** True only when the therapist has both a display name and a recorded photography consent. */
export function mayPublishTherapist(candidate: TherapistCandidate): boolean {
  return therapistPublishingRefusals(candidate).length === 0
}

export interface PersonNodesOptions {
  readonly origin: string
  readonly licence: LicenceClass
  /** The organization's `@id`: `worksFor`. */
  readonly organizationId: string
}

/** The `@id` of one therapist. The internal handle, which is stable and is not a name. */
export function personId(origin: string, staffReference: string): string {
  return `${origin}/#therapist-${staffReference.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

/**
 * One therapist, whose publishing guard has already passed.
 *
 * Throws if it has not. A builder that silently returned a node with `name: ''` would publish an empty
 * `Person` — which is exactly the outcome docs/13 §5 describes as *"19 indexed, empty, near-duplicate
 * pages — worse for SEO than having none"*, with the added property that a machine would repeat it.
 */
export function personNodeFor(
  candidate: TherapistCandidate,
  options: PersonNodesOptions,
): PersonNode {
  const refusals = therapistPublishingRefusals(candidate)
  if (refusals.length > 0 || candidate.displayName === null) {
    throw new AppError(
      'invariant_violated',
      `${candidate.staffReference} may not be published as a Person: ${refusals.join(', ')}. ADR 0020 ` +
        'requires a display name and a recorded photography consent, and neither may be inferred.',
      { details: { rule: 'therapist_publishing_guard', refusals } },
    )
  }
  return {
    '@type': personTypesFor(options.licence),
    '@id': personId(options.origin, candidate.staffReference),
    name: candidate.displayName,
    worksFor: { '@id': options.organizationId },
    ...(candidate.skills !== undefined && candidate.skills.length > 0
      ? { knowsAbout: candidate.skills }
      : {}),
    ...(candidate.languages !== undefined && candidate.languages.length > 0
      ? { knowsLanguage: candidate.languages }
      : {}),
    ...(candidate.jobTitle !== undefined ? { jobTitle: candidate.jobTitle } : {}),
    ...(candidate.portraitUrl !== undefined ? { image: candidate.portraitUrl } : {}),
    ...(candidate.url !== undefined ? { url: candidate.url } : {}),
  }
}

/**
 * Every therapist that passes the guard, as `Person` nodes.
 *
 * A filter and not a map: a candidate that fails is skipped, because the team grid still shows the
 * photograph as an unlinked card and the page is unchanged. What must not happen is a node.
 */
export function personNodesFor(
  candidates: readonly TherapistCandidate[],
  options: PersonNodesOptions,
): readonly PersonNode[] {
  return candidates
    .filter((candidate) => mayPublishTherapist(candidate))
    .map((candidate) => personNodeFor(candidate, options))
}

// ------------------------------------------------------------------------------------------------
// FAQPage
// ------------------------------------------------------------------------------------------------

/**
 * One row of the `faq_entries` collection, as the builder reads it.
 *
 * The field names are the collection's own — `question`, `answer`, `topic` in
 * `packages/cms/src/collections/faq-entries.ts`, whose purpose line says *"The /faq page and its FAQPage
 * JSON-LD derive from the same rows."* They are named identically on purpose, and
 * `apps/web/src/seo/structured-data.test.ts` asserts this interface's keys against the descriptor's own
 * field list — from the application, because `packages/core` may not import `@berelax/cms` and the
 * application may see both — so a renamed CMS field is a failing test rather than a `FAQPage` with empty
 * answers.
 *
 * `answer` is **plain text**. The column is `richText` (Lexical), and flattening it is the caller's job:
 * `packages/core` has no business knowing an editor's document format, and schema.org's `Answer.text`
 * takes text. Markup in there is escaped by the consumer and read out as angle brackets.
 */
export interface FaqEntry {
  readonly question: string
  readonly answer: string
  readonly topic: string
}

/** The `@id` of the FAQ node, which is the page it is on. */
export function faqPageId(url: string): string {
  return `${url}#faq`
}

/**
 * The FAQ, from the rows.
 *
 * Returns `undefined` for an empty list rather than a `FAQPage` with an empty `mainEntity`. An empty
 * `FAQPage` is invalid — Google requires at least one `Question` — and emitting one puts an invalid node in
 * every graph on the site for as long as the collection is empty.
 *
 * A question with a blank answer is dropped, not published with `text: ''`. An `Answer` with no text is the
 * shape a half-finished draft has, and it is the one a consumer quotes as the answer.
 */
export function faqPageNode(
  entries: readonly FaqEntry[],
  options: { readonly url: string },
): FaqPageNode | undefined {
  const questions = entries
    .filter((entry) => entry.question.trim() !== '' && entry.answer.trim() !== '')
    .map(
      (entry): QuestionNode => ({
        '@type': 'Question',
        name: entry.question.trim(),
        acceptedAnswer: { '@type': 'Answer', text: entry.answer.trim() } satisfies AnswerNode,
      }),
    )
  if (questions.length === 0) return undefined
  return { '@type': 'FAQPage', '@id': faqPageId(options.url), mainEntity: questions }
}

// ------------------------------------------------------------------------------------------------
// BreadcrumbList
// ------------------------------------------------------------------------------------------------

/** One step of a trail: what it is called, and the absolute URL it points at. */
export interface BreadcrumbStep {
  readonly name: string
  readonly url: string
}

export function breadcrumbId(url: string): string {
  return `${url}#breadcrumb`
}

/**
 * The trail, or `undefined` for the home page.
 *
 * `undefined` rather than a one-item list, and this is the decision the acceptance criterion states from
 * the other side — *"`BreadcrumbList` is present on every non-home route"*. A breadcrumb whose only item is
 * the page it is on tells a consumer nothing it did not already know from the URL, and Google's own
 * guidance is not to emit one for a page with no parent.
 *
 * `position` is 1-based and contiguous, asserted by the validator. A trail numbered from zero, or with a
 * gap, is dropped whole — not partially — by consumers that check it.
 */
export function breadcrumbListNode(
  steps: readonly BreadcrumbStep[],
  options: { readonly url: string },
): BreadcrumbListNode | undefined {
  if (steps.length < 2) return undefined
  return {
    '@type': 'BreadcrumbList',
    '@id': breadcrumbId(options.url),
    itemListElement: steps.map(
      (step, index): ListItemNode => ({
        '@type': 'ListItem',
        position: index + 1,
        name: step.name,
        item: step.url,
      }),
    ),
  }
}

// ------------------------------------------------------------------------------------------------
// ImageObject and VideoObject — the hero
// ------------------------------------------------------------------------------------------------

/**
 * A hero photograph that is actually served.
 *
 * `contentUrl` must be absolute. A relative one is resolved against the page by a browser and against
 * nothing by most structured-data consumers, so it is the field that silently publishes an unfetchable
 * image. `caption` is the alt text, which `@berelax/media`'s slot registry already requires and lints —
 * there is no second description to write here.
 */
export interface HeroImage {
  readonly contentUrl: string
  readonly width: number
  readonly height: number
  readonly caption: string
}

export function imageObjectId(url: string): string {
  return `${url}#hero-image`
}

/**
 * The hero image node, or `undefined` when nothing serves one.
 *
 * `undefined` is the answer today: `assets/media/manifest.json` holds four hero stills, no derivative is
 * committed (they are built at check time — `build/budgets.json` says so) and no route serves one. An
 * `ImageObject` pointing at a URL that 404s is a claim about the page that a crawler checks and fails.
 *
 * `width` and `height` are required because they are what make the node useful — a consumer choosing
 * whether an image is large enough for a rich result reads them, and a node without them is skipped.
 */
export function imageObjectNode(
  hero: HeroImage | null,
  options: { readonly url: string },
): ImageObjectNode | undefined {
  if (hero === null) return undefined
  assertAbsolute(hero.contentUrl, 'ImageObject.contentUrl')
  if (hero.width <= 0 || hero.height <= 0) {
    throw new AppError(
      'validation',
      `A hero image must carry its real pixel dimensions; received ${hero.width}x${hero.height}.`,
      { details: { rule: 'image_object_missing_required_property' } },
    )
  }
  return {
    '@type': 'ImageObject',
    '@id': imageObjectId(options.url),
    contentUrl: hero.contentUrl,
    // `url` as well as `contentUrl`, with the same value: `contentUrl` is the bytes and `url` is the
    // page-facing address, and consumers disagree about which one they read. They are the same address
    // here because the derivative IS the served artefact.
    url: hero.contentUrl,
    width: hero.width,
    height: hero.height,
    caption: hero.caption,
    representativeOfPage: true,
  }
}

/**
 * A hero video that is actually served.
 *
 * Every field is required, and that is the whole point of the type: `uploadDate` and `thumbnailUrl` are the
 * two a `VideoObject` is most often published without, and a node missing either is discarded. There is no
 * partial constructor, so a caller with half the facts cannot emit half a node.
 */
export interface HeroVideo {
  readonly name: string
  readonly description: string
  readonly contentUrl: string
  readonly thumbnailUrls: readonly string[]
  /** ISO 8601 date, `YYYY-MM-DD` or a full instant. */
  readonly uploadDate: string
  /** ISO 8601 duration, `PT1M30S`. Omitted when unknown rather than guessed. */
  readonly duration?: string
  readonly embedUrl?: string
}

export function videoObjectId(url: string): string {
  return `${url}#hero-video`
}

/**
 * The hero video node, or `undefined` when there is no video.
 *
 * `undefined` is the answer today and it is a fact about the media library rather than about this function:
 * `assets/media/manifest.json` holds 25 assets and every one of them is a still. The prototype's `#video`
 * anchor pointed at an embed on somebody else's platform, which is not an asset this business owns.
 *
 * A `VideoObject` for a video that does not exist is the textbook structured-data manual action: it is a
 * claim about page content that a crawler can check and that fails.
 */
export function videoObjectNode(
  hero: HeroVideo | null,
  options: { readonly url: string },
): VideoObjectNode | undefined {
  if (hero === null) return undefined
  assertAbsolute(hero.contentUrl, 'VideoObject.contentUrl')
  for (const thumbnail of hero.thumbnailUrls) assertAbsolute(thumbnail, 'VideoObject.thumbnailUrl')
  if (hero.thumbnailUrls.length === 0) {
    throw new AppError(
      'validation',
      'A VideoObject needs at least one thumbnail URL; a node without one is discarded by consumers.',
      { details: { rule: 'video_object_missing_required_property' } },
    )
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(hero.uploadDate)) {
    throw new AppError(
      'validation',
      `VideoObject.uploadDate must be an ISO 8601 date; received '${hero.uploadDate}'.`,
      { details: { rule: 'video_object_missing_required_property' } },
    )
  }
  return {
    '@type': 'VideoObject',
    '@id': videoObjectId(options.url),
    name: hero.name,
    description: hero.description,
    thumbnailUrl: hero.thumbnailUrls,
    uploadDate: hero.uploadDate,
    contentUrl: hero.contentUrl,
    ...(hero.embedUrl !== undefined ? { embedUrl: hero.embedUrl } : {}),
    ...(hero.duration !== undefined ? { duration: hero.duration } : {}),
  }
}

/** Refuses a relative URL where an absolute one is the only usable form. */
function assertAbsolute(url: string, label: string): void {
  if (!/^https?:\/\//.test(url)) {
    throw new AppError(
      'validation',
      `${label} must be an absolute URL; received '${url}'. A relative URL in structured data is ` +
        'resolved against nothing by most consumers.',
      { details: { rule: 'url_not_absolute', url } },
    )
  }
}
