import {
  REST_DELETE,
  REST_GET,
  REST_OPTIONS,
  REST_PATCH,
  REST_POST,
  REST_PUT,
} from '@payloadcms/next/routes'
import config, { assertPayloadSecretConfigured } from '../../../../payload.config.ts'

/**
 * Payload's REST API, which its own admin client calls.
 *
 * Mounted at `/cms-api` rather than Payload's default `/api`: `/api` belongs to the application and
 * `/api/facts` is a documented public endpoint (docs/09), and this is a catch-all route. `routes.api` in
 * `payload.config.ts` tells the admin client the same path, and `@berelax/cms`'s `CMS_ROUTE_PREFIXES` is
 * what the `x-robots-tag` rule and W-SITE-01's route registry read — so there is one place the path is
 * written down.
 *
 * Every handler runs Payload's access control, which is the F07 matrix; see `src/payload/access.ts`. There
 * is no separate authorisation path for the API.
 */
/*
 * The second entry point that can mint a session token — `/cms-api/users/login` is here, not under `/admin` —
 * and therefore the second that refuses to serve with the placeholder secret. See the admin layout and
 * `payload.config.ts` for why the refusal is at these two places rather than in the config's module body.
 */
assertPayloadSecretConfigured()

export const GET = REST_GET(config)
export const POST = REST_POST(config)
export const DELETE = REST_DELETE(config)
export const PATCH = REST_PATCH(config)
export const PUT = REST_PUT(config)
export const OPTIONS = REST_OPTIONS(config)
