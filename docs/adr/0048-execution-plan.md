# ADR-0048 — execution plan for ADR-0020 (Send provider adapter modules)

> Companion execution plan for [ADR-0020](./0020-send-provider-adapter-modules.md).
> Renumbered from `0020-execution-plan.md` to its own unique ADR number so the
> `000X` prefix is unambiguous (one document per number).

Phased migration for the Send provider adapter modules ADR. Each phase
is one shippable PR. Existing tests pass at every phase boundary;
behavior is unchanged until the caller-cutover phase, which switches
every send producer to the new `sendProviderDispatch` helper in one
atomic move.

This is a pure refactor — no schema changes, no wire-visible changes,
no feature flags. The `providerHealth` table, the `providerRoutes`
table, the `EmailProviderType` literal set, and the `strategy` literal
set are all unchanged.

## Order rationale

**Foundation before adapters.** The `SendProviderModule<K>` interface,
the registry shape, the `EmailErrorCode` enum, and the
`EmailSendAttempt` discriminated union land first as scaffolding. They
have zero callers in phase 1; the per-provider modules in phase 2 are
their first consumers.

**Adapters before dispatch helper.** The dispatch helper depends on
the providers' `retryDelays`, `categorizeError`, and single-attempt
`sendEmail`. Building the helper without working adapters is build
errors; building adapters without the helper just leaves the adapters
unused (the existing classes still serve callers).

**Strategies are independent.** The per-strategy modules and the thin
`routing.ts` dispatcher don't depend on the adapter scaffolding —
strategies operate on `ProviderEntry`/`ProviderHealthStatus` value
shapes. Phase 4 (strategies) is parallelizable with phase 3 (dispatch
helper) and could ship before or after.

**Caller cutover atomic.** Every send producer migrates in one PR —
six call sites in five files. Spreading the cutover across multiple
PRs creates a window where some sends go through the helper and others
through the old factory, with two parallel health-recording paths.
The window has no value; one PR closes it.

**Cleanup last.** Deleting the pre-deepening files (`emailProviders/
{index,types,mta,ses,resend,routing,healthTracker}.ts`) only runs once
tsc proves no remaining importers in the codebase. The cleanup PR is
mechanical and self-checking.

**Each phase is independently revertible.** Phases 1-4 build the new
folder alongside the old. The old factory isn't touched until phase 5
(caller cutover). A revert of phase 5 leaves the new modules orphaned
but the old factory working; phases 1-4 stay landed because they
don't break anything.

---

## Phase 1 — Foundation: types + registry shape (no callers)

**Changes**

- `apps/api/convex/lib/sendProviders/types.ts` (new) —
  `SendProviderKind`, `SendProviderModule<K>`, `ExtrasFor<K>`,
  `MtaExtras`, `SesExtras`, `ResendExtras`, `EmailSendAttempt`,
  `EmailErrorCode` enum, `EmailSendParams`, `EmailAttachment`.
- `apps/api/convex/lib/sendProviders/index.ts` (new) — empty registry
  shape (object literal `{}` cast to the satisfies record); the
  `providerFor<K>(kind)` function throws for all inputs until phase 2
  populates entries; `isSendProviderKind` type guard. The empty
  registry compiles because no adapter has been imported yet — the
  `satisfies` check accepts the empty record only via an explicit
  cast that phase 1 keeps intentionally loose.

Actually — the `satisfies` check on `Record<SendProviderKind,
SendProviderModule<...>>` *requires* all three keys populated.
Phase 1 either skips the satisfies check (a `// TODO(phase-2)`) or
populates with placeholder modules that throw. The placeholder route
is cleaner: phase 1 lands real `SendProviderModule<K>` placeholders
whose `sendEmail` and `categorizeError` throw, with `retryDelays:
[]`. Tests in phase 1 assert the placeholder throws; phase 2
replaces them with real adapters.

Adopting the placeholder approach:

- `apps/api/convex/lib/sendProviders/mta/index.ts` (new) — placeholder
  module: `kind: 'mta'`, `retryDelays: []`, `sendEmail` throws,
  `categorizeError` throws.
- `apps/api/convex/lib/sendProviders/ses/index.ts` (new) —
  placeholder.
- `apps/api/convex/lib/sendProviders/resend/index.ts` (new) —
  placeholder.

**Tests**

- `apps/api/convex/lib/sendProviders/__tests__/registry.test.ts`
  (new): `providerFor('mta')`, `providerFor('ses')`,
  `providerFor('resend')` each return a module with the matching
  `kind`. `providerFor('unknown' as any)` throws.
  `isSendProviderKind('mta')` → true; `isSendProviderKind('postmark')`
  → false.

**Done when**

- `bun run typecheck` clean for `apps/api/`.
- `rg "sendProviderDispatch\|lib/sendProviders" apps/api/convex/` → only
  matches within `lib/sendProviders/` itself (no callers outside).
- `npx vitest run apps/api/convex/lib/sendProviders/__tests__/` passes.

---

## Phase 2 — Real per-provider adapters (replace placeholders)

**Changes**

- `apps/api/convex/lib/sendProviders/mta/index.ts` — real adapter.
  Single-attempt `sendEmail`: extract MTA-specific extras (`messageId`,
  `ipPool`, `engagementScore`, `dkimDomain`); build POST body; fetch
  `${baseUrl}/send`; classify response. No retry loop. Per-provider
  `categorizeError(message, httpStatus?)` parses HTTP status + JSON
  error fields. `retryDelays: [1000, 5000]` (matches pre-deepening
  `mta.ts:19`).
- `apps/api/convex/lib/sendProviders/ses/index.ts` — real adapter.
  Single-attempt `sendEmail` calls SES SDK; classifies AWS error
  classes via `error.name` (`'Throttling'`, `'MessageRejected'`,
  `'MailFromDomainNotVerified'`, `'AccountSendingPausedException'`,
  etc.). `retryDelays: [1000, 5000, 30000]` (matches pre-deepening).
- `apps/api/convex/lib/sendProviders/resend/index.ts` — real adapter.
  Single-attempt `sendEmail` calls Resend SDK; classifies Resend error
  envelope (`name`, `statusCode`, `message`). `retryDelays: [1000,
  5000, 30000]`.

The pre-deepening `lib/emailProviders/{mta,ses,resend}.ts` classes
**stay** in this phase. Old factory still works; new adapters live in
parallel. The HTTP/SDK call shape inside each new adapter is
byte-for-byte the request shape of the pre-deepening
`sendWithRetry` (minus the retry loop).

**Tests**

- `apps/api/convex/lib/sendProviders/__tests__/providers.test.ts`
  (new) — per-provider unit tests:
  - MTA `sendEmail` with stubbed fetch returning 200: returns
    `{ success: true, id }`.
  - MTA `sendEmail` with stubbed fetch returning 500: returns
    `{ success: false, errorCode: SERVER_ERROR }`.
  - MTA `sendEmail` with stubbed fetch returning 429: returns
    `{ success: false, errorCode: RATE_LIMIT }`.
  - MTA `categorizeError('Rate limit exceeded', 429)` →
    `RATE_LIMIT`.
  - MTA `categorizeError('Invalid recipient', 400)` →
    `INVALID_RECIPIENT`.
  - SES `sendEmail` with stubbed SDK throwing `Throttling`: returns
    `{ success: false, errorCode: RATE_LIMIT }`.
  - SES `sendEmail` with stubbed SDK throwing `MessageRejected`:
    returns `{ success: false, errorCode: CONTENT_REJECTED }`.
  - Resend `sendEmail` with stubbed SDK returning `{ data: { id } }`:
    `{ success: true, id }`.
  - Resend `sendEmail` with stubbed SDK returning `{ error }`:
    classifies via `categorizeError`.

**Done when**

- `bun run typecheck` clean.
- `npx vitest run apps/api/convex/lib/sendProviders/__tests__/providers.test.ts`
  passes (~15 tests).
- `rg "sendWithRetry" apps/api/convex/lib/sendProviders/` → no hits
  (no retry loop in adapter files).

---

## Phase 3 — Send dispatch (helper) + health move

**Changes**

- `apps/api/convex/lib/sendProviders/health.ts` (new) — renamed from
  `lib/emailProviders/healthTracker.ts`. Identical content; only
  module path changes. Internal API path becomes
  `internal.lib.sendProviders.health.recordSendResult`,
  `internal.lib.sendProviders.health.getProviderHealth`,
  `internal.lib.sendProviders.health.getAllProviderHealth`.
- `apps/api/convex/lib/emailProviders/healthTracker.ts` —
  **re-exports** from `../sendProviders/health.ts` to preserve the
  old internal API path during the cutover window. Re-export shape:
  `export { recordSendResult, getProviderHealth, getAllProviderHealth
  } from '../sendProviders/health';`. This is a temporary bridge;
  it's deleted in phase 6 (cleanup).
- `apps/api/convex/lib/sendProviders/dispatch.ts` (new) —
  `sendProviderDispatch(ctx, kind, params, extras?)`. Retry loop
  iterating `module.retryDelays.length + 1` times; calls
  `module.sendEmail` per attempt; classifies failure via
  `module.categorizeError` (already returned in `EmailSendAttempt`);
  decides retry via `isRetryable(code)`; records health via
  `ctx.scheduler.runAfter(0,
  internal.lib.sendProviders.health.recordSendResult, ...)` on every
  terminal outcome (not per-attempt). Returns `{ result, providerType,
  latencyMs, attempts }`.
- `apps/api/convex/lib/sendProviders/types.ts` — adds `DispatchResult`
  interface.

**Tests**

- `apps/api/convex/lib/sendProviders/__tests__/dispatch.integration.test.ts`
  (new) — retry + health + categorization integration:
  - First-attempt success: `attempts: 1`, health recorded
    `{ success: true }`, `latencyMs` populated.
  - Retryable failure → retry → success: `attempts > 1`, health
    recorded once `{ success: true }`.
  - Exhausted retries: `attempts === retryDelays.length + 1`, health
    recorded `{ success: false }`.
  - Non-retryable failure: `attempts: 1`, no retry sleep, health
    recorded `{ success: false }`.
  - Per-provider retry counts: MTA stops at 3 attempts max; Resend
    stops at 4.
  - Health recording fires exactly once per dispatch — regression
    test for "per-attempt double-counting" failure mode.

**Done when**

- `bun run typecheck` clean.
- `npx vitest run apps/api/convex/lib/sendProviders/__tests__/dispatch.integration.test.ts`
  passes (~10 tests).
- `rg "sendProviderDispatch" apps/api/convex/` → only matches within
  `lib/sendProviders/` (no callers outside yet).
- `rg "healthTracker" apps/api/convex/` → matches both the old and
  the new path (cutover bridge in place).

---

## Phase 4 — Strategy modules + thin `routing.ts`

**Changes**

- `apps/api/convex/lib/sendProviders/strategies/types.ts` (new) —
  `SendRouteStrategyKind`, `SendRouteStrategyModule<K>`,
  `ProviderEntry`, `ProviderHealthStatus`, `ResolvedRoute`.
- `apps/api/convex/lib/sendProviders/strategies/single/index.ts`
  (new).
- `apps/api/convex/lib/sendProviders/strategies/priority_failover/index.ts`
  (new).
- `apps/api/convex/lib/sendProviders/strategies/workload_split/index.ts`
  (new).
- `apps/api/convex/lib/sendProviders/strategies/index.ts` (new) —
  registry + `strategyFor(kind)`.
- `apps/api/convex/lib/sendProviders/routing.ts` (new) — thin
  `resolveRoute(routeConfig, healthStatuses?)` + `fallback()`. Same
  exported signature as pre-deepening
  `lib/emailProviders/routing.ts:resolveRoute`. The
  `ProviderRouteConfig` and `ProviderHealthStatus` interfaces match
  pre-deepening shapes for caller compatibility.
- `apps/api/convex/lib/emailProviders/routing.ts` — **re-exports**
  from `../sendProviders/routing.ts` to preserve the old import path
  during the cutover window. Re-export shape: `export { resolveRoute,
  type ProviderRouteConfig, type ProviderHealthStatus, type
  ResolvedRoute } from '../sendProviders/routing';`. Deleted in
  phase 6.

**Tests**

- `apps/api/convex/lib/sendProviders/__tests__/strategies.test.ts`
  (new) — ~12 tests covering each strategy's `select()` outputs and
  `resolveRoute`'s fallback paths (full list in ADR-0020 §Test
  surface).

**Done when**

- `bun run typecheck` clean.
- `npx vitest run apps/api/convex/lib/sendProviders/__tests__/strategies.test.ts`
  passes (~12 tests).
- `rg "switch.*strategy" apps/api/convex/lib/sendProviders/routing.ts`
  → no hits (the strategy switch is gone; strategyFor handles it).
- `rg "from.*emailProviders/routing" apps/api/convex/` → still
  matches existing callers (`emails.ts`, `transactionalApiHttp.ts`)
  via the bridge re-export.

---

## Phase 5 — Caller cutover (atomic)

**Changes — six call sites, five files**

`apps/api/convex/emails.ts:43` (`sendEmail` internal action):

```diff
-import { getEmailProvider } from './lib/emailProviders';
+import { sendProviderDispatch } from './lib/sendProviders/dispatch';
+import { resolveRoute } from './lib/sendProviders/routing';
+import type { SendProviderKind } from './lib/sendProviders';

 export const sendEmail = internalAction({
   args: { /* ... */ },
   handler: async (ctx, args) => {
-    const provider = getEmailProvider();
-    const result = await provider.sendEmail({ to, from, replyTo, subject, html });
-    if (!result.success) throw new Error(`Failed to send email: ${result.error}`);
-    return { id: result.id, success: true };
+    const routeConfig = await ctx.runQuery(internal.providerRoutes.getRoute, {
+      messageType: 'transactional',
+    });
+    const allHealth = await ctx.runQuery(
+      internal.lib.sendProviders.health.getAllProviderHealth, {});
+    const resolved = resolveRoute(routeConfig, allHealth);
+    const dispatched = await sendProviderDispatch(ctx, resolved.providerType,
+      { to, from, replyTo, subject, html });
+    if (!dispatched.result.success) {
+      throw new Error(`Failed to send email: ${dispatched.result.errorMessage}`);
+    }
+    return { id: dispatched.result.id, success: true };
   },
 });
```

`apps/api/convex/emails.ts:341, :760` (`resolveRoute` already
imported; just update the import path):

```diff
-import { resolveRoute, type ProviderRouteConfig } from './lib/emailProviders/routing';
+import { resolveRoute, type ProviderRouteConfig } from './lib/sendProviders/routing';
```

`apps/api/convex/emailsSending.ts:93, :179` — two `getEmailProvider()`
call sites. Each becomes a `sendProviderDispatch` call routed through
`resolveRoute` for the appropriate `messageType`.

`apps/api/convex/emailWorker.ts:209-210` — the worker already gets a
`providerType` arg; cutover is a direct mapping:

```diff
-import { getEmailProvider, getProviderByType, type EmailProviderType } from './lib/emailProviders';
+import { sendProviderDispatch } from './lib/sendProviders/dispatch';
+import type { SendProviderKind, MtaExtras } from './lib/sendProviders';

-const provider = args.providerType
-  ? getProviderByType(args.providerType as EmailProviderType)
-  : getEmailProvider();
-const result = await provider.sendEmail({ to, from, subject, html, replyTo, headers, attachments });
+const kind: SendProviderKind = (args.providerType as SendProviderKind | undefined) ?? 'mta';
+const extras = kind === 'mta'
+  ? { messageId: args.messageId, ipPool: args.ipPool, engagementScore: args.engagementScore, dkimDomain: args.dkimDomain } satisfies MtaExtras
+  : {};
+const dispatched = await sendProviderDispatch(ctx, kind,
+  { to, from, subject, html, replyTo, headers, attachments },
+  extras);
+const result = dispatched.result;
```

`apps/api/convex/automations/steps/email/index.ts:90` — the automation
email step. Gains health recording for free post-cutover.

`apps/api/convex/transactionalApiHttp.ts:564` — `resolveRoute` import
path update only (the call shape doesn't change).

`apps/api/convex/delivery/sendCompletion.ts:84-95` — the
`recordSendResult` scheduler call is **deleted**. The dispatch helper
has already recorded health for this attempt:

```diff
-if (result?.providerType) {
-  await ctx.scheduler.runAfter(0,
-    internal.lib.emailProviders.healthTracker.recordSendResult,
-    {
-      providerType: result.providerType,
-      success: !error,
-      latencyMs: result.latencyMs ?? 0,
-    },
-  );
-}
```

The `result.latencyMs` field that Send completion was reading is now
populated by `sendProviderDispatch`'s return value
(`dispatched.latencyMs`); the worker passes it forward to Send
completion via the existing onComplete payload. No new field is added.

**Tests — regression coverage**

- All existing `apps/api/convex/__tests__/*.integration.test.ts` tests
  pass — the cutover preserves observable behavior. The worker's send
  shape is identical; the campaign orchestrator's enqueue is
  identical; the transactional HTTP response is identical.
- New regression test: `delivery/__tests__/sendCompletion.integration.test.ts`
  asserts that `onComplete` no longer schedules `recordSendResult`
  itself, but health *is still recorded* (via the dispatch helper
  upstream).
- New test: `automations/steps/email/__tests__/index.integration.test.ts`
  asserts that the automation email step's send recorded health —
  regression for the silent-drift bug being closed.

**Done when**

- `bun run typecheck` clean.
- `bun run ci:test` passes.
- `rg "getEmailProvider\|getProviderByType" apps/api/convex/` → no
  hits outside `lib/emailProviders/` itself.
- `rg "healthTracker.recordSendResult" apps/api/convex/` → no hits
  (replaced by dispatch helper's internal scheduling).

---

## Phase 6 — Cleanup: delete the pre-deepening files

**Changes**

- `apps/api/convex/lib/emailProviders/index.ts` — **deleted**.
- `apps/api/convex/lib/emailProviders/types.ts` — **deleted**.
- `apps/api/convex/lib/emailProviders/mta.ts` — **deleted** (the
  `MtaProvider` class, `MtaSendParams`, `createMtaProvider`,
  `DEFAULT_RETRY_DELAYS`, `sendWithRetry`).
- `apps/api/convex/lib/emailProviders/ses.ts` — **deleted**.
- `apps/api/convex/lib/emailProviders/resend.ts` — **deleted**.
- `apps/api/convex/lib/emailProviders/routing.ts` — **deleted** (the
  bridge re-export from phase 4 goes away).
- `apps/api/convex/lib/emailProviders/healthTracker.ts` — **deleted**
  (the bridge re-export from phase 3 goes away).

The folder `lib/emailProviders/` is **not** deleted — three files
survive (`mtaIdentity.ts`, `sesIdentity.ts`, `domainVerification.ts`)
because ADR-0018's domain-side adapters import them by that exact
path. Those three stay where they are; this ADR doesn't touch them.

**Tests**

- No new tests in this phase. Existing tests pass; this is pure
  deletion of unused code.

**Done when**

- `bun run typecheck` clean.
- `bun run ci:test` passes.
- `rg "from.*emailProviders/(index|types|mta|ses|resend|routing|healthTracker)" apps/api/convex/`
  → no hits.
- `find apps/api/convex/lib/emailProviders -name "*.ts" -not -name "mtaIdentity*" -not -name "sesIdentity*" -not -name "domainVerification*"`
  → no hits.

---

## Phase 7 — Verification (no code changes)

**Changes**

None. Pure verification phase.

**Checks**

- `rg "getEmailProvider\|getProviderByType\|clearProviderCache\|getConfiguredProviderName" apps/api/`
  → no hits.
- `rg "categorizeError\(" apps/api/convex/` → only hits inside
  `lib/sendProviders/*/index.ts` adapter files (each provider's own
  function).
- `rg "isRetryableError" apps/api/convex/` → no hits (the global
  helper is gone; retry decisions live in the dispatch helper).
- `rg "sendBatch" apps/api/convex/` → no hits.
- `rg "import.*EmailProvider[^A-Za-z]" apps/api/convex/` → no hits
  (the old `EmailProvider` interface is retired).
- `rg "as MtaSendParams\|MtaSendParams" apps/api/convex/` → no hits.
- `rg "sendWithRetry" apps/api/convex/` → no hits.
- CONTEXT.md contains the **Send provider adapter (module)**, **Send
  dispatch (helper)**, **Send route strategy (module)**, **Send
  provider health (module)** entries.
- CONTEXT.md's **Send completion (module)** entry's health-recording
  rationale is updated to point at the dispatch helper.
- CONTEXT.md's **Sending domain provider adapter (module)** entry's
  `_Avoid_` no longer mentions `lib/emailProviders/` as a live
  factory.

**Done when**

- All checks above pass.
- `bun run ci:test` passes.

---

## Risk and revert

**Risk shape**

The only behavior-change phase is **Phase 5 (caller cutover)**. Every
other phase is additive (new files) or mechanical (rename + bridge
re-export). Phase 5 is the moment six send producers swap their
implementation in one PR.

The risk in phase 5 is per-call-site, not systemic — each call site
either dispatches correctly post-cutover or it doesn't. A regression
in one call site (e.g. the campaign orchestrator) doesn't cascade
into the others. Integration tests at the boundary cover each
producer.

**Revert path**

- Phases 1-4 land independently. Revert any one of them removes that
  phase's files; the pre-deepening factory is untouched and still
  works.
- Phase 5 (caller cutover) is the only phase whose revert undoes
  meaningful changes — six call sites swing back to
  `getEmailProvider()` / `getProviderByType()`. The pre-deepening
  files at `lib/emailProviders/` are still present at this point
  (phase 6 hasn't shipped yet); revert is a pure `git revert`.
- Phase 6 (cleanup) revert restores the deleted files via
  `git revert`. The bridge re-exports (phases 3 and 4) come back;
  callers cut over in phase 5 stay cut over, so the bridges remain
  unused but harmless.

**Phase 5 + 6 should not be merged in the same PR.** The window
between phase 5 (cutover) and phase 6 (cleanup) lets the cutover
soak — production sends route through the new helper while the old
factory still exists as a no-op fallback. A one-week soak is
recommended before phase 6.

---

## Estimated PR sizes

| Phase | Description | Net LOC | Files touched |
|---|---|---|---|
| 1 | Foundation: types, registry, placeholders | +~250 | 5 new |
| 2 | Real adapters (MTA + SES + Resend) | +~550 | 3 modified |
| 3 | Dispatch helper + health move (with bridge) | +~140 | 2 new, 1 new bridge |
| 4 | Strategy modules + thin routing (with bridge) | +~170 | 6 new, 1 new bridge |
| 5 | Caller cutover (atomic) | ~±50 net, ~250 LOC changed | 6 call sites, 5 files |
| 6 | Cleanup: delete pre-deepening files | -~1300 | 7 deletions |
| 7 | Verification | 0 | 0 |

**Net for the whole ADR**: roughly +200 LOC (new modules and tests
heavier than the deletions; tests are the bulk of the gain).

---

## Cross-references

- ADR-0007 execution plan — pattern for phased deepening of MTA
  dispatch; same "foundation → modules → cutover → cleanup" shape.
- ADR-0018 (Sending domain provider adapter) — sibling adapter on
  the domain-registration side, established the
  `providerFor(kind)` + `satisfies` registry shape this ADR
  mirrors.
- ADR-0006 (Send completion module) — the health-recording rationale
  that moves upstream in phase 5.
