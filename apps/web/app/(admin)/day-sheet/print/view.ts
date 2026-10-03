import type { CalendarDayRead } from '@berelax/db'
import type { AdminChrome } from '../../../../src/components/admin/google-reauth-banner.ts'
import type { DaySheetAppointmentView, DaySheetPageView } from './render.ts'

/**
 * The day sheet's view, built from one `readCalendarDay` answer (H-HARD-08).
 *
 * ## Why this is its own module and not four lines in `route.ts`
 *
 * Because the acceptance line is *"byte-identical across two runs on the frozen seed"*, and that is a
 * claim about the DATA plus the FORMATTING, not about the HTML template. `apps/web/src/day-sheet.itest.ts`
 * reads a real day twice, builds a view twice and compares the rendered bytes — which it can only do if
 * the formatting is reachable without a `next start`. The same split `app/(admin)/calendar/handler.ts`
 * takes, and for the reason that file gives: a route that held the logic would be a route that could only
 * be tested through a server.
 *
 * ## It holds no clock
 *
 * Deliberately: the formatters are module constants in the business zone and the only dates that reach the
 * document are the trading date and `business_day`'s own session bounds. See `render.ts` on why there is no
 * "printed at" line. `tradingDate` is an argument rather than derived here, because WHICH day to print is
 * the route's decision — a default resolved in two places is the thing that disagrees.
 */

/**
 * Times in the business zone, 24-hour.
 *
 * `hour12: false` is not a style choice on a sheet whose whole subject is that the session crosses
 * midnight: `1:30 am` and `01:30` are read differently at 02:00 by somebody counting rooms.
 */
const DUBAI_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** The wall-clock date in the business zone, which is what decides "after midnight". */
export const DUBAI_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' })

export function daySheetViewFor(args: {
  readonly chrome: AdminChrome
  readonly tradingDate: string
  /** Null when `business_day` holds no session for the date, which is a closure and not an error. */
  readonly day: CalendarDayRead | null
}): DaySheetPageView {
  const { chrome, tradingDate, day } = args
  const therapistReference = new Map(
    (day?.therapists ?? []).map((therapist) => [
      therapist.therapistId,
      // The handle, or the id when no employment record carries one. Never a name and never a fabricated
      // label: an id on paper is ugly and honest (ADR 0020, brief rule 10).
      therapist.reference ?? therapist.therapistId,
    ]),
  )
  const roomCode = new Map((day?.rooms ?? []).map((room) => [room.roomId, room.code]))

  return {
    chrome,
    tradingDate,
    session:
      day === null
        ? null
        : {
            opensAtLabel: DUBAI_TIME.format(new Date(day.opensAt)),
            closesAtLabel: DUBAI_TIME.format(new Date(day.closesAt)),
          },
    appointments: (day?.appointments ?? []).map(
      (appointment): DaySheetAppointmentView => ({
        // Eight characters of the id. A whole uuid on paper is transcribed wrongly; eight hex characters
        // distinguish every treatment a salon will ever have in one day, and the id is still the authority.
        reference: appointment.id.slice(0, 8),
        startsAtLabel: DUBAI_TIME.format(new Date(appointment.treatment.startsAt)),
        endsAtLabel: DUBAI_TIME.format(new Date(appointment.treatment.endsAt)),
        roomCode: roomCode.get(appointment.roomId) ?? appointment.roomId.slice(0, 8),
        therapistReferences: appointment.therapistIds.map((id) => therapistReference.get(id) ?? id),
        serviceLabel: appointment.serviceLabel,
        status: appointment.status,
        /*
          After midnight means the treatment's own wall-clock DATE is not the trading date.

          Compared as dates rather than against a clock hour, because "after midnight" is not "before
          02:00": a session's close is `business_day.closes_at` and an override can move it, so a rule
          keyed on 02:00 would mark the wrong rows the first time somebody shortens a Ramadan evening.
        */
        afterMidnight: DUBAI_DATE.format(new Date(appointment.treatment.startsAt)) !== tradingDate,
      }),
    ),
    roomCodes: (day?.rooms ?? []).map((room) => room.code),
  }
}
