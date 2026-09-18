/**
 * @berelax/harness — the screenshot harness, the gallery and the self-critique pass.
 *
 * Screenshots are a feedback signal, not just evidence (docs/12 §5). The pixel diff catches *change*;
 * the critique pass catches *wrong*, including on the first render, when there is no baseline to diff
 * against and a defect that has been there since the first commit is invisible.
 */
export {
  type AccessibilityResult,
  AXE_TAGS,
  type AxeViolation,
  auditPage,
  type Impact,
  uniqueViolations,
} from './accessibility.ts'
export {
  accessibilityResults,
  type Capture,
  type CaptureHarness,
  createCaptureHarness,
  critiqueResults,
  type HarnessOptions,
  type PageSource,
} from './capture.ts'
export {
  BODY_TEXT_RATIO,
  type CritiqueContext,
  type CritiqueResult,
  type CritiqueSeverity,
  critiqueInPage,
  critiqueInputFor,
  type Finding,
  MAX_MEASURE_CH,
  summarise,
  TOUCH_TARGET_DESKTOP,
  TOUCH_TARGET_MOBILE,
  UI_COMPONENT_RATIO,
  uniqueFindings,
} from './critique.ts'
export { DETERMINISM_CSS, freezePageEnvironment } from './determinism.ts'
export { type GalleryOptions, renderGalleryHtml } from './gallery.ts'
export {
  type CaptureTarget,
  captureFilename,
  DIRECTIONS,
  type Direction,
  parseCaptureFilename,
  THEMES,
  type Theme,
  targetsFor,
  VIEWPORTS,
  type Viewport,
} from './matrix.ts'
export { renderNonCompliantSpecimenHtml } from './non-compliant.ts'
export { renderSpecimenHtml, type SpecimenOptions } from './specimen.ts'
export {
  auditTouchTargetsInPage,
  TOUCH_TARGET_SELECTOR,
  type TouchTargetFinding,
  type TouchTargetInput,
  type TouchTargetRule,
  touchTargetInputFor,
  uniqueTouchTargetFindings,
} from './touch-targets.ts'
