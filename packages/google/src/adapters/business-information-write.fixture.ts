/**
 * The two test-only constructors this unit's suites share.
 *
 * A fixture module rather than two copies, because `business-information-write.test.ts` and
 * `../seo/gbp-consistency.test.ts` both need a limiter on a simulated clock and the brief forbids a
 * second statement of a fact without the check that holds the two equal. There is no such check
 * available for a constructor, so there is one constructor.
 *
 * It is a `.fixture.ts`, which the NAP scan and the worked-example convention both already treat as
 * test material rather than as a module that ships.
 */
export {
  businessInformationEditLimit as hoursLimitFor,
  simulatedRateLimitClock as simulatedClockFor,
} from '../rate-limit/token-bucket.ts'
