# P1: operation response edit_version

## Cause and scope

Base: `mprof-production` at `20bdb447ea40c5211bd1010ca389dce99517367f`.
`calculation_operation_saved(uuid)` explicitly builds the saved calculation JSON.
PR #120 added `calculations.edit_version` but did not add it to that projection.
Creation, replay and operation lookup all use this helper. The API passes the JSON
through; the TypeScript types and client parser already accept the version. The
save controller correctly refuses an edit when it has no confirmed version.

The fix adds only `'edit_version', c.edit_version` to the helper's projection.
It returns the actual version alongside the same saved row/snapshot, including
nonzero versions after edits. It does not default missing versions to zero or
perform a separate read that could pair a newer version with an older snapshot.
No production API/client code change or application deployment is needed to make
this fix work with the current application SHA.

Migration: `supabase/migrations/20261115180805_operation_saved_edit_version.sql`.
SHA-256: `48c945606fb52f044d6f96685c6345ededf56850bf35073590bde79e14e8aed7`.
The final schema includes the replacement after the edit_version column exists.
Existing migrations are unchanged. This is a function replacement, with no table
data rewrite. Signature, owner, STABLE/SECURITY DEFINER/search_path and internal-only
EXECUTE permissions remain unchanged. Financial formulas, payload hashes, edit
receipts, locks, quota rules, payments, plans and subscriptions are unchanged.

## Isolated regression evidence

The regression failed against the current production SQL chain: the real client
received `undefined` instead of version 0 and its controller stopped before PATCH.
With this migration, tests execute the actual client, save controller, Next route
handlers and supabase-js against real PostgreSQL 18.6. Auth and PostgREST transport
are local test adapters; SQL results, JSON responses, transactions, grants and row
locks are real. These are integration E2E tests, not a browser/UI or production run.

Covered by `tests/db/quota-atomic-edits.test.mjs`:

- Creation -> version 0 -> sequential and concurrent replay -> operation status.
- History GET -> recovery -> PATCH with the confirmed version -> version 1;
  same calculation/history IDs and chronology; expected profit 514.13.
- Replaying creation/status after an edit returns version 1 and the current
  snapshot, rather than a fabricated zero or historical financial values.
- Same edit key replays once; stale version returns HTTP 409 without overwriting.
- A commits/response is lost -> B recovers version 1 and succeeds -> A retries
  its original key/version and receives 409; B and quota remain intact.
- Immediate retry of a lost edit response reuses the original key/version.
- Manual creation/status/replay also preserve the actual version.
- Foreign status/read/edit are denied; disabled PATCH returns 503 without writes.
- Upgrading existing rows preserves data and helper ACL/settings; repeating the
  migration is safe in isolation; fresh schema and migration definitions match.

Full validation: 168/168 DB tests, 605/605 financial/client tests, no skips.
The DB suite also covers concurrent edits, rollback, owner isolation and
free/single/unlimited/expired quotas. An existing route-boundary test now explicitly
enables edits only in its isolated process, so it reaches the parser/RLS checks;
the disabled switch is independently exercised. Lint baseline remains 24 errors
and 195 warnings, with no added diagnostics. TypeScript, production build (with
edits disabled) and `git diff --check` passed. The sandboxed Turbopack attempt
could not bind its worker port; the same build passed with local process/port
permissions. No application code or build configuration was changed for this.

## Separate production release authorization required

This PR does not authorize merge, deploy, production SQL or enabling editing.
The migration has been run only against synthetic isolated databases.

1. Review the PR and its exact migration digest. Coordinate merge separately:
   merging a tracked production branch can trigger hosting automation. Keep
   `MPROF_CALCULATION_EDITS_ENABLED=false` throughout this release.
2. Before SQL, verify the intended production project/TLS verify-full, app SHA,
   PATCH 503 and generic POST 410. Read-only preflight must confirm the P1 column,
   existing helper signature/owner/ACL, retained RLS hotfix and no blockers.
3. With separate SQL approval, apply **only** this new migration. Do not reapply
   PR #120 or RLS hotfix. Set and verify session lock_timeout=5s,
   statement_timeout=60s and transaction_timeout=120s; use ON_ERROR_STOP and the
   file's own BEGIN/COMMIT, without an outer transaction or psql -1. Stop on the
   first error; classify an unknown COMMIT read-only before any retry.
4. Confirm COMMIT and NOTIFY/schema cache, unchanged grants/RLS and data. Use an
   already existing owner smoke operation to compare its status version/snapshot
   with its saved calculation. No new production calculation is needed for this
   read-only acceptance. Recheck PATCH 503 and generic POST 410, then stop.
5. Enabling production edits and any subsequent writing smoke require a separate
   authorization. The existing emergency switch protocol still applies.

If acceptance differs, keep edits disabled and inspect read-only. Do not reset
versions/receipts, change quotas, revive generic writes or auto-retry unknown
outcomes. No automatic database restore or rollback migration is proposed.
