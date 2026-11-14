# P1 edit emergency switch and fallback

`PATCH /api/cloud/calculations` authenticates first, then checks
`process.env.MPROF_CALCULATION_EDITS_ENABLED` on every request, before reading JSON
or calling the edit RPC. Only the exact string `true` enables edits. Missing,
`false`, empty or any other value returns 503 `edits_disabled` with
`Cache-Control: no-store`. Authentication failures retain their original response.
Both generic POST endpoints remain closed (410 after authentication). GET and
atomic creation routes are unchanged. No SQL, payment, tariff or financial formula
change is part of this switch.

The existing client treats this HTTP failure as an unsaved edit. It keeps the
original edit operation ID/version for retry; no successful-save event is emitted.
The switch does not cancel an RPC which already passed the guard. Allow in-flight
requests to settle and retain version/idempotency protection.

## Timeweb Cloud operation — requires separate production approval

1. In App Platform, select the production application, then Settings → deployment
   settings → Variables. Add/update the application-local variable
   `MPROF_CALCULATION_EDITS_ENABLED=false`. Do not use `NEXT_PUBLIC_`, next.config
   `env`, a global variable shared with other apps, or a client-side switch.
2. Save and run the approved deployment/restart of the verified commit. A change
   in the panel is not proof that existing Node processes have a new environment.
   Replace/restart every process, replica and separately deployed instance serving
   this route. During a rolling change, old replicas can still accept edits.
3. Confirm the selected commit/deployment and completion for all instances. With
   an owner test session, PATCH must return 503 `edits_disabled`; verify GET works
   and both generic POSTs remain 410. Invalid/absent tokens remain 401.
4. Only after the separately approved P1 migration and schema-cache/permission
   checks, set this variable to the exact string `true` and repeat the approved
   deployment/restart for all instances. Check an edit, replay and stale-version
   conflict with an owner test calculation, without a real payment.
5. Emergency disable: set `false` and replace/restart all instances with the same
   verified code. Confirm 503 everywhere and wait for earlier in-flight requests.
   This operation disables edits only; creation, reads and payments remain available.

Sources: [Timeweb variables](https://timeweb.cloud/docs/apps/variables),
[deployment and commit selection](https://timeweb.cloud/docs/apps/deployment),
[Next.js runtime environment](https://nextjs.org/docs/app/guides/environment-variables).
Hosted execution and full-instance replacement have not been exercised here.

## Fixed-source fallback build

The fallback is this switch-capable commit with the variable `false`, using the
same client/API and retaining closed generic endpoints. Do not choose the former
production commit as fallback: it contains generic service-role writes. Keep the
P1 SQL grants/RLS, six-argument RPC, versions and receipts in place. Do not reset
versions, delete receipts, revive the old RPC or restore the database as routine
application rollback.

A protected local release directory outside the repository contains a source
archive made with `git archive` from the full verified commit and a
`fallback-manifest.json` with source SHA, source archive SHA-256, package-lock
SHA-256, Node/npm versions and build result. No .env files, private keys,
credentials, database backup or untracked files belong in this bundle.

To reconstruct on the target platform, verify both digests from that manifest,
extract the source archive to an empty directory, use Node **24.16.0** / npm
**11.13.0**, and run:

```sh
npm ci
MPROF_CALCULATION_EDITS_ENABLED=false npm run build
MPROF_CALCULATION_EDITS_ENABLED=false npm start
```

Supply the approved environment through the hosting secret store. Public
`NEXT_PUBLIC_*` configuration must match the intended environment at build time;
never substitute local placeholder configuration for production. The full commit
and lock fix the source/dependencies; Next build IDs and platform-specific outputs
need not be byte-identical. The archive digest identifies the delivered source
artifact, not a Linux container image. Local verification is on macOS ARM64; the
Timeweb/Linux build and deployment need separate execution and approval.

## Verification of this change

- Switch/API/client group: 11/11 passed, including zero body reads/RPC calls while
  disabled and the actual client/controller retry after 503 with one operation ID.
- Real isolated PostgreSQL 18.6 P1 group: 19/19 passed, 0 skipped/cancelled. Covers
  successful enabled edits, 409, replay, A commit/lost response/B success/replay A,
  duplicate/concurrent edits, rollback, unchanged quotas/history, direct-write
  restrictions and schema compatibility. A disabled PATCH leaves financial rows,
  operation hashes, receipts and quota unchanged.
- Financial/client regression group: 605/605 passed, 0 skipped/cancelled.
- TypeScript and production build passed with edits disabled. Diff-check passed.
- ESLint before/after: 24 errors / 195 warnings in both; no added diagnostics.
  Existing errors still cause ESLint to exit 1.

No production SQL/configuration, merge, deploy, extra backup or CI addition is
part of this change. The original repository and work branch are not modified.

## Release boundary

After separate release authorization: matching API/client on all instances with
edits disabled → verify generic POSTs closed → SQL migration with verified session
lock_timeout=5s, statement_timeout=60s, transaction_timeout=120s and stop-on-error
(the SQL file already has BEGIN/COMMIT) → confirm COMMIT, NOTIFY/schema cache and
RPC permissions → enable edits explicitly → owner-account smoke checks.

Stop on timeout, unknown COMMIT outcome, accessible generic POST, wrong permissions,
extra quota charge, overwritten newer edit or history mismatch. Disable edits,
keep SQL protections, inspect actual state before retrying an uncertain operation.
No automatic timeout increase, rebase of an old edit or fallback to generic writes.
