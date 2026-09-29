/**
 * @berelax/hr — the employment record, and staff PII under field-level envelope encryption.
 *
 * ## Why this is a package and not `packages/db/src/repositories/employee.ts`
 *
 * The manifest's file list for P-HR-01 names that path, and it cannot be used: `packages/db` may not
 * import `@berelax/clinical`, whose envelope this reuses, because `@berelax/clinical` already imports
 * `@berelax/db` (its Postgres key store writes an audit row through `AuditWriter`). The import closes a
 * cycle and `pnpm boundaries` refuses it by name — checked rather than assumed:
 *
 *   error no-circular: packages/clinical/src/crypto/postgres-key-store.ts →
 *       packages/db/src/index.ts → packages/db/src/repositories/<the probe> →
 *       packages/clinical/src/index.ts → packages/clinical/src/crypto/postgres-key-store.ts
 *
 * The alternative to a package would be a second copy of the envelope inside `packages/db`, which is two
 * AES-GCM implementations and two chances to get the AAD wrong — the thing
 * `packages/google/src/token-store.ts` argues against in so many words.
 *
 * So this package has exactly the shape `packages/google` has: an estate with its own key-encrypting
 * key, its own AAD binding, its own re-wrap primitive, and SQL that moves sealed columns without ever
 * holding a key. The Drizzle mirrors stay in `packages/db/src/schema` with every other mirror, because
 * `pnpm db:drift` and `pnpm db:conventions` read those directories and a schema hidden elsewhere is a
 * schema neither gate checks.
 */
/*
  P-HR-11's commission run. Here and not in `packages/db` because a run needs both halves at once — the
  arithmetic is `@berelax/core`'s and the rows are `@berelax/db`'s, and that package may not import the
  first — so this package, which already depends on both, is the only place they meet.

  `recomputeCommissionRun` is deliberately a SEPARATE function from `executeCommissionRun` rather than the
  same one with an optional version: everything that decided a run's answer comes off the run row, and one
  function doing both is the shape in which somebody later forgets to pass it.
*/
export {
  type CommissionRunResult,
  type ExecuteCommissionRunArgs,
  executeCommissionRun,
  type RecomputeCommissionRunArgs,
  readCommissionDerivationFor,
  recomputeCommissionRun,
} from './commission-run.ts'
export {
  createEmployeeRepository,
  type EmployeeRepository,
  type StaffAccess,
} from './employee-repository.ts'
/*
  P-HR-12's payroll run and WPS export. Here for `commission-run.ts`'s reason: a run needs both halves at
  once, and `packages/db` may not import `packages/core`.

  `executePayrollRun` takes the commission run as an ARGUMENT rather than resolving one. Which commission run
  a payroll pays is a decision — a month may have been recomputed three times and the one that was paid is
  not necessarily the newest — so it is the caller's to state and the payslip's to record.

  `exportWpsFile` returns a string and records that it did. There is no submit path in it or anywhere else:
  absent, not disabled, which is docs/04 SS4's rule for VAT201 applied where the consequence is larger.
*/
export {
  type CommissionRunPin,
  type ExecutePayrollRunArgs,
  type ExportWpsFileArgs,
  executePayrollRun,
  exportWpsFile,
  type PayrollRunResult,
  readPayslipFor,
  validateWpsFile,
  type WpsContactSource,
  type WpsExportResult,
} from './payroll-run.ts'
export {
  type BankDetail,
  openBankDetail,
  openDocumentNumber,
  rewrapStaffSecret,
  type SealedStaffSecret,
  STAFF_SEALED_TABLES,
  STAFF_SECRET_ERRORS,
  type StaffSealedTable,
  type StaffSecretBinding,
  sealBankDetail,
  sealDocumentNumber,
  staffKek,
  staffSecretBinding,
} from './staff-secret.ts'
