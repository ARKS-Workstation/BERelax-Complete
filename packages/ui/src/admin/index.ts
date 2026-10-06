/**
 * The admin chrome's entry point.
 *
 * An `index.ts` rather than pointing `./admin` straight at `shell.ts`, matching `./layout` and
 * `./patterns`. It is not only convention: `packages/fixtures/src/hr-leave-approval.test.ts` walks imports
 * and resolves a `@berelax/x/y` specifier to `packages/x/src/y`, so a subpath that is a directory with no
 * index is a hole in that walk — and that test fails on a hole rather than quietly shrinking its answer.
 */
export {
  ADMIN_SHELL_CSS,
  type AdminChromeOptions,
  renderAdminChromeClose,
  renderAdminChromeOpen,
} from './shell.ts'
