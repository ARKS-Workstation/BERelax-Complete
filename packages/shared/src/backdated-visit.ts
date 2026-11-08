/**
 * How far back a visit that happened may be entered — the one figure the backdating gate needs.
 *
 * A SETTING and not a constant, for the reason `backdatedVisitVerdict` records on `horizonDays`: it is a
 * judgement about how this salon works, not a property of the domain. The two failures point in opposite
 * directions and neither is discoverable from a screenshot.
 *
 *   - **Too short** and a Friday walk-in cannot be entered on Monday, which is the ordinary case the
 *     feature exists for. The desk's answer is then to type a date the gate accepts, which is a false row
 *     in the diary and false money in the day's takings — the exact outcome a horizon is meant to prevent.
 *   - **Too long** and a mistyped year writes a treatment into a month whose figures have been reported.
 *     The period lock catches that only once money is attached; the diary row lands either way.
 *
 * Fourteen days is the provisional answer and it is the short-ish direction on purpose. A desk that needs
 * longer asks, and the asking is the control: someone with `settings:write` widening the window leaves an
 * audit row, where a wide default leaves none. It is listed in the Unconfirmed Assumptions panel until the
 * owner answers how long after a visit the books may still be corrected.
 */
export const BACKDATED_VISIT_HORIZON_SETTING_KEY = 'booking.backdated_visit_horizon_days'

/** Fourteen days. See {@link BACKDATED_VISIT_HORIZON_SETTING_KEY} for why the short direction is safe. */
export const PROVISIONAL_BACKDATED_VISIT_HORIZON_DAYS = 14
