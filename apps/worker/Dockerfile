# The BE RELAX worker image.
#
# It exists because of one dependency: ffmpeg. docs/08 §8 lists "ffmpeg in the worker image (non-trivial
# size)" among the costs that are "not optional, must be budgeted", and H-HARD-02 deferred container
# scanning to W-SYS-06 precisely because there was no image to scan until this file existed. Every rule in
# `scripts/check-container.mjs` applies to it, and `build/container-policy.json` records why each base image
# and each operating-system package in it is here.
#
# Two stages. `deps` resolves the workspace against the committed lockfile; `runtime` is the only thing
# shipped, and it contains no package manager state beyond what pnpm left in `node_modules`.
#
# Both `FROM` lines carry a tag **and** an `@sha256` digest, which the policy requires: a tag is mutable, so
# `node:22-bookworm-slim` is different bytes every week and the image that was scanned would not be the
# image that ships. The digest is the only pin that survives a re-push.

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS deps

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# The whole workspace, filtered by `.dockerignore` at the context root. Copying only the manifests the
# worker needs would be a smaller layer and a broken install: `pnpm install --frozen-lockfile` compares the
# lockfile against every importer in `pnpm-workspace.yaml`, so a context missing one of them fails with
# "lockfile is not up to date" rather than producing a partial tree.
#
# `.dockerignore` is what keeps a developer's local environment file out of this layer. An image layer is
# immutable and readable by anyone who can pull it, so a credential copied in cannot be removed by a later
# layer — `scripts/check-container.mjs` enforces both halves: no COPY names an environment file, and the
# context excludes them.
COPY . .

# `--frozen-lockfile` so the image cannot resolve a version the repository has not committed. Dev
# dependencies are installed deliberately: the worker runs its TypeScript directly through `tsx` (ADR
# 0002's reasons for staying on TypeScript 6 are also the reasons there is no separate build step here), and
# `tsx` is a root devDependency.
RUN pnpm install --frozen-lockfile

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH

# pnpm in the runtime stage as well as in the builder. `COPY --from=deps` brings `/app` and not `/pnpm`, so
# without this the CMD at the bottom is `pnpm: not found` — a mistake that survives every static check and
# appears the first time the container is actually started.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# ffmpeg, and nothing else that was not asked for. Debian's package pulls libavcodec, which hard-depends on
# libx264 and libx265 — the two encoders the renditions in docs/08 §6 are specified with, and the two
# reasons this binary is GPL. `build/container-policy.json` declares both components with their licence and
# their obligation, and `apps/worker/licences/THIRD-PARTY-NOTICES.md` carries the notice and the offer.
# Only ffmpeg: the official Node image already carries ca-certificates, and every package named here is a
# component this image conveys and therefore a reviewed decision with a licence attached.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# The licence texts the two copyleft components in this image oblige it to carry, asserted rather than
# assumed. Debian's `base-files` provides `/usr/share/common-licenses`, and it survives the slim images'
# documentation exclusions because it is not under `/usr/share/doc` — but "it should be there" is not
# evidence, and an image that shipped a library without its licence text would look exactly like one that
# did. Note the specific failure this catches: the `@img/sharp-libvips-linux-x64` package ships **no** copy
# of the LGPL text, so an image built only from `node_modules` carries libvips and not its licence.
RUN test -s /usr/share/common-licenses/LGPL-3 \
 && test -s /usr/share/common-licenses/GPL-3 \
 && test -s /usr/share/common-licenses/GPL-2

# What this image actually carries, recorded from the installed packages rather than transcribed into a
# document that can drift. `resolveFfmpeg()` reads the same configuration line back at runtime and refuses
# to encode when the licence it detects is not the one the notice covers.
RUN set -eu; \
    mkdir -p /usr/share/berelax; \
    ffmpeg -hide_banner -buildconf > /usr/share/berelax/ffmpeg-buildconf.txt; \
    dpkg-query --show --showformat='${Package} ${Version}\n' ffmpeg 'libx26*' \
      > /usr/share/berelax/ffmpeg-packages.txt; \
    test -s /usr/share/berelax/ffmpeg-packages.txt; \
    grep -q -e '--enable-gpl' /usr/share/berelax/ffmpeg-buildconf.txt

COPY --from=deps --chown=node:node /app /app
WORKDIR /app

# libvips' version, read out of the library that is in this image rather than transcribed. It is named in the
# written offer, so it has to be a fact about the image. Loading `sharp` also proves the prebuilt native
# binding resolves against this base image's glibc, which is worth more than reading a JSON file would be.
#
# `--input-type=commonjs` is explicit rather than relying on what `node --eval` infers from a workspace root
# whose package.json says `"type": "module"`, and the version string is built with concatenation rather than a
# template literal so no backslash in this line depends on how the Dockerfile parser treats one.
RUN set -eu; \
    node --input-type=commonjs -e 'const v = require("sharp").versions; process.stdout.write("libvips " + v.vips + " sharp " + v.sharp)' \
      > /usr/share/berelax/libvips-version.txt; \
    test -s /usr/share/berelax/libvips-version.txt

# The notice and the offer, inside the image. `[copyleft-notice-not-copied-into-image]` fails the container
# gate if this line is removed while a copyleft component is still declared.
COPY --chown=node:node apps/worker/licences/THIRD-PARTY-NOTICES.md /usr/share/berelax/THIRD-PARTY-NOTICES.md

# run.ts installs SIGTERM and SIGINT handlers before `boss.start()` so a deploy drains in-flight jobs
# instead of killing a send mid-flight. Declaring the signal is what makes that reachable: the default is
# SIGTERM, and stating it means a future base image changing the default cannot silently turn a drain into
# a kill.
STOPSIGNAL SIGTERM

# The final stage runs as an unprivileged user. `node` is uid 1000 in the official image. A container that
# runs as root gives a process escape the host namespace it was handed, and the gate refuses an image whose
# final stage does not set this.
USER node

CMD ["pnpm", "--filter", "@berelax/worker", "start"]
