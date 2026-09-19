# Third-party notices — the BE RELAX worker image

This file ships **inside** the worker image, at `/usr/share/berelax/THIRD-PARTY-NOTICES.md`. It is here
rather than only in the repository because the obligations below attach to the image, not to the source
tree, and `scripts/check-container.mjs` (`[copyleft-notice-not-copied-into-image]`) fails the build if the
Dockerfile stops copying it.

Two components in this image carry copyleft licences. Neither asks for BE RELAX's own source. Both ask for
a notice, the licence text, and an offer.

---

## libvips — LGPL-3.0-or-later

**What it is.** The image-processing library behind `sharp`, which is the whole derivative pipeline
(W-SYS-05): the two art-directed ladders, AVIF/WebP/JPEG encoding and the colour management in
docs/08 §6. It arrives as the prebuilt shared library in `@img/sharp-libvips-linux-x64`.

**Licence text in this image.** `/usr/share/common-licenses/LGPL-3` and `/usr/share/common-licenses/GPL-3`
— LGPL-3.0 incorporates the terms of GPL-3.0 by reference, so both are required for the text to be
complete. Debian's `base-files` package provides them and the Dockerfile asserts they are present.

**How it is linked.** `libvips-cpp.so` is a shared library, loaded at runtime by `sharp`'s N-API binding.
It is **not** statically linked into anything BE RELAX wrote, and it is **not** modified. That is what keeps
this an LGPL §4 "Combined Work" using a shared library, and it is why the licence asks for a notice and an
offer rather than for source.

**Offer.** The complete corresponding source for the version of libvips in this image, and the object code
needed to relink it, are supplied on request for three years from the date this image was built. The
version is recorded in the image at `/usr/share/berelax/libvips-version.txt`, written at build time from
the installed package rather than transcribed here. Requests go to the business contact recorded in the
`premises` row; the specific address for licence correspondence is **not yet set** — `Y12-licence-contact`
in `docs/OPEN-QUESTIONS.md`. It is deliberately blank rather than guessed: an address that does not reach
anybody is worse than a visibly unanswered one, because it looks configured.

**Right to replace.** Nothing in this image prevents replacing `libvips-cpp.so` with a modified version of
the same interface. `node_modules/@img/sharp-libvips-linux-x64/lib/` holds it, the file is not signed and
`sharp` resolves it by path, so the LGPL §4(d)(1) obligation is satisfied by the mechanism that is already
there rather than by an added one.

**One thing worth recording,** because it is why this file exists at all: the
`@img/sharp-libvips-linux-x64` package ships **no copy of the LGPL text**. Its contents are `README.md`,
`package.json`, `versions.json` and `lib/`. An image built by copying `node_modules` therefore carries the
library and not its licence, which is the obligation unmet — and nothing in `pnpm install`, `pnpm licences`
or a code review would have said so. Debian's own copy is used instead, and the Dockerfile asserts it is
there.

---

## ffmpeg, libx264 and libx265 — GPL-2.0-or-later (GPL-3.0-or-later where `--enable-version3` applies)

**What it is.** The hero video rendition encoder (W-SYS-06): four renditions per master, H.264 High and
HEVC `hvc1`, at the two art-directed crops, ping-ponged into a seamless loop.

**Which build, and why it is GPL.** Debian bookworm's `ffmpeg` package, configured `--enable-gpl` with
`libx264` and `libx265`. ffmpeg's own code is LGPL-2.1-or-later; **libx264 and libx265 are
GPL-2.0-or-later**, ffmpeg's `configure` refuses to include either without `--enable-gpl`, and the
resulting binary is therefore GPL. The exact configure line of the installed build is recorded in the
image at `/usr/share/berelax/ffmpeg-buildconf.txt`, and `resolveFfmpeg()` in
`packages/media/src/video/encode.ts` reads it back at runtime and **refuses to encode** if the licence it
detects is not one this notice covers (`[ffmpeg-build-licence-unexpected]`). A notice recorded against one
binary says nothing about a different one.

**Why not an LGPL build.** This was considered and rejected on the facts. docs/08 §6 and this unit's
acceptance specify `-profile:v high -level 4.0 -crf 26`, `-crf 28 -level 3.1` and HEVC `hvc1`. `-crf` is an
x264/x265 option and High profile is an x264 capability. The LGPL-compatible alternatives do not reach it:
**OpenH264** (BSD-2-Clause) encodes Constrained Baseline only and takes a bitrate rather than a CRF, and
**kvazaar** (LGPL-2.1-or-later) covers HEVC Main but not H.264 at all. An LGPL build would therefore
produce renditions nobody specified, and the honest choice is the GPL build with the obligation written
down rather than a quieter build with a different output.

**Offer.** The complete corresponding source for ffmpeg, libx264 and libx265 as installed in this image is
supplied on request for three years from the date the image was built, under the terms of GPL-2.0-or-later
(and GPL-3.0-or-later where it applies), at no more than the cost of distribution. The exact package
versions are recorded at `/usr/share/berelax/ffmpeg-packages.txt`, written at build time. Requests go to
the same address as above, which is `Y12-licence-contact` and is not yet set.

**How it is used, and what that means for BE RELAX's own source.** ffmpeg is invoked as a **separate
process**, through `execFile` with an argument vector — `packages/media/src/video/encode.ts` passes a
filename and encoder flags and reads an exit status and a file. Nothing in this repository links against
`libavcodec`, includes an ffmpeg header, or passes it an internal data structure. The two programs are
aggregated on one filesystem and communicate over a command line, which is the FSF's own example of
programs that are not one work; so the GPL obligation here is to convey ffmpeg's source and licence, and it
does not extend to BE RELAX's code. **If that ever changes** — a native binding, a static link, an
in-process `libav*` call — this paragraph stops being true and the obligation becomes a different and much
larger one.

**Patent licensing is a separate question and is not answered here.** AVC and HEVC are covered by patent
pools (Via LA for AVC, Access Advance and Via LA for HEVC, plus holders outside both). Copyright licences
say nothing about them, and whether this business owes anything for encoding and self-hosting a
seven-second decorative loop on its own website is a legal question rather than a build decision. It is
recorded as `Y12-video-patents` in `docs/OPEN-QUESTIONS.md`, and the provisional position is the strict one:
the pipeline exists, no real footage has been encoded, and nothing is published until it is answered.

---

## Everything else

Every other dependency in this image is permissive — MIT, Apache-2.0, ISC, BSD or equivalent — and is
classified package by package by `scripts/check-licences.mjs` against `build/licence-policy.json`, over the
resolved lockfile graph rather than over declared dependencies. That gate refuses strong copyleft in the
npm closure outright and requires an `accepted` entry, with its obligation stated, for weak copyleft. The
two components above are **not** npm packages of ours — one arrives inside a prebuilt binary package, the
other is an operating-system package — which is why they are declared in `build/container-policy.json`
under `imageComponents` and enforced by `pnpm container` instead.
