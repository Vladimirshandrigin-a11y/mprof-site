# P1 quota and atomic history validation

Base: `mprof-production` at `3797f5cf70c4139eb8441252addbfff07c2945e9` (verified again before PR preparation).
Work resumed from `aa1329b082ad8a0414ac1b00c6eb42c367c74ded` on `fix/quota-atomic-saves-local-2026-11-14` in an independent local clone.

## Failure analysis

The previous DB run executed all 155 tests: 144 passed, 11 failed, none skipped or cancelled.
Ten failures in `tests/db/quota-atomic-edits.test.mjs` shared a test-contract mistake: the creation endpoint returns `{ data: { calculationId, ... } }`, but the test helper spread the outer response. The resulting undefined ID either failed the helper assertion or produced a 400 / `bad_request` before the intended database check. The manual test made the same mistake directly.

| Previously failing scenario | Exact cause |
| --- | --- |
| Direct INSERT/UPDATE permissions, owner read/delete | Missing calculation ID in test helper |
| Edit IDs, chronology and quota | Missing ID; PATCH rejected malformed request |
| Foreign owner / spoofed fields | Missing ID; 400 instead of intended owner check |
| Immutable source / mode / marketplace | Missing ID passed to RPC; bad_request instead of source_conflict |
| Legacy read-only history | Fetch adapter treated GET `order` as an unsupported filter; route returned an error, not `data` |
| Missing / foreign linked history | Missing ID; history linkage check never reached |
| History failure rollback | Missing ID; injected database failure never reached |
| Concurrent edits / lost response | All PATCH requests had missing IDs |
| Older same-month edit | Missing ID; update never reached database |
| Manual edits / API protection | Read `body.calculationId` instead of `body.data.calculationId` |
| Migration compatibility / no migration | Missing ID; malformed request rejected before RPC lookup |

The test helper now unwraps `data` and asserts that an ID exists. The adapter implements the actual GET order/limit parameters with validated identifiers and a parameterized limit. Assertions on security outcomes were retained. The complete P1 database group passed 14/14 after these corrections.

The previous financial regression run executed 589 tests: 586 passed, 3 failed. All three expected an additional history row after an edit (save/edit, edit/revert, failed edit/retry). The atomic RPC updates the operation's existing history row, retaining its ID and created_at; real PostgreSQL tests confirm this. The WIP already updated those three expectations, and their targeted rerun passed 3/3.

A separate WIP expectation was inadvertently changed for *deletion followed by a new calculation*. That is a new metered operation, so it must create a second history row. Restored the expectation to two and verified the same lifecycle against PostgreSQL, including preservation of the first monthly row after deleting its calculation.

## Actual client defect fixed

An edit could COMMIT while its response was lost. The client retained its previous confirmed content key. If the user then reverted inputs to those previous values, save returned `unchanged` while the database still held the edited values.

A regression test reproduced this before the fix. The controller now invalidates both confirmation keys before sending an edit and restores them only on success. Retrying or reverting after an uncertain response updates the existing calculation and linked history together, without inserting rows or consuming quota. The test checks both saved tax/profit values and unchanged row/charge counts.

Also removed unused remnants of the deleted legacy saving path and corrected legacy UI labels that still promised saving. No tariff, financial formula, payment implementation or dependency versions changed.

## Final checks

| Check | Result |
| --- | --- |
| `npm run test:db` | **160/160 passed**, 0 failed/skipped/cancelled |
| `npm run test:accrual` | **594/594 passed**, including new lost-edit-response regression |
| `tsc --noEmit` | Passed |
| `npm run build` | Passed, production Turbopack build and static generation |
| `git diff --check` | Passed |
| Real PostgREST 16.5 schema cache integration | **1/1 passed**, missing RPC → migration/NOTIFY → successful edit/replay; browser roles denied |
| ESLint comparison | Baseline 24 errors / 212 warnings; final 24 errors / 195 warnings; **no added diagnostics**, 17 removed |

ESLint still exits 1 because of the 24 existing errors. Comparison matches file, rule, severity and message, excluding relocated code-frame line numbers. It does not suppress lint rules or represent the repository as lint-clean.

DB tests use a separate local PostgreSQL 18.6 cluster with disposable databases and synthetic users. Actual API handlers and supabase-js call a test HTTP adapter backed by real PostgreSQL transactions. GoTrue JWT signature verification and the actual managed Supabase deployment are outside this local test boundary. A separate integration check uses real local PostgREST 16.5 with signed synthetic JWTs against a disposable PostgreSQL database.

SQL/RLS checks cover anon/authenticated direct writes in every mode, column and PUBLIC grants, restrictive policies even after accidental broad grants against populated tables, accidental EXECUTE grants, service-only edits, owner isolation, API edit rejection, immutable source/period, legacy rows, missing/foreign history, rollback, concurrent edits, replay/deletion, free/single/unlimited/expired quotas, migration idempotency, unchanged historical data and full-schema parity.

The sandbox initially blocked PostgreSQL localhost connections and Turbopack's internal port. Both checks were rerun with authorized local execution and passed. No cloud database was used.

## Release boundaries and remaining risks

- This PR is for review only. No merge, deployment or production SQL has been performed. The original local repository, `work` branch and old cloud workspace remain untouched.
- `supabase/migrations/20261113221918_quota_atomic_edits.sql` requires a separately authorized production migration. It changes privileges/policies and adds functions; it does not rewrite existing financial records or invent operation links.
- After separate release approval, release the API/client that closes generic writes, then apply the migration in the approved release window. Until the migration is applied, edits fail closed with 503 `migration_missing`; existing atomic creation routes remain available. The direct-table bypass is closed only when the migration is applied. Do not treat the code-only release as a completed P1 rollout.
- Old clients using generic creation/history endpoints receive 410 and must reload. Historical calculations without a verified operation remain view/PDF-only. Missing/shared history links fail closed rather than recreate history.
- Do not roll back to the old generic service-role write endpoints: that would reopen the bypass even with restrictive client RLS. Any rollback must retain the closed endpoints and write restrictions.
- Local PostgreSQL proves transaction/grant/RLS behavior, not the deployed platform configuration. Production migration and post-release smoke checks still require approval. Browser end-to-end interaction and PDF download were not exercised in this verification run.

## Independent review fixes (after 347a557)

- Calculations carry `edit_version` (metadata, initially 0). PATCH requires `expectedVersion` and `editOperationId`. The server checks the expected version under the existing PostgreSQL locks, increments it in the same transaction as both financial rows, and records a hash-bound edit receipt. The receipt and version roll back with any failure. Browser roles have no access to receipts or version updates; the old four-argument RPC is removed.
- A replay of the same edit only acknowledges its committed revision; after a subsequent edit it returns HTTP 409 `version_conflict` without writing anything. Reusing an edit ID with changed data returns 409. The client retains the original ID/version/payload after an uncertain response, resolves it before sending changed inputs, and never automatically rebases a conflicted edit onto a newer version.
- Required regression passes: A commits, response is lost, B succeeds, retry A returns 409 and preserves B, history and quota. Concurrent distinct edits accept exactly one version; duplicate requests share one receipt. Immediate lost-response replay and rollback/retry also pass. Client and PostgreSQL coverage are separate.
- All existing manual/Ozon API save/replay/transaction and three-mode concurrency groups now apply the P1 migration too. Free shared quota, 149 ₽ credit without API access, and 449 ₽ access are covered on the final schema. A new unlimited manual/API/XLSX race preserves the usage counter.
- Historical UPD reads only persisted financial product rows (with saved costs/profits), consistent with the saved totals. Raw Ozon rows are insufficient. Missing, damaged or inconsistent detail produces an explicit unavailable message in the screen and PDF, with no current catalog lookup, editor or substituted product ranking. Original financial data and formulas are unchanged.
- The migration sends `NOTIFY pgrst, 'reload schema'` after COMMIT. The real PostgREST test starts before migration, confirms PGRST202, applies the migration, and observes the new RPC without restarting PostgREST or manually refreshing its cache. Service edit/replay works; anon/authenticated calls are denied.

Reproduction of the additional integration check (after `npm run test:db` compiles the shared helpers):

```sh
POSTGREST_BIN=/path/to/postgrest \
DB_TEST_BUILD_DIR="$PWD/node_modules/.cache/db-tests/build" \
TEST_DATABASE_URL=postgres://test-user:test-password@127.0.0.1:55437/postgres \
node --test tests/db/postgrest-schema-cache.integration.mjs
```

The integration test requires an actual binary and fails rather than silently skips when it is missing. The verified macOS ARM64 PostgREST 16.5 archive SHA-256 was `d8095cb439de0a3151036df542139e7afca5cebb109ce7f1bae52b3a97e9846a`; it and its runtime remain outside the repository. This does not establish the version/configuration of hosted PostgREST.

### Release and rollback

1. After separate release approval, deploy the matching Next.js API/client to all instances. Generic POSTs must be closed everywhere. Before SQL, edits return 503; the direct-table bypass is not yet closed. Old edit clients lacking concurrency metadata must reload.
2. Apply the reviewed migration in the approved window. It adds concurrency metadata/receipts and restrictions without changing monetary columns. Allow for the table DDL lock; if migration fails, keep edits closed and investigate rather than restoring generic writes.
3. Let the post-COMMIT NOTIFY refresh PostgREST; verify the six-argument RPC resolves with the intended service/browser permissions. Until it resolves, 503 is expected.
4. Check creation/replay, conflict 409, history IDs/dates, quota and tariff behavior through the deployed API using approved test accounts. Only then declare P1 released.
5. Rollback retains closed generic endpoints and SQL write restrictions. Disable edits temporarily or deploy a compatible fix. Do not restore the old four-argument edit RPC or service-role generic writes, remove receipts, or reset versions. Retain edit receipts for the calculation lifetime; deleting a calculation cascades its receipts.

Remaining limits: no production SQL or deploy, no managed Supabase/GoTrue smoke checks, and no browser/PDF-download E2E. UI/PDF use the same validated saved detail path; local tests cover the saved/missing/corrupt detail contract. Existing 24 lint errors remain, with no new diagnostics.
