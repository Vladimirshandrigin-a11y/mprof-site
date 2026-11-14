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
| `npm run test:db` | **155/155 passed**, 0 failed/skipped/cancelled |
| `npm run test:accrual` | **590/590 passed**, including new lost-edit-response regression |
| `tsc --noEmit` | Passed |
| `npm run build` | Passed, production Turbopack build and static generation |
| `git diff --check` | Passed |
| ESLint comparison | Baseline 24 errors / 212 warnings; final 24 errors / 195 warnings; **no added diagnostics**, 17 removed |

ESLint still exits 1 because of the 24 existing errors. Comparison matches file, rule, severity and message, excluding relocated code-frame line numbers. It does not suppress lint rules or represent the repository as lint-clean.

DB tests use a separate local PostgreSQL 18.6 cluster with disposable databases and synthetic users. Actual API handlers and supabase-js call a test HTTP adapter backed by real PostgreSQL transactions. GoTrue JWT signature verification and the actual managed PostgREST service are outside this local test boundary.

SQL/RLS checks cover anon/authenticated direct writes in every mode, column and PUBLIC grants, restrictive policies even after accidental broad grants against populated tables, accidental EXECUTE grants, service-only edits, owner isolation, API edit rejection, immutable source/period, legacy rows, missing/foreign history, rollback, concurrent edits, replay/deletion, free/single/unlimited/expired quotas, migration idempotency, unchanged historical data and full-schema parity.

The sandbox initially blocked PostgreSQL localhost connections and Turbopack's internal port. Both checks were rerun with authorized local execution and passed. No cloud database was used.

## Release boundaries and remaining risks

- This PR is for review only. No merge, deployment or production SQL has been performed. The original local repository, `work` branch and old cloud workspace remain untouched.
- `supabase/migrations/20261113221918_quota_atomic_edits.sql` requires a separately authorized production migration. It changes privileges/policies and adds functions; it does not rewrite existing financial records or invent operation links.
- After separate release approval, release the API/client that closes generic writes, then apply the migration in the approved release window. Until the migration is applied, edits fail closed with 503 `migration_missing`; existing atomic creation routes remain available. The direct-table bypass is closed only when the migration is applied. Do not treat the code-only release as a completed P1 rollout.
- Old clients using generic creation/history endpoints receive 410 and must reload. Historical calculations without a verified operation remain view/PDF-only. Missing/shared history links fail closed rather than recreate history.
- Do not roll back to the old generic service-role write endpoints: that would reopen the bypass even with restrictive client RLS. Any rollback must retain the closed endpoints and write restrictions.
- Local PostgreSQL proves transaction/grant/RLS behavior, not the deployed platform configuration. Production migration and post-release smoke checks still require approval. Browser end-to-end interaction and PDF download were not exercised in this verification run.
