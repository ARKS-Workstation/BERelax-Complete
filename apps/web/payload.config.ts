import { CMS_ROBOTS_TAG, PAYLOAD_ADMIN_ROUTE, PAYLOAD_API_ROUTE } from '@berelax/cms'
import { sharp } from '@berelax/media/sharp'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import { CMS_USERS, PAYLOAD_COLLECTIONS } from './src/collections/index.ts'
import { PAYLOAD_GLOBALS } from './src/globals/index.ts'

/**
 * Payload CMS v3, embedded in this application on this application's PostgreSQL (ADR 0019).
 *
 * Three decisions in here are the ones worth reading before changing anything:
 *
 * **1. `schemaName: 'payload'`.** Payload migrates its own tables on its own release cycle, and
 * `pnpm db:drift` compares every base table in the schemas it lists against a hand-written Drizzle mirror
 * in BOTH directions. A Payload table in `public` therefore fails the build looking like a forgotten
 * migration — on whoever's branch happens to be next. pg-boss has the same shape and is handled the same
 * way. Migration `0023_payload_schema.sql` creates the schema and deliberately nothing in it.
 *
 * **2. `routes.api: '/cms-api'`.** Payload's default is `/api`, which belongs to the application —
 * `/api/facts` is a documented public endpoint (docs/09) — and Payload's API route is a catch-all, so the
 * default would put a catch-all in one root layout group and a static sibling in another.
 *
 * **3. Collections and globals are generated from `@berelax/cms`,** not written here. The field lists are
 * the input to the catalogue-boundary gate, to the rendered document types and to this config, and one
 * list is the only way all three agree. See `@berelax/cms/src/fields.ts`.
 *
 * ## Why the admin does not inherit the site's document
 *
 * `app/(payload)/layout.tsx` is a **third root layout**, beside `(en)` and `(ar)`. Payload's `RootLayout`
 * renders its own `<html>`, its own `<head>` and its own stylesheet; our `DocumentShell` renders a
 * different one with `globals.css`, whose `@theme inline` block clears Tailwind's colour, spacing, radius
 * and font namespaces with `: initial`. Nesting either inside the other produces two `<html>` elements or
 * a Payload admin whose spacing scale has been deleted. The route group is the isolation: `globals.css` is
 * imported by the two locale layouts and by nothing under `(payload)`, and `@payloadcms/next/css` is
 * imported under `(payload)` and nowhere else. `scripts/check-cms-boundary.mjs` fails the build if either
 * crosses.
 */

/**
 * The secret signs session tokens and password-reset links.
 *
 * Read here rather than through `@berelax/config`'s `loadConfig`: this file is also loaded by Payload's
 * own CLI (`generate:importmap`, `migrate`) outside the app's boot path, and a config loader that
 * validated the whole environment would make those commands need a full production environment to run.
 * Absent in development, present or the process fails in production.
 */
function payloadSecret(): string {
  const secret = process.env['PAYLOAD_SECRET'] ?? ''
  if (secret !== '') return secret

  // `next build` loads this config to collect route metadata, with NODE_ENV=production and no runtime
  // environment. Throwing there would make the secret a BUILD dependency — the image could not be built
  // without the production signing key, which is the opposite of where that key should live. Nothing is
  // signed during a build, so the placeholder is safe here and only here.
  const isBuild = process.env['NEXT_PHASE'] === 'phase-production-build'
  if (process.env['NODE_ENV'] === 'production' && !isBuild) {
    throw new Error(
      'PAYLOAD_SECRET is required. Without it every admin session token is signed with a value an ' +
        'attacker also knows.',
    )
  }
  // Development, test, and the build step. Deliberately recognisable if it ever appears in a log.
  return 'berelax-placeholder-payload-secret-not-for-serving'
}

export default buildConfig({
  secret: payloadSecret(),
  admin: {
    user: CMS_USERS.slug,
    meta: {
      titleSuffix: ' — BE RELAX admin',
      // Belt as well as braces. The `x-robots-tag` header in `next.config.ts` is what a crawler that
      // ignores robots.txt honours, because it arrives with the response; this is what one that reads the
      // document sees.
      robots: CMS_ROBOTS_TAG,
    },
  },
  routes: { admin: PAYLOAD_ADMIN_ROUTE, api: PAYLOAD_API_ROUTE },
  collections: [...PAYLOAD_COLLECTIONS],
  globals: [...PAYLOAD_GLOBALS],
  editor: lexicalEditor({}),
  /**
   * The same libvips the derivative pipeline uses — literally the same, through `@berelax/media/sharp`.
   *
   * Payload reads an upload's pixel dimensions through this, and the `media` collection's slot constraints
   * are checks on those numbers. Without it `width` and `height` arrive null and `assertMediaRowAcceptable`
   * refuses every upload with `[unmeasured-original]` — unusable rather than unsafe, but the right answer
   * is to measure. Imported through the media package rather than as a dependency of this app so there is
   * one declared `sharp` range and therefore one libvips build; see that module for what two would cost.
   */
  sharp,
  // Off. GraphQL doubles the public surface of the CMS for no requirement this project has, and every
  // field it exposes is a field the access rules have to be right about twice.
  graphQL: { disable: true },
  /**
   * Payload's generated types go into build output, not into `src`.
   *
   * They are a second set of document types, derived from the same field lists as
   * `@berelax/cms`'s `documents.ts` — and `documents.ts` is the one the boundary depends on: it is the
   * type that makes `doc.price` a compile error, pinned by a `@ts-expect-error` in
   * `packages/cms/src/boundary.test.ts`. Two type sources in `src` would leave a renderer free to import
   * the one that happens not to be checked, so the generated pair is kept where it cannot be imported by
   * accident. Payload writes this file on its own in development; `.next` is gitignored and no gate
   * scans it.
   */
  typescript: { outputFile: `${import.meta.dirname}/.next/types/payload-types.ts` },
  db: postgresAdapter({
    pool: { connectionString: process.env['DATABASE_URL'] ?? '' },
    schemaName: 'payload',
    // UUIDv7 rather than a serial. Two reasons: a document id appears in URLs and in the audit trail, and
    // `audit_event.actor_id` is a `uuid` column — a serial admin-user id could not be recorded as the
    // actor at all.
    idType: 'uuidv7',
    // `push` is drizzle-kit syncing the schema from the config, which is right for development and a
    // schema change nobody reviewed in production. Production runs `payload migrate` as a deploy step.
    push: process.env['NODE_ENV'] !== 'production',
  }),
})
