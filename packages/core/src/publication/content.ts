import type { PublishedCopyRegion } from '../compliance/banned-claims.ts'

/**
 * The canonical form of a page's content, which is what "the exact approved content" means (W-SITE-10).
 *
 * ## Why a canonical form is needed at all
 *
 * The acceptance criterion is *"the sha256 of the exact approved content"*, and "exact" cannot mean the
 * rendered HTML: the same copy renders differently after a template change, a font-metric emit or a
 * locale's directionality being fixed, and an approval that expired on a whitespace change would be an
 * approval nobody could keep. It also cannot mean a JSON dump of the document, because key order in a
 * serialisation is not part of the content and two orders would be two hashes of one page.
 *
 * So the content is the copy the approver read, region by region, in a form that is stable under
 * everything that is not an edit:
 *
 *   * the regions in the order they were given, which is the order of the document;
 *   * `region\ntext` per entry, joined by a blank line, so a region renamed is a different hash — a
 *     paragraph moved from the standfirst into the body is a different page;
 *   * `\r\n` normalised to `\n`, because an editor pasting from Word must not invalidate an approval;
 *   * trailing whitespace per line removed and the whole trimmed, for the same reason;
 *   * and NOTHING else. No case folding, no Unicode normalisation of the text itself, no punctuation
 *     stripping. Those are the lint's business — the lint is what decides two spellings are one claim —
 *     and a digest that folded them would let approved content be republished with a different claim in it.
 *
 * ## Why this is not where the digest is computed
 *
 * `packages/db/src/repositories/publication.ts` hashes this string with PostgreSQL's own `sha256`, for the
 * reason `consentWordingHash` gives: one implementation of the digest, not two that agree today. This
 * module owns the canonicalisation, which is a pure decision about what the content IS, and
 * `packages/core` may not hash anything it could not also hash in the database.
 */

/** The canonical string a publication's hash is taken over. See the header. */
export function publicationCanonicalContent(regions: readonly PublishedCopyRegion[]): string {
  return regions
    .map((region) => `${region.region}\n${normalise(region.text)}`)
    .join('\n\n')
    .trim()
}

/**
 * Line endings unified and trailing whitespace dropped, and nothing else.
 *
 * `\r\n` and a trailing space are artefacts of how copy was typed and pasted, not of what it says. A
 * digest that treated them as content would invalidate an approval every time somebody opened the field
 * and closed it again, and an approval that expires for no reason is one people learn to re-give without
 * reading.
 */
function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim()
}
