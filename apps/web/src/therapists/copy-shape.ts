/**
 * The shape both therapist copy modules satisfy.
 *
 * A separate module from the two copies for the reason `treatments/content.ts` keeps `TreatmentCopy`
 * separate: the shape is a claim about what the pages render and the copy is a claim about one language,
 * and a `Record` keyed on the skill enum means a skill added to `therapist_skill` is a type error in both
 * locales at once rather than an enum value printed raw on a public page.
 */
export interface TherapistsAlternativesCopy {
  readonly title: string
  readonly lede: string
  readonly nearestDays: string
  readonly otherTherapists: string
  readonly waitlist: string
  readonly waitlistRefused: (reason: string) => string
  readonly noDays: string
  readonly noTherapists: string
}

export interface TherapistsCopy {
  /** What this locale calls its home page, for the breadcrumb. */
  readonly home: string
  readonly index: {
    readonly title: string
    readonly lede: string
    readonly empty: string
    /** What a card shows instead of a name. docs/13 §8 states this is the launch state. */
    readonly unnamedTherapist: string
    /** The label on the reserved 4:5 box while `Y12-photos` is open. */
    readonly provisionalPortrait: string
  }
  readonly detail: {
    readonly specialisms: string
    readonly languages: string
    readonly languagesUnknown: string
    readonly availability: string
    readonly bookWith: (name: string) => string
    readonly noVariant: string
    readonly alternatives: TherapistsAlternativesCopy
  }
  /**
   * One label per `therapist_skill` value.
   *
   * Total over the enum, asserted in `content.test.ts` against `THERAPIST_SKILLS` — a skill with no label
   * is dropped by `qualificationPhrase` rather than printed, so without the assertion a new enum value
   * would silently vanish from every card instead of appearing untranslated.
   */
  readonly skills: Readonly<Record<string, string>>
  readonly skillJoin: string
}
