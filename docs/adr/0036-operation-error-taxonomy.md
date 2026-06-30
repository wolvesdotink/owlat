# Operation error taxonomy — one category vocabulary across the thrown, HTTP, and SDK seams, plus the app-side operation module

**Status:** accepted

## Context

How a failed operation is *named*, *serialized*, and *surfaced* is a
cross-cutting concern that today crosses three serializations that do not
agree, sitting behind no shared interface. The backend is 35 deep modules
with precise failure modes (permission denials, quota limits, state-machine
violations, content blocks); the `apps/web` frontend crosses the Convex
seam as raw RPC and cannot tell any of them apart.

### Serialization landscape — "an operation failed"

| Seam | Where | Shape | Consumer | Casing |
|---|---|---|---|---|
| Thrown (in-app) | `_utils/errors.ts:8-34` (`throwNotFound` …) | `ConvexError({ code, message })` | Vue client `error.data.code` | `SCREAMING_SNAKE` |
| HTTP body | `lib/httpResponse.ts:65-72` (`errorResponse`) + `_utils/errors.ts:54-82` (`ErrorCodes`) | `{ error: { message, code } }` | `sdk-js` / `sdk-java` | lowercase |
| SDK classes | `packages/sdk-js/src/errors/index.ts` | `OwlatError{ code, statusCode, data? }` + subclasses by status | external callers | lowercase |

Three serializations, three code vocabularies, none canonical. The
frontend — the consumer that prompted this ADR — has no adapter at all.

### 1. `_utils/errors.ts` is three overlapping systems with a name-collision trap

The file ships **three** parallel error vocabularies: (a) seven coded
throwers (`throwNotFound`/`throwForbidden`/… → `ConvexError`, `SCREAMING_SNAKE`,
`:8-34`); (b) a *separate, larger* `ErrorCodes` map of sixteen **lowercase**
codes for HTTP response bodies (`:54-82`); (c) bare-`Error` creators
(`createNotFoundError`/`createPermissionError`/…, `:144-178`) that return an
**uncoded** `Error` with a formatted string. (c) sits inches from (a) with
near-identical names but the opposite contract — reach for
`createNotFoundError` instead of `throwNotFound` and your "coded" error
silently has no code. `isErrorType(e, ...patterns)` (`:134`) does substring
matching on messages — the fragile categorization the coded system exists to
replace, shipping in the same file.

### 2. 317 bare throws ignore the taxonomy

`throw new Error('…')` appears **317 times across 101 files**. Whole
subsystems throw uncoded — `mail/labels.ts` (16), `mail/drafts.ts` (14),
`mail/folders.ts` (14), `mail/imap.ts` (8). The coded taxonomy is a seam with
almost no traffic; only a handful of modules
(`transactional/lifecycle.ts`, `emailTemplates/lifecycle.ts`,
`lib/featureFlags.ts`) throw coded errors.

### 3. The "closed" set is already drifting

Real throws use codes outside the seven: `CONTENT_BLOCKED`
(`transactional/lifecycle.ts:218` — with a comment at `:11` calling it
`content_blocked`, casing drift inside one file), `FEATURE_DISABLED`,
`TEMPLATE_PUBLISHED`. The transactional HTTP API (`transactional/api.ts`)
runs its own lowercase zoo: `account_suspended`, `email_blocked`,
`not_published`, `domain_not_verified`, `invalid_variables`.

### 4. The frontend can't categorize — it echoes strings and loses telemetry

`useConvexMutation` (`apps/web/app/composables/useConvexMutation.ts`) is a
shallow wrapper: it runs the mutation, stores the error, and **re-throws**
(`:28-30`). Every call site then re-implements the same shape —
`try { await mutate() ; toast.success() } catch (e) { saveError = e.message }`.
That `catch { … }` block appears in **64 files**; toast calls in **60**.
`useCampaignActions.ts` carries it **five times in one file** and ships its
*own* toast (`ref` + `setTimeout(3000)`, `:42-48`) — not the global
`useToast()` that `error-handler.client.ts` uses. Worst of all, telemetry
fires only on the path nobody's `catch` touches: `error-handler.client.ts`
reports `$exception` to PostHog only for *unhandled* errors (`:26-49`); every
hand-rolled `catch` swallows the error into `saveError.value`, invisible to
telemetry.

### Shared framing

Per LANGUAGE.md's deletion test: delete a deep app-side operation module and
the run→categorize→surface→report block reappears 5× in `useCampaignActions`
alone and across 64 files — it *concentrates*, so the module earns its keep.
Delete `useCampaignActions` and only the *campaign send/schedule
orchestration* reappears — proving the wrapper and the orchestration are two
modules, not one. The deepening is **two-sided**: a frontend categorizer is
only ever as deep as the backend's naming, so the real seam is the **category
vocabulary**, and the backend (thrown), HTTP, and SDK serializations are
adapters at it. The interface is the test surface — categorization and
treatment logic are reachable today only inside `.vue` `catch` blocks, so
none of it has a test.

Confidence: medium. Unlike a pure frontend refactor, this has a real blast
radius: a backend migration of the user-facing throw sites and an **atomic
breaking change** to the `sdk-js` / `sdk-java` wire codes. That break is in
scope deliberately — the repo is pre-prod and OSS-only (ADR/MEMORY: Nest
extracted), and prefers clean breaking changes over backward-compat ceremony.

## Decision

Make the **Operation error (contract)** the single seam, serialized three
ways, and consumed by two app-side modules.

### The contract

```ts
// _utils/errors.ts — one source of truth
type OperationErrorCategory =
  | 'unauthenticated' | 'forbidden'   | 'not_found'   | 'invalid_input'
  | 'already_exists'  | 'conflict'    | 'invalid_state'
  | 'rate_limited'    | 'limit_reached'
  | 'internal'        | 'network';    // 'network' is client-only

interface OperationError {
  category: OperationErrorCategory;   // drives treatment + HTTP status
  message: string;                    // human detail
  data?: Record<string, unknown>;     // specifics: { field }, { limit, used }, { retryAfter }, scan result
}
```

The union is **closed** (~11). Every existing code folds into a category;
specifics that used to be bespoke codes (`TEMPLATE_PUBLISHED`, rate-limit
numbers) ride in `data`/`message`, never as new categories. Casing settles to
**lowercase** (matches HTTP + SDK; the in-app client doesn't care).

| category | HTTP | frontend treatment | report? | folds in |
|---|---|---|---|---|
| `unauthenticated` | 401 | redirect / "session expired" | no | NOT_AUTHENTICATED, invalid_token, token_expired |
| `forbidden` | 403 | toast "no permission / unavailable" | no | FORBIDDEN, no_permission, FEATURE_DISABLED, account_suspended |
| `not_found` | 404 | toast, maybe navigate away | no | NOT_FOUND, share_link_not_found |
| `invalid_input` | 400 | **inline** on field (`data.field`) | no | INVALID_INPUT, invalid_email, missing_field, invalid_variables |
| `already_exists` | 409 | **inline** "already taken" | no | ALREADY_EXISTS |
| `conflict` | 409 | toast "changed elsewhere, reload" | no | CONFLICT |
| `invalid_state` | 422 | toast/inline (+`data` for action) | no | INVALID_STATE, TEMPLATE_PUBLISHED, not_published, CONTENT_BLOCKED, email_blocked |
| `rate_limited` | 429 | toast + `data.retryAfter` | no | RATE_LIMITED |
| `limit_reached` | 402/429 | upgrade toast + `data.limit/used` | no | LIMIT_REACHED |
| `internal` | 500 | toast "something went wrong" | **yes** | INTERNAL_ERROR, EXTERNAL_SERVICE_ERROR, unknown |
| `network` | — (client) | toast "check connection" + retry | **yes** (post-retry) | client fetch failure / Convex disconnect |

### Three adapters at the seam

- **Thrown (in-app):** `ConvexError({ category, message, data })`. The seven
  `throw*` helpers in `_utils/errors.ts` are rewritten to emit `category`; the
  bare-`Error` creators (`createNotFoundError` & friends) and `isErrorType`
  are **deleted** — they are the footgun and the substring-matching relic.
- **HTTP:** `errorResponse` derives status *from* category and emits
  `{ error: { category, message, data } }`. The `ErrorCodes` lowercase map
  collapses into the union.
- **SDK:** keep the status→subclass hierarchy (`AuthenticationError`,
  `RateLimitError`, …) — good ergonomics, fewer external breaks — but retune
  `.code` to the canonical `category` and surface `.data` (so
  `RateLimitError.retryAfter` reads from `data.retryAfter`).

### Two app-side modules (centralized policy)

```ts
// apps/web/app/composables/useBackendOperation.ts (sketch) — writes
function useBackendOperation<M extends FunctionReference<'mutation' | 'action'>>(
  ref: M,
  opts: { label: string; inlineTarget?: Ref<string | null> },
): {
  run: (args: FunctionArgs<M>) => Promise<FunctionReturnType<M> | undefined>;
  isLoading: Readonly<Ref<boolean>>;
  inlineError: Readonly<Ref<string | null>>;
};

// apps/web/app/composables/useBackendQuery.ts (sketch) — reactive reads
function useBackendQuery<Q extends FunctionReference<'query'>>(
  ref: Q,
  args: FunctionArgs<Q>,
): {
  data: Readonly<Ref<FunctionReturnType<Q> | undefined>>;
  isLoading: Readonly<Ref<boolean>>;
  error: Readonly<Ref<{ category: OperationErrorCategory; message: string } | null>>;
};
```

`run` normalizes any throw into `{ category, message, data }` (or
`network`/`internal` for non-`ConvexError`), then applies the table:
toast vs inline, the copy, and the single telemetry decision. Callers pass a
mutation + a label; the only knob is the optional `inlineTarget` for the two
inline categories — without it, they toast. `useBackendQuery` maps a query
failure onto the same vocabulary for empty/error/retry UI.
`useCampaignActions`-style multi-step flows compose `run` instead of
re-rolling try/catch.

### Decisions resolved in the grilling

1. **Two-sided coded contract, not a frontend echo.** The category vocabulary
   is the seam; the backend must *name* failures for the frontend to *treat*
   them. A frontend-only wrapper was rejected — it would leave every error
   looking identical.
2. **Centralized policy, not caller-injected.** The module owns the
   category→treatment map; callers get leverage from a tiny interface
   (`ref` + `label`). Caller-injected handlers were rejected as re-creating
   today's wide, shallow boilerplate.
3. **Category + message + data, not a code zoo.** Domain errors collapse to a
   category and explain themselves in `data`/`message`. First-class domain
   codes were rejected as re-drifting toward the very zoo this closes;
   flat-category-only was rejected for losing the detail a specific flow needs
   (e.g. `data` for an "unpublish" action on `invalid_state`).
4. **Unify all three serializations**, accepting the SDK break, rather than
   scoping to the in-app seam only. One vocabulary, three serializations.
5. **Writes + query error states.** The frontend seam covers both the
   operation path (`useBackendOperation`) and reactive-read failure
   (`useBackendQuery`), both keyed on the same vocabulary.
6. **Scope is user-facing functions, not all 317 throws.** Internal helpers /
   `internalMutation`s throwing bare `Error` stay — those are invariant bugs,
   never surfaced. The migration targets public mutations/actions + HTTP
   handlers.

### Enforcement

A `lint:errors` guard (sibling to the existing `lint:env`, run as part of
`bun run lint`) bans bare `throw new Error` in user-facing Convex functions
and ad-hoc `code:`/`category:` string literals outside the canonical union.
This is the locality guarantee made permanent — what stops re-drift back to
317 bare throws and a fourth code vocabulary.

### Tests

The interface is the test surface — all unit-level, no page mount:

1. **Normalization** — `ConvexError({category,…})` → `{category,message,data}`;
   a non-`ConvexError` throw → `internal`; a transport failure → `network`.
2. **Treatment policy** — each category routes to toast vs inline vs redirect,
   and only `internal`/`network` report to telemetry.
3. **`inlineTarget`** — `invalid_input`/`already_exists` write `inlineError`
   when a target is bound, fall back to toast when not.
4. **Backend adapters** — category→HTTP-status mapping; the `ConvexError`
   shape carries `data` through to the client.

## Consequences

**One vocabulary for "what went wrong."** The thrown, HTTP, and SDK seams
serialize the same closed category union; a new failure mode is named once
and every consumer — Vue, SDK, operator dashboards — speaks it.

**The frontend can finally treat errors.** A permission denial, a quota cap,
a stale-state conflict, and a dropped connection render differently and only
the genuine faults reach telemetry — today all four are an identical toast of
a raw backend string, and none are reported.

**`_utils/errors.ts` shrinks and de-traps.** Three overlapping systems become
one; the bare-`Error` creators and `isErrorType` substring matcher are
deleted.

**Net app-code change is negative.** The 5×-per-file try/catch/toast/finally
block across ~64 files collapses into `run`; `useConvexMutation` is replaced
by `useBackendOperation`/`useBackendQuery`.

**Migration** (atomic, pre-prod; no data migration):
1. Land the contract + the rewritten `throw*` helpers + category→status map in
   `_utils/errors.ts` and `lib/httpResponse.ts`.
2. Migrate user-facing backend throw sites off bare `Error` to coded helpers;
   fold `ErrorCodes` and the domain codes (`CONTENT_BLOCKED`, …) into the union.
3. Retune `sdk-js` / `sdk-java` `.code` + `.data` (atomic wire break).
4. Add `useBackendOperation` / `useBackendQuery`; migrate the ~64 call sites;
   delete `useConvexMutation`.
5. Add the `lint:errors` guard.
6. `CONTEXT.md` `## Operation errors` section (the **Operation error**,
   **Error category**, and **Operation module** terms + a Flagged-ambiguities
   entry) landed inline with this ADR.

**Risk:** medium. The backend throw-site migration is mechanical but broad;
the SDK wire break is intentional and atomic. Behaviour at each call site is
preserved or improved (a raw-string toast becomes a categorized one); the only
hard cutover is external SDK consumers reading `.code`.
