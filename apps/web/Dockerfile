# The BE RELAX web image.
#
# It exists because `apps/web` cannot be built by a buildpack. Three facts make that so, and each is
# already recorded elsewhere in this repository:
#
#  1. The workspace packages ship TypeScript **source**, not built output — `transpilePackages` in
#     `apps/web/next.config.ts` lists fifteen of them — so the build needs the whole monorepo and the
#     committed lockfile, not one app directory.
#  2. The build **reads the database**, and not only for `generateStaticParams`: `/` and `/ar` are
#     prerendered from the `premises` row, the catalogue and the roster. Measured rather than assumed — a
#     build against a migrated but unseeded database fails with "The home page has no facts to render:
#     `premises` has no row". `ARG DATABASE_URL` below is how that connection is supplied.
#  3. `pnpm --filter @berelax/web build` is `scripts/web-build.mjs` and not bare `next build`, because
#     `next build` leaks an 11 MB cache per invocation into the OS temp root. The wrapper owns a temp
#     directory and removes it. The image calls the wrapper for the reason CI does.
#
# Two stages, the same shape as `apps/worker/Dockerfile`: `deps` resolves the workspace and runs the Next
# build; `runtime` is the only thing shipped. Both `FROM` lines carry a tag **and** an `@sha256` digest,
# which `scripts/check-container.mjs` requires — a tag is mutable, so the image that was scanned would not
# be the image that ships.
#
# No `apt-get` here, deliberately. The worker image conveys ffmpeg and libvips and therefore carries their
# licence texts and a written offer; this image installs no operating-system package, so it conveys none and
# `build/container-policy.json` declares none against it.

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS deps

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# The whole workspace, filtered by `.dockerignore` at the context root — for the reason the worker image
# states: `pnpm install --frozen-lockfile` compares the lockfile against every importer in
# `pnpm-workspace.yaml`, so a context missing one of them fails with "lockfile is not up to date".
#
# `.dockerignore` is what keeps a developer's environment file out of this layer. An image layer is
# immutable and readable by anyone who can pull it, so a credential copied in cannot be removed by a later
# layer — `scripts/check-container.mjs` enforces both halves.
COPY . .

RUN pnpm install --frozen-lockfile

# The database the BUILD reads.
#
# It has to be the database the deployment will serve, because a prerendered page is HTML frozen at build
# time: `/` and `/ar` carry the trading name, the address, the catalogue and the roster, and a build pointed
# at a seed would ship fixture content to the public. `.do/app.production.yaml` therefore binds
# `${db.DATABASE_URL}` at `RUN_AND_BUILD_TIME` rather than giving the build a throwaway database.
#
# **Why a build argument is acceptable here, when a credential in an image layer is not.** This is a
# multi-stage build and `ARG`/`ENV` in the `deps` stage belong to a stage that is discarded: the shipped
# image is built from the `runtime` stage below, whose history contains only its own instructions, and
# which never declares `DATABASE_URL`. The running container receives the value from the platform's
# environment instead — the ordinary path, revocable by rotating the database user. What would NOT be
# acceptable, and is what the container gate's `[env-file-copied-into-image]` rule is about, is copying an
# environment file into a layer that ships.
#
# There is no default. A build with no database argument fails at the first prerender, which is the loud
# failure; a default of localhost would make it a confusing one.
ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL

# The origin every canonical URL and hreflang alternate is built from, and a BUILD argument because it is
# read at render time — so for the statically rendered routes it is frozen into the HTML here.
#
# **A build argument with no matching `ARG` is silently dropped, and that is how this was found.** The app
# spec set `SITE_ORIGIN` at build scope, App Platform passed it to `docker build`, this Dockerfile declared
# nothing to receive it, and the build fell back to `SITE_ORIGIN_FALLBACK` in `@berelax/shared`. The staging
# site then served `rel="canonical" href="https://berelaxmassage.com/"` — a preview asking Google to index
# production copies of unreviewed pages, which is the exact harm that fallback's own comment names. Nothing
# failed; the wrong URL was simply in every prerendered page.
#
# No default, for the same reason `DATABASE_URL` has none: the fallback is already the considered answer for
# an unset value, and a default here would be a second one that disagrees with it silently.
ARG SITE_ORIGIN
ENV SITE_ORIGIN=$SITE_ORIGIN

# `APP_ENV` for the build only — the `runtime` stage carries none, so the platform supplies it and a missing
# one is refused at boot by `parseConfig`. `preview` is chosen because the build must not be able to select
# a real provider: the refusal in `packages/config/src/env.ts` applies to every value but `production`, so
# a build cannot message a customer or spend a model's budget while collecting page data.
ENV APP_ENV=preview

# `PAYLOAD_SECRET` is deliberately NOT a build argument. `payloadSecret()` in `apps/web/payload.config.ts`
# falls back to a recognisable placeholder when it is unset, precisely so the image can be built without the
# production signing key — and `assertPayloadSecretConfigured()` refuses to serve the CMS admin or its API
# without a real one at run time. Nothing is signed during a build.

RUN pnpm --filter @berelax/web build

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH

# pnpm in the runtime stage as well as the builder: `COPY --from=deps` brings `/app` and not `/pnpm`, so
# without this the CMD is `pnpm: not found` — a mistake that survives every static check and appears the
# first time the container is started.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# The resolved workspace and the build output together. `node_modules` is the image's own, resolved in the
# `deps` stage against this base image's glibc; a host tree copied in would land pnpm symlinks pointing at
# paths that do not exist here.
COPY --from=deps --chown=node:node /app /app
WORKDIR /app

# `next start` reads `PORT`. App Platform sets it from `http_port` in the app spec, and 3000 is what a bare
# `docker run` gets, so the two agree without the number being written twice.
ENV PORT=3000
EXPOSE 3000

# A deploy should drain rather than kill. Next closes its listener on SIGTERM; stating the signal means a
# future base image changing the default cannot silently turn a drain into a kill.
STOPSIGNAL SIGTERM

# The final stage runs as an unprivileged user — `node` is uid 1000 in the official image. A container that
# runs as root gives a process escape the host namespace it was handed, and the container gate refuses an
# image whose final stage does not set this.
USER node

CMD ["pnpm", "--filter", "@berelax/web", "start"]
