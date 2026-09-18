# Third-party fonts embedded in generated documents

Both faces are embedded in every PDF this package produces, as base64 `data:` URLs read from pinned
npm packages at render time. Nothing is vendored into this repository; the packages are the source of
truth and the lockfile pins them.

| Family | Package | Licence |
|---|---|---|
| IBM Plex Sans | `@fontsource/ibm-plex-sans` | SIL Open Font License 1.1 |
| IBM Plex Sans Arabic | `@fontsource/ibm-plex-sans-arabic` | SIL Open Font License 1.1 |

The OFL permits embedding in a document without further conditions, including for commercial use.
The full licence text ships inside each package as `LICENSE`.

They are one family designed together, which is why they sit beside each other in a bilingual table
without the Latin column reading a size off the Arabic one. Four faces are embedded — regular and
semibold in each script — and that is a budget, not an accident: every face is a font subset carried
by every document. See `src/fonts.ts`.
