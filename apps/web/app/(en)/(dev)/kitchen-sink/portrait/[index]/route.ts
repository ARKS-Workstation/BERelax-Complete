/**
 * Serves one staff portrait to the kitchen sink.
 *
 * The photographs live in `assets/media/`, outside the app, because they are shared with the screenshot
 * harness and the generated documents. `public/` would mean a second copy of a 70–120KB JPEG per
 * consumer, and a copy is the one that goes stale when the photographer sends a re-crop.
 *
 * It is a route rather than an inlined `data:` URL because three base64 portraits add about 400KB to the
 * page's HTML, and a page that is four hundred kilobytes of markup is not a page any measurement of this
 * design system should be taken against.
 */
import { portraitBytes } from '../../portraits.ts'

export async function GET(
  _request: Request,
  context: { params: Promise<{ index: string }> },
): Promise<Response> {
  const { index } = await context.params
  const portrait = portraitBytes(Number.parseInt(index, 10))
  if (portrait === undefined) return new Response('No such portrait', { status: 404 })
  return new Response(new Uint8Array(portrait.bytes), {
    headers: {
      'content-type': portrait.contentType,
      // A development route reading from the working tree: a cached copy of a photograph that has been
      // re-cropped is exactly the confusion this page exists to remove.
      'cache-control': 'no-store',
    },
  })
}
