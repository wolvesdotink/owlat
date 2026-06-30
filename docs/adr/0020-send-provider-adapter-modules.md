# Send provider adapter modules + send dispatch helper + route strategy modules

**Status:** accepted

## Context

`apps/api/convex/lib/emailProviders/` is the send-side provider
abstraction: three implementations of one `EmailProvider` interface
(`mta`, `ses`, `resend`), a switch-based factory, a strategy switch in
the routing layer, and a co-located health tracker. The folder predates
the module/registry discipline established by ADRs 0001-0018; everything
else in the codebase that has "N implementations of one interface keyed
by a discriminator" has been deepened into a registry-dispatched module
family. This is the last remaining pre-deepening provider abstraction
in `apps/api/`.

The friction is at three layers simultaneously:

1. **Per-provider classes** dispatched by a `switch (providerType)` in
   `getEmailProvider()` and `getProviderByType()`. Three near-identical
   class shapes; "Adding Postmark" today edits two switches plus a
   union type plus three class registrations.
2. **A global `categorizeError` string-matching function** in
   `types.ts` that pretends to be provider-agnostic but has to know
   about every provider's error response shape. Each provider then
   calls back into the global to classify retryable errors — the
   provider has to remember to.
3. **A `switch (routeConfig.strategy)`** in `routing.ts:resolveRoute`
   with three branches (`single`, `priority_failover`,
   `workload_split`). Adding a fourth strategy (e.g. `least_loaded`,
   `geo_aware`) means editing this one function.

CONTEXT.md already names the collision: the **Sending domain provider
adapter (module)** entry's `_Avoid_` clause calls out "Email provider
module (collides with the existing `lib/emailProviders/` factory
which is the send-side provider abstraction — different surface)." The
collision is real but the seam on the send side hasn't been named.

### Provider landscape — `lib/emailProviders/`

| File | LOC | Role |
|---|---|---|
| `types.ts` | 225 | `EmailProvider` interface, `EmailSendParams`, `EmailSendResult`, `EmailErrorCode` enum, global `categorizeError`, `isRetryableError` |
| `index.ts` | 139 | `getEmailProvider()`, `getProviderByType()`, `clearProviderCache()`, `getConfiguredProviderName()` — switch-based factory + cache map |
| `mta.ts` | 187 | `MtaProvider` class — `sendEmail` with internal retry loop; `MtaSendParams` carries `ipPool`, `engagementScore`, `dkimDomain`, `messageId`; passed via `params as MtaSendParams` |
| `ses.ts` | 302 | `SESProvider` class — same shape; AWS SDK call |
| `resend.ts` | 171 | `ResendProvider` class — same shape; Resend API call |
| `routing.ts` | 180 | `resolveRoute(routeConfig, healthStatuses?)` — strategy switch + weighted random for `workload_split` |
| `healthTracker.ts` | 131 | `recordSendResult` mutation, `getProviderHealth` query, `getAllProviderHealth` query; `calculateStatus` helper |
| `domainVerification.ts` | 182 | DNS helpers — consumed *only* by ADR-0018's `domains/providers/`; not part of the send-side surface |
| `mtaIdentity.ts` | 92 | MTA DKIM HTTP client — consumed by ADR-0018's MTA adapter |
| `sesIdentity.ts` | 151 | SES identity SDK wrapper — consumed by ADR-0018's SES adapter |

The first 7 files are the send-side abstraction. The last 3 are shared
HTTP/SDK clients consumed by the domain-side adapter (ADR-0018) and stay
where they are — this ADR doesn't touch them.

### 1. Three near-identical retry loops

```ts
// mta.ts:63-141 (sendWithRetry)
private async sendWithRetry(params: EmailSendParams, attempt: number): Promise<EmailSendResult> {
  // ... HTTP call ...
  if (!response.ok) {
    const errorCode = categorizeError(errorText);
    const retryable = isRetryableError(errorCode) || response.status === 429 || response.status >= 500;
    if (retryable && attempt < this.retryDelays.length) {
      const retryDelay = this.retryDelays[attempt];
      if (retryDelay !== undefined) {
        await delay(retryDelay);
        return this.sendWithRetry(params, attempt + 1);
      }
    }
    return { success: false, error: errorText, retryable };
  }
  // ...
}

// resend.ts:59-123 (sendWithRetry) — identical shape
// ses.ts (sendWithRetry) — identical shape
```

Three files, three copies of the same loop with the same semantics
(delay schedule from `this.retryDelays`, call `categorizeError`, decide
retry-or-give-up, recurse). The only thing that varies is the underlying
provider call. ~25 LOC × 3 = ~75 LOC of duplicated control flow.

Per LANGUAGE.md's deletion test: removing the retry loop from any one
provider concentrates the same logic into the caller, which doesn't
have it; removing it from all three by moving to a shared runner is a
straight depth win.

### 2. `categorizeError` pretends to be generic

```ts
// types.ts:170-225
export function categorizeError(message: string): EmailErrorCode {
  const lowerMessage = message.toLowerCase();
  if (lowerMessage.includes('rate') || lowerMessage.includes('429') || lowerMessage.includes('too many')) {
    return EmailErrorCode.RATE_LIMIT;
  }
  if (lowerMessage.includes('500') || lowerMessage.includes('503') ||
      lowerMessage.includes('service unavailable') || lowerMessage.includes('timeout')) {
    return EmailErrorCode.SERVER_ERROR;
  }
  // ... INVALID_RECIPIENT, INVALID_SENDER, AUTH_FAILED, CONTENT_REJECTED ...
}
```

Each branch string-matches against substrings that come from *every*
provider's error format. The function "pretends to be provider-
agnostic" but its keyword list is the union of MTA's JSON error texts,
SES's AWS SDK exception messages, and Resend's error envelope strings.
A new provider whose error wire format uses different substrings (e.g.
SendGrid's `"errors": [{"field":..., "message":...}]`) will silently
fall through to `UNKNOWN` until someone adds substrings to this global.

The provider already has the error in hand at parse time — the typed
exception class, the HTTP status code, the AWS error type. Forcing it
through a substring match in a global function discards that
information. Shallow.

### 3. Routing strategy switch

```ts
// routing.ts:88-172
switch (routeConfig.strategy) {
  case 'single': {
    const provider = enabledProviders[0]!;
    return { providerType: provider.providerType, ipPool: routeConfig.ipPool, source: 'org_config' };
  }
  case 'priority_failover': {
    if (healthStatuses && healthStatuses.length > 0) {
      for (const provider of enabledProviders) {
        const health = healthStatuses.find((h) => h.providerType === provider.providerType);
        if (!health || health.status !== 'down') {
          return { providerType: provider.providerType, ipPool: routeConfig.ipPool, source: 'org_config' };
        }
      }
    }
    // ... fallback to first ...
  }
  case 'workload_split': {
    const candidates = healthStatuses
      ? enabledProviders.filter((p) => { /* skip down */ })
      : enabledProviders;
    // weighted random selection ~20 LOC
  }
}
```

Three strategy implementations co-located in one function. Each is
short (3-25 LOC), and the strategies share no implementation between
them — they're separate algorithms branching on the same input.
Adding a fourth means a fourth case; the function grows linearly.

Per LANGUAGE.md's "two adapters = real seam" rule — three concrete
strategies, one shape (`candidates → ResolvedRoute | null`). The seam
is named in the code as `strategy: 'single' | 'priority_failover' |
'workload_split'` but has no module structure.

### 4. Health recording silently skipped by bypass callers

```ts
// delivery/sendCompletion.ts:84-95 — workpool-routed sends record health
if (result?.providerType) {
  await ctx.scheduler.runAfter(
    0,
    internal.lib.emailProviders.healthTracker.recordSendResult,
    {
      providerType: result.providerType,
      success: !error,
      latencyMs: result.latencyMs ?? 0,
    },
  );
}

// emails.ts:43 — `emails.sendEmail` test send: no recordSendResult
// emailsSending.ts:93, :179 — test send + manual resend: no recordSendResult
// automations/steps/email/index.ts:90 — automation email step: no recordSendResult
```

Four send producers bypass the workpool → Send completion → health
recording chain. Their sends contribute zero data to `providerHealth`.
The rolling-stats success rate the failover routing relies on is
therefore biased against workpool-routed campaigns and ignores the
existence of test sends and automation emails entirely.

This is silent drift, not a documented intentional choice. The fix
isn't to add health recording to four more call sites — that
guarantees the next caller forgets. The fix is to have one chokepoint
that every send routes through, and have the chokepoint record health.

### 5. `MtaSendParams` cast as the only enforcement

```ts
// mta.ts:24-33
export interface MtaSendParams extends EmailSendParams {
  messageId?: string;
  ipPool?: 'transactional' | 'campaign';
  engagementScore?: number;
  dkimDomain?: string;
}

// mta.ts:63-64
private async sendWithRetry(params: EmailSendParams, attempt: number): Promise<EmailSendResult> {
  const mtaParams = params as MtaSendParams;
  // ... read mtaParams.ipPool, mtaParams.engagementScore, etc.
}
```

`EmailProvider.sendEmail`'s declared shape is `EmailSendParams`, but
MTA-specific extras are smuggled through via cast. The compiler has no
opinion on whether a caller targeting `mta` provided the extras, and
no opinion on whether a caller targeting `resend` accidentally
attached `ipPool` (the cast accepts anything assignable to
`EmailSendParams`). The type system says "all `EmailProvider`s accept
`EmailSendParams`" — the reality says "MTA accepts a superset; SES and
Resend accept exactly the base."

Per LANGUAGE.md: "the interface is the test surface." Casting around
the interface dodges the surface.

### 6. `sendBatch` is documented dead code

```ts
// resend.ts:131-159 (comment-included)
async sendBatch(params: EmailBatchParams): Promise<EmailBatchResult> {
  // Note: Rate limiting is now handled by workpool at the job level
  // This batch method is kept for backwards compatibility but
  // new code should use workpool for rate-limited sending
  for (let i = 0; i < params.emails.length; i++) {
    // sequential .sendEmail() loop
  }
}
```

All three providers ship a `sendBatch` that loops over `sendEmail`
sequentially. The comment in `resend.ts` calls it backcompat. Today's
workpool (`lib/emailWorkpool.ts`) handles per-job rate limiting; no
caller invokes `sendBatch`. ~30 LOC × 3 providers + interface
declaration = ~100 LOC of unreachable code.

### 7. The factory cache is a hand-rolled singleton

```ts
// index.ts:41-47, 67-88, 109-132
let cachedProvider: EmailProvider | null = null;
let cachedProviderType: EmailProviderType | null = null;
const cachedProvidersByType: Partial<Record<EmailProviderType, EmailProvider>> = {};

export function getEmailProvider(): EmailProvider {
  // re-read env var, check cache, switch on providerType, instantiate
}

export function getProviderByType(type: EmailProviderType): EmailProvider {
  // check cache, switch on type, instantiate
}
```

Two cache variables, two factory functions, an explicit
`clearProviderCache()` for tests. The cache exists because constructing
a `Resend` client or an `SESClient` is non-trivial. But the cache lives
*next to* the switch that dispatches on type — and registry-dispatched
modules give caching for free via ES module-level singletons.

### 8. CONTEXT.md collision note marks the seam

```
// CONTEXT.md, "Sending domain provider adapter (module)"
_Avoid_: ..., Email provider module (collides with the existing
`lib/emailProviders/` factory which is the send-side provider
abstraction — different surface), ...
```

The codebase has two parallel provider abstractions (domain-side and
send-side), but only one is named with the module discipline. The
collision note records the asymmetry — a TODO embedded in the
vocabulary.

### Shared framing

Per LANGUAGE.md's deletion test on each layer:

- **Provider classes**: deleting the classes and inlining their bodies
  at the factory's switch reproduces the three-cases switch + three
  retry loops at the factory's site. Concentrating doesn't remove
  complexity here — the classes earn their keep as a seam, just under
  the wrong dispatch shape.
- **`categorizeError` global**: deleting it and having each provider
  classify directly removes the substring-soup function. Concentrates
  knowledge where the error originates. Deep cut.
- **Retry loops**: deleting the three copies and centralizing into one
  runner that consumes a declared `retryDelays` array removes ~50 LOC
  of duplicated control flow with no per-provider variation behind it.
- **Routing strategy switch**: deleting the cases and inlining
  per-strategy logic at the dispatcher's site grows the dispatcher
  linearly — the switch is the symptom of the missing seam.
- **`sendBatch`**: deleting it from all three providers + the interface
  removes ~100 LOC of unreferenced code. No depth concern.

Three independent deepenings (provider adapter, route strategy, health
relocation) compose into one folder restructure. The CONTEXT.md
entries for all four ride on the same name change.

## Decision

Three new module families and one renamed sibling, all under
`apps/api/convex/lib/sendProviders/` (the renamed folder, replacing
`lib/emailProviders/`'s send-side files):

- **`<kind>/index.ts`** — **Send provider adapter (module)** per
  provider (`mta`, `ses`, `resend`). Owns single-attempt `sendEmail`,
  per-provider `categorizeError`, declared `retryDelays`, and a typed
  `ExtrasFor<K>` second argument.
- **`dispatch.ts`** — **Send dispatch (helper)**. One exported
  function `sendProviderDispatch(kind, params, extras?)`. Owns the
  retry loop, error categorization at the boundary, and uniform
  `providerHealth` recording on every attempt.
- **`strategies/<kind>/index.ts`** — **Send route strategy (module)**
  per strategy (`single`, `priority_failover`, `workload_split`).
  Owns `select(entries, healthStatuses?)`.
- **`health.ts`** — **Send provider health (module)**. Renamed from
  `healthTracker.ts`. Same exports.

Plus: registry files at `sendProviders/index.ts` and
`strategies/index.ts`; a thinned `routing.ts` as the
strategy dispatcher; deletion of `sendBatch` from the interface and
all three adapters; deletion of `getEmailProvider()` /
`getProviderByType()` / `clearProviderCache()` /
`getConfiguredProviderName()`; deletion of the global
`categorizeError`. The remaining file moves
(`mtaIdentity.ts`, `sesIdentity.ts`, `domainVerification.ts`) are
out-of-scope — they belong to ADR-0018's surface.

### Send provider adapter (module) shape

```ts
// apps/api/convex/lib/sendProviders/types.ts

export type SendProviderKind = 'mta' | 'ses' | 'resend';

// Base send params shared across all providers (no extras).
export interface EmailSendParams {
  to: string;
  from: string;
  subject: string;
  html: string;
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: EmailAttachment[];
}

// Per-provider extras union. Each provider declares its own shape; the
// dispatcher narrows by `kind` at the call site.
export type MtaExtras = {
  messageId?: string;
  ipPool?: 'transactional' | 'campaign';
  engagementScore?: number;
  dkimDomain?: string;
};
export type SesExtras = {};
export type ResendExtras = {};

export type ExtrasFor<K extends SendProviderKind> =
  K extends 'mta' ? MtaExtras :
  K extends 'ses' ? SesExtras :
  K extends 'resend' ? ResendExtras :
  never;

// Single-attempt send result. No `retryable` in success; on failure,
// the module returns a typed `errorCode` derived from its own
// `categorizeError` — the dispatch helper decides retry.
export type EmailSendAttempt =
  | { success: true; id: string }
  | { success: false; errorMessage: string; errorCode: EmailErrorCode };

export enum EmailErrorCode {
  RATE_LIMIT = 'RATE_LIMIT',
  SERVER_ERROR = 'SERVER_ERROR',
  INVALID_RECIPIENT = 'INVALID_RECIPIENT',
  INVALID_SENDER = 'INVALID_SENDER',
  AUTH_FAILED = 'AUTH_FAILED',
  CONTENT_REJECTED = 'CONTENT_REJECTED',
  UNKNOWN = 'UNKNOWN',
}

export interface SendProviderModule<K extends SendProviderKind> {
  readonly kind: K;

  /**
   * Per-provider retry backoff schedule. The dispatch helper owns the
   * loop; the module declares the schedule.
   *
   * MTA today:    [1000, 5000]
   * Resend today: [1000, 5000, 30000]
   * SES today:    [1000, 5000, 30000]
   */
  readonly retryDelays: readonly number[];

  /**
   * Single-attempt send. No internal retry. Returns success with the
   * provider's message id, or failure with the raw error message and
   * the module's typed `EmailErrorCode`. The dispatch helper decides
   * retry based on the code.
   */
  sendEmail(
    params: EmailSendParams,
    extras?: ExtrasFor<K>,
  ): Promise<EmailSendAttempt>;

  /**
   * Per-provider error-response parsing. The dispatch helper passes
   * the raw error string + optional HTTP status; the module returns
   * its typed code. Replaces the global `categorizeError` in
   * pre-deepening `types.ts`.
   */
  categorizeError(message: string, httpStatus?: number): EmailErrorCode;
}
```

The pre-deepening `EmailProvider` interface (`getProviderName`,
`sendEmail`, `sendBatch`) is gone. `getProviderName` is replaced by
the typed `kind` discriminator on the module. `sendBatch` is deleted.

### Registry

```ts
// apps/api/convex/lib/sendProviders/index.ts

import { mtaSendProvider } from './mta';
import { sesSendProvider } from './ses';
import { resendSendProvider } from './resend';
import type { SendProviderKind, SendProviderModule } from './types';

export const SEND_PROVIDERS = {
  mta: mtaSendProvider,
  ses: sesSendProvider,
  resend: resendSendProvider,
} as const satisfies Record<SendProviderKind, SendProviderModule<SendProviderKind>>;

export function providerFor<K extends SendProviderKind>(
  kind: K,
): SendProviderModule<K> {
  const mod = SEND_PROVIDERS[kind];
  if (!mod) {
    throw new Error(`Unknown send provider: ${kind}`);
  }
  return mod as unknown as SendProviderModule<K>;
}

export function isSendProviderKind(
  kind: string | undefined | null,
): kind is SendProviderKind {
  return kind === 'mta' || kind === 'ses' || kind === 'resend';
}

export type { SendProviderKind, SendProviderModule, ExtrasFor, MtaExtras, SesExtras, ResendExtras, EmailSendAttempt, EmailErrorCode, EmailSendParams } from './types';
```

Mirrors `convex/domains/providers/index.ts` (ADR-0018) line-for-line.
Adding Postmark is a one-folder change: `sendProviders/postmark/`,
one entry in `SEND_PROVIDERS`, one literal in `SendProviderKind`. The
`satisfies` check catches missing methods at compile time.

### Send dispatch (helper) shape

```ts
// apps/api/convex/lib/sendProviders/dispatch.ts

import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { providerFor } from './index';
import type {
  SendProviderKind, EmailSendParams, ExtrasFor, EmailSendAttempt, EmailErrorCode,
} from './types';

export interface DispatchResult {
  /** Final attempt outcome. */
  result: EmailSendAttempt;
  /** Which provider was used (for downstream observability). */
  providerType: SendProviderKind;
  /** Total elapsed across all attempts. */
  latencyMs: number;
  /** Number of attempts including retries. */
  attempts: number;
}

/**
 * Single entry point for send-side provider work. Six producers route
 * through this: the workpool worker, the campaign orchestrator's
 * one-off test send, the post-send resend in `emailsSending.ts`, the
 * automation email step, the transactional HTTP send, and any future
 * internal sender.
 *
 * Responsibilities:
 *   1. Retry loop driven by `module.retryDelays` and `module.categorizeError`.
 *   2. Health recording — writes to `providerHealth` after every
 *      terminal outcome (success or exhausted retries). Closes the
 *      silent-drift bug where bypass callers (test sends, automation
 *      steps) today skip health recording.
 *   3. Error categorization at the boundary — the result carries the
 *      typed `EmailErrorCode`, not just the raw error string.
 */
export async function sendProviderDispatch<K extends SendProviderKind>(
  ctx: ActionCtx,
  kind: K,
  params: EmailSendParams,
  extras?: ExtrasFor<K>,
): Promise<DispatchResult> {
  const module = providerFor(kind);
  const startTime = Date.now();
  let attempts = 0;

  for (let attempt = 0; attempt <= module.retryDelays.length; attempt++) {
    attempts++;
    const result = await module.sendEmail(params, extras);

    if (result.success) {
      const latencyMs = Date.now() - startTime;
      await ctx.scheduler.runAfter(
        0,
        internal.lib.sendProviders.health.recordSendResult,
        { providerType: kind, success: true, latencyMs },
      );
      return { result, providerType: kind, latencyMs, attempts };
    }

    const isLastAttempt = attempt === module.retryDelays.length;
    const retryable = isRetryable(result.errorCode);

    if (!retryable || isLastAttempt) {
      const latencyMs = Date.now() - startTime;
      await ctx.scheduler.runAfter(
        0,
        internal.lib.sendProviders.health.recordSendResult,
        { providerType: kind, success: false, latencyMs },
      );
      return { result, providerType: kind, latencyMs, attempts };
    }

    const delayMs = module.retryDelays[attempt]!;
    await delay(delayMs);
  }

  // Unreachable — the loop returns at every iteration.
  throw new Error('sendProviderDispatch: invariant violated — loop exhausted without returning');
}

function isRetryable(code: EmailErrorCode): boolean {
  return code === EmailErrorCode.RATE_LIMIT || code === EmailErrorCode.SERVER_ERROR;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

The helper is the only place that knows about retry semantics on the
send side. Six producers all route through it; no caller imports a
provider module directly.

### Send route strategy (module) shape

```ts
// apps/api/convex/lib/sendProviders/strategies/types.ts

import type { SendProviderKind } from '../types';

export type SendRouteStrategyKind =
  | 'single' | 'priority_failover' | 'workload_split';

export interface ProviderEntry {
  providerType: SendProviderKind;
  weight?: number;
  isEnabled: boolean;
}

export interface ProviderHealthStatus {
  providerType: SendProviderKind;
  status: 'healthy' | 'degraded' | 'down';
  successRate: number;
}

export interface ResolvedRoute {
  providerType: SendProviderKind;
  ipPool?: string;
  source: 'org_config' | 'env_fallback' | 'default';
}

export interface SendRouteStrategyModule<K extends SendRouteStrategyKind> {
  readonly kind: K;

  /**
   * Pure function. Given enabled providers and (optionally) their
   * health statuses, return the chosen provider — or null if no
   * candidate is selectable (caller falls back).
   */
  select(
    entries: readonly ProviderEntry[],
    ipPool: string | undefined,
    healthStatuses?: readonly ProviderHealthStatus[],
  ): ResolvedRoute | null;
}
```

```ts
// apps/api/convex/lib/sendProviders/strategies/index.ts

import { singleStrategy } from './single';
import { priorityFailoverStrategy } from './priority_failover';
import { workloadSplitStrategy } from './workload_split';
import type {
  SendRouteStrategyKind, SendRouteStrategyModule,
} from './types';

export const SEND_ROUTE_STRATEGIES = {
  single: singleStrategy,
  priority_failover: priorityFailoverStrategy,
  workload_split: workloadSplitStrategy,
} as const satisfies Record<SendRouteStrategyKind, SendRouteStrategyModule<SendRouteStrategyKind>>;

export function strategyFor<K extends SendRouteStrategyKind>(
  kind: K,
): SendRouteStrategyModule<K> {
  const mod = SEND_ROUTE_STRATEGIES[kind];
  if (!mod) {
    throw new Error(`Unknown send route strategy: ${kind}`);
  }
  return mod as unknown as SendRouteStrategyModule<K>;
}

export type {
  SendRouteStrategyKind, SendRouteStrategyModule, ProviderEntry,
  ProviderHealthStatus, ResolvedRoute,
} from './types';
```

The thin `routing.ts` dispatcher:

```ts
// apps/api/convex/lib/sendProviders/routing.ts

import { strategyFor } from './strategies';
import type { ResolvedRoute, ProviderHealthStatus } from './strategies/types';
import { getOptional } from '../env';
import { isSendProviderKind } from './index';

export interface ProviderRouteConfig {
  strategy: 'single' | 'priority_failover' | 'workload_split';
  providers: Array<{
    providerType: string;
    weight?: number;
    isEnabled: boolean;
  }>;
  ipPool?: string;
}

/**
 * Resolve a route from an org's `providerRoutes` config. Fall through
 * to env-var → `'mta'` default when no config is present, no providers
 * are enabled, or the chosen strategy returns null.
 */
export function resolveRoute(
  routeConfig: ProviderRouteConfig | null,
  healthStatuses?: readonly ProviderHealthStatus[],
): ResolvedRoute {
  if (!routeConfig) return fallback();

  const enabledEntries = routeConfig.providers
    .filter((p) => p.isEnabled && isSendProviderKind(p.providerType))
    .map((p) => ({
      providerType: p.providerType as SendProviderKind,
      weight: p.weight,
      isEnabled: p.isEnabled,
    }));

  if (enabledEntries.length === 0) return fallback();

  const strategy = strategyFor(routeConfig.strategy);
  const selected = strategy.select(enabledEntries, routeConfig.ipPool, healthStatuses);
  return selected ?? fallback();
}

function fallback(): ResolvedRoute {
  const envProvider = getOptional('EMAIL_PROVIDER');
  if (envProvider && isSendProviderKind(envProvider)) {
    return { providerType: envProvider, source: 'env_fallback' };
  }
  return { providerType: 'mta', source: 'default' };
}
```

Six branches of pre-deepening `resolveRoute` (one strategy switch with
multiple inner forks for health filtering and fallback) become one
linear function — validate config, dispatch, fallback.

Each strategy module is short and pure:

```ts
// apps/api/convex/lib/sendProviders/strategies/single/index.ts
export const singleStrategy: SendRouteStrategyModule<'single'> = {
  kind: 'single',
  select(entries, ipPool) {
    const first = entries[0];
    if (!first) return null;
    return { providerType: first.providerType, ipPool, source: 'org_config' };
  },
};

// apps/api/convex/lib/sendProviders/strategies/priority_failover/index.ts
export const priorityFailoverStrategy: SendRouteStrategyModule<'priority_failover'> = {
  kind: 'priority_failover',
  select(entries, ipPool, healthStatuses) {
    if (healthStatuses && healthStatuses.length > 0) {
      for (const entry of entries) {
        const health = healthStatuses.find((h) => h.providerType === entry.providerType);
        if (!health || health.status !== 'down') {
          return { providerType: entry.providerType, ipPool, source: 'org_config' };
        }
      }
    }
    const first = entries[0];
    if (!first) return null;
    return { providerType: first.providerType, ipPool, source: 'org_config' };
  },
};

// apps/api/convex/lib/sendProviders/strategies/workload_split/index.ts
export const workloadSplitStrategy: SendRouteStrategyModule<'workload_split'> = {
  kind: 'workload_split',
  select(entries, ipPool, healthStatuses) {
    const candidates = healthStatuses
      ? entries.filter((p) => {
          const h = healthStatuses.find((s) => s.providerType === p.providerType);
          return !h || h.status !== 'down';
        })
      : entries;
    const pool = candidates.length > 0 ? candidates : entries;
    if (pool.length === 0) return null;

    const totalWeight = pool.reduce((sum, p) => sum + (p.weight ?? 100), 0);
    let random = Math.random() * totalWeight;
    for (const entry of pool) {
      random -= entry.weight ?? 100;
      if (random <= 0) {
        return { providerType: entry.providerType, ipPool, source: 'org_config' };
      }
    }
    const last = pool[pool.length - 1]!;
    return { providerType: last.providerType, ipPool, source: 'org_config' };
  },
};
```

### Send provider health (module) shape

Identical to today's `healthTracker.ts`, file path moved.

```
healthTracker.ts          →  health.ts
```

Imports across the codebase change from
`internal.lib.emailProviders.healthTracker.recordSendResult` to
`internal.lib.sendProviders.health.recordSendResult` (mechanical
rename). No exports change; no schema change.

### Call-site shape after the cut

Six producers, six diffs. Each shrinks.

```ts
// apps/api/convex/emails.ts (test-send action)

// Before:
const provider = getEmailProvider();
const result = await provider.sendEmail({ to, from, subject, html, replyTo });
if (!result.success) throw new Error(`Failed to send email: ${result.error}`);
return { id: result.id, success: true };

// After:
const routeConfig = await ctx.runQuery(internal.providerRoutes.getRoute, {
  messageType: 'transactional',
});
const allHealth = await ctx.runQuery(internal.lib.sendProviders.health.getAllProviderHealth, {});
const resolved = resolveRoute(routeConfig, allHealth);
const dispatched = await sendProviderDispatch(ctx, resolved.providerType, { to, from, subject, html, replyTo });
if (!dispatched.result.success) {
  throw new Error(`Failed to send email: ${dispatched.result.errorMessage}`);
}
return { id: dispatched.result.id, success: true };
```

```ts
// apps/api/convex/emailWorker.ts (worker)

// Before:
const provider = args.providerType
  ? getProviderByType(args.providerType as EmailProviderType)
  : getEmailProvider();
const result = await provider.sendEmail({ to, from, subject, html, replyTo, headers, attachments });

// After:
const kind = args.providerType ?? 'mta';
const extras: ExtrasFor<'mta'> | {} = kind === 'mta'
  ? { messageId: args.messageId, ipPool: args.ipPool, engagementScore: args.engagementScore, dkimDomain: args.dkimDomain }
  : {};
const dispatched = await sendProviderDispatch(ctx, kind, { to, from, subject, html, replyTo, headers, attachments }, extras as ExtrasFor<typeof kind>);
// result is dispatched.result; latency is dispatched.latencyMs; provider type is dispatched.providerType.
```

```ts
// apps/api/convex/automations/steps/email/index.ts (automation email step)

// Before:
const provider = getEmailProvider();
const result = await provider.sendEmail({ to, from, subject, html });
// ... result handling — no health recording today

// After:
const kind = (getOptional('EMAIL_PROVIDER') ?? 'mta') as SendProviderKind;
const dispatched = await sendProviderDispatch(ctx, kind, { to, from, subject, html });
// dispatched.result carries the same shape; the helper records health automatically.
```

```ts
// apps/api/convex/delivery/sendCompletion.ts:84-95

// Before:
if (result?.providerType) {
  await ctx.scheduler.runAfter(0,
    internal.lib.emailProviders.healthTracker.recordSendResult,
    { providerType: result.providerType, success: !error, latencyMs: result.latencyMs ?? 0 },
  );
}

// After: deleted — the dispatch helper has already recorded health for this attempt.
// Send completion focuses on the Send-row state transition only.
```

### File layout

```
apps/api/convex/lib/sendProviders/                  (new — renamed from emailProviders/)
  index.ts                                          (registry + providerFor + isSendProviderKind)
  types.ts                                          (SendProviderModule, ExtrasFor, EmailSendAttempt, EmailErrorCode)
  dispatch.ts                                       (sendProviderDispatch helper)
  routing.ts                                        (thin resolveRoute dispatcher)
  health.ts                                         (renamed from healthTracker.ts; same exports)
  mta/
    index.ts                                        (mtaSendProvider module — single-attempt sendEmail, categorizeError, retryDelays, MtaExtras)
  ses/
    index.ts                                        (sesSendProvider module)
  resend/
    index.ts                                        (resendSendProvider module)
  strategies/
    index.ts                                        (strategy registry + strategyFor)
    types.ts                                        (SendRouteStrategyModule, ProviderEntry, ProviderHealthStatus, ResolvedRoute)
    single/index.ts
    priority_failover/index.ts
    workload_split/index.ts
  __tests__/
    dispatch.integration.test.ts                    (new — retry semantics + health recording)
    providers.test.ts                               (new — per-provider sendEmail + categorizeError contract)
    strategies.test.ts                              (new — per-strategy select() contract)
```

Files that move *outside* `sendProviders/` because they belong to the
domain-side adapter (ADR-0018):

```
apps/api/convex/lib/emailProviders/mtaIdentity.ts        →  unchanged path
apps/api/convex/lib/emailProviders/sesIdentity.ts        →  unchanged path
apps/api/convex/lib/emailProviders/domainVerification.ts →  unchanged path
```

These three files stay at `lib/emailProviders/` since ADR-0018's
adapters import from them by that exact path. Renaming the folder
to `lib/sendProviders/` would touch ADR-0018 paths. The three remain
where they are; the empty-ish `lib/emailProviders/` directory keeps
its name with only the domain-side shared HTTP/SDK clients in it.
A future ADR may consolidate, but it's out of scope here.

Actually — re-examining the layout: pre-deepening
`lib/emailProviders/` mixes send-side and domain-side concerns. The
send-side files move to `lib/sendProviders/`. The remaining three
shared HTTP/SDK clients (`mtaIdentity.ts`, `sesIdentity.ts`,
`domainVerification.ts`) are domain-side-only — they could move into
`convex/domains/providers/{mta,ses}/clients.ts` or similar. That move
is *adjacent* to this ADR but distinct; it's tracked as a follow-up
(no production code change, only file-path moves + import updates),
not bundled here, to keep the blast radius of this ADR limited to
the send-side surface.

## Considered options

### Scope of deepening

1. **Adapter only** — replace just the switch in `index.ts` with a
   registry. Provider classes stay; routing, health, error
   categorization, sendBatch all stay as-is. Rejected — the strongest
   drift signals (categorizeError pretending to be generic; retry
   loop duplicated 3 times; bypass callers silently skipping health)
   would survive untouched.
2. **Adapter + dead code drop** — the above, plus delete `sendBatch`
   from the interface and three impls. Rejected as too narrow —
   leaves the central friction (retry duplication, global
   categorizeError, bypass-caller drift) on the table.
3. **Adapter + routing strategies** — Adapter + per-strategy module
   family. Rejected as inconsistent — touching routing without
   touching the retry loop / categorization / health drift leaves the
   send-side abstraction half-deepened.
4. **Full lib/emailProviders/ restructure** *(chosen)*. Adapter +
   routing strategies + dispatch helper (retry + health +
   categorization) + health rename + dead-code drop. Closes every
   drift signal in one folder; mirrors ADR-0018's level of completeness.

### One unified provider registry vs. separate registries

1. **Unified per-provider module** — one folder per provider holds
   both domain-side methods (`registerDomain`/`writeIdentity`/...) and
   send-side methods (`sendEmail`). Some methods optional (Resend has
   no `registerDomain`). One name for "Provider Postmark" = one folder.
   Rejected — different surfaces (send vs. register), different runtimes
   (`'use node'` action vs. mutation), different provider sets (Resend
   ships only on send side). Forcing both surfaces into one shape
   collapses real distinctions; the deletion test confirms each
   surface earns its keep independently.
2. **Separate registries** *(chosen)*. `convex/domains/providers/`
   keeps the domain-side adapter (ADR-0018) for `mta`+`ses`. New
   `convex/lib/sendProviders/` holds the send-side adapter for
   `mta`+`ses`+`resend`. Two registries, two compile-time `satisfies`
   checks, two `providerFor(kind)` lookups — by design.

### Module surface — `categorizeError` per-provider

1. **Keep `categorizeError` as a global function** in `types.ts`,
   shared across providers. Rejected — the substring-soup it does
   today only works by accident; a new provider's error format may
   fall through to `UNKNOWN`.
2. **Per-provider `categorizeError(message, httpStatus?)`** *(chosen)*.
   Each adapter parses its own error wire format. MTA parses JSON
   status; SES parses AWS error class types; Resend parses Resend's
   error envelope. The dispatch helper gets a typed code back and
   decides retry.

### Module surface — retry loop centralized vs. per-provider

1. **Each module keeps its retry loop internal** — `retryDelays` is
   informational metadata. Rejected — the deletion test confirms the
   three loops are duplicates; centralizing concentrates the loop in
   one place and frees each adapter from owning state across attempts.
2. **Centralized retry runner in the dispatch helper** *(chosen)*. The
   module declares `retryDelays: readonly number[]`. The helper
   iterates, calls `sendEmail` once per attempt, classifies via
   `categorizeError`, decides retry. Provider modules shrink to single
   `sendEmail` calls without retry-state plumbing.
3. **Hybrid: helper owns retry; categorization stays per-call inside
   `sendEmail`** — single-attempt `sendEmail` returns a tagged result
   that the runtime classifies post-call without calling the module
   again. Concerns: forces the module to expose `categorizeError`
   as a free function rather than a method, breaks the encapsulation
   of "this provider knows its error shape." Rejected.

### Health write site

1. **Health stays in Send completion (module)** — pre-deepening
   ownership preserved. Rejected — three of the six send producers
   bypass Send completion today; their sends miss `providerHealth`
   recording. The drift is silent and gets worse with every new
   bypass caller.
2. **Dispatch helper records on every send** *(chosen)*. Every send
   producer routes through the helper; the helper records uniformly.
   ADR-0006 (Send completion) noted "Provider health stays here…
   because it answers 'did the provider's API accept the send?' (a
   worker-attempt concern), not 'what is the Send's current state'
   (the lifecycle's concern)." The "worker-attempt concern" framing
   still holds — the recording site just moves one layer upstream,
   to the dispatch helper that all six producers use. Send
   completion's CONTEXT.md entry is updated accordingly.
3. **Dispatch helper returns a recordable effect; caller decides** —
   `{ result, recordHealth(): Promise<void> }`. Concerns: extra
   ceremony for a thing every caller should do; cargo-cult
   forgetters fork the same drift the deepening is closing.
   Rejected.

### Module surface — typed extras vs. cast

1. **Keep `MtaSendParams` cast** — `EmailProvider.sendEmail` accepts
   `EmailSendParams`; MTA-specific params are smuggled through `as
   MtaSendParams`. Rejected — type system has no opinion on whether
   a caller targeting `'mta'` provided the extras, or whether a
   caller targeting `'resend'` accidentally attached `ipPool`.
2. **Typed `ExtrasFor<K>` second arg on `sendEmail`** *(chosen)*. The
   adapter's method signature is
   `sendEmail(params: EmailSendParams, extras?: ExtrasFor<K>)`; the
   dispatch helper carries the discriminant `K` through. MTA carries
   `MtaExtras` (`ipPool`/`engagementScore`/`dkimDomain`/`messageId`);
   SES and Resend carry `{}` today. Future provider-specific knobs
   land as additions to that provider's `ExtrasFor`.

### Folder location

1. **`convex/lib/sendProviders/`** *(chosen)*. Mirrors the current
   `lib/emailProviders/` path; minimal import churn.
2. **`convex/delivery/providers/`** — promote out of `lib/`,
   alongside `delivery/sendLifecycle.ts`, `delivery/sendCompletion.ts`,
   `delivery/sendReads.ts`. Argument: providers are a delivery
   concern, not a generic lib utility. Concern: bigger import-path
   churn; cross-cuts the audit-log domain less clearly. Rejected
   as a cosmetic restructure not paid for by this deepening.
3. **`convex/providers/send/` alongside `convex/providers/domain/`** —
   promote both adapters to top-level. Concern: requires moving
   `domains/providers/` (ADR-0018 paths). Rejected for the same
   reason as 2.

### Per-strategy modules vs. keep `routing.ts` switch

1. **Keep the strategy switch in `resolveRoute`** — the three
   strategies are short (3-25 LOC each). Concern: the deletion test
   on each strategy passes individually (`single` is 3 LOC, hard to
   call shallow), but the missing seam name is the bigger smell —
   the discriminator `strategy: 'single' | 'priority_failover' |
   'workload_split'` exists in the schema validator with no module
   structure. Adding `least_loaded` later means editing the switch.
   Rejected.
2. **Per-strategy modules dispatched via `strategyFor(kind)`**
   *(chosen)*. Matches the **Block module** / **Step module** /
   **Webhook event module** dispatch pattern. `resolveRoute` shrinks
   to a 6-line dispatcher; the strategies live in their own folders.
   Adding a fourth strategy is one folder.

### Module naming

1. **Send provider adapter (module)** *(chosen)*. Symmetric with
   **Sending domain provider adapter (module)** (ADR-0018):
   parallel `kind` discriminator, parallel `providerFor(kind)`
   dispatch, parallel `satisfies` check. "Send" is established
   CONTEXT.md vocabulary (Send, Send status, Send lifecycle, Send
   completion, Send reads). The `(module)` suffix signals
   registry-driven dispatch; the "adapter" qualifier per LANGUAGE.md
   names *a concrete thing satisfying an interface at a seam*.
2. **Email provider module** — rejected. The pre-deepening factory's
   name; would be a self-collision. CONTEXT.md's existing
   `_Avoid_` on the domain-side adapter explicitly retires this
   vocabulary.
3. **Mail send provider adapter** — rejected. Verbose; "Send" is the
   established domain noun.
4. **Send-side provider adapter** — rejected. Over-qualified — the
   `(module)` suffix already signals the dispatched-by-kind shape;
   the "side" hedge is unnecessary.

### Send dispatch helper naming — module vs. helper

1. **Send dispatch (module)** — would suggest a registry-keyed
   dispatch. Rejected — the dispatch helper is *one* function
   (`sendProviderDispatch`), not a registry. The `(module)` suffix
   in CONTEXT.md vocabulary signals registry shape.
2. **Send dispatch (helper)** *(chosen)*. The `(helper)` qualifier
   matches CONTEXT.md's existing usage for non-module utility
   functions (e.g. `validateReadyToSend` mentioned in the Campaign
   lifecycle entry).
3. **Send runner** — too generic; collides with the
   `runPipeline` / `runStep` vocabulary in MTA dispatch + Step
   walker. Rejected.
4. **Send executor** — rejected, same reason ADR-0004 renamed
   `stepExecutor.ts` → `stepWalker.ts`. "Executor" is generic enough
   that future maintainers will misroute things to it.

### `sendBatch` retention

1. **Keep `sendBatch` in the interface; modules implement
   sequentially** — preserves the documented backcompat surface.
   Rejected — comment in `resend.ts` explicitly says "kept for
   backwards compatibility but new code should use workpool." Grep
   confirms zero production callers. Backcompat for nobody is dead
   code.
2. **Drop `sendBatch` from the interface and all impls** *(chosen)*.
   ~100 LOC deleted; no caller change.

## Consequences

### Files that collapse / disappear

- `apps/api/convex/lib/emailProviders/index.ts` — deleted.
  `getEmailProvider()`, `getProviderByType()`, `clearProviderCache()`,
  `getConfiguredProviderName()` all go. Replaced by registry in
  `lib/sendProviders/index.ts`.
- `apps/api/convex/lib/emailProviders/types.ts` — deleted. Global
  `categorizeError`, `isRetryableError`, `EmailProvider` interface,
  `EmailProviderConfig`, `EmailProviderType`, `EmailBatchParams`,
  `EmailBatchResult`, `BatchEmailResult` all go. `EmailSendParams`,
  `EmailAttachment`, `EmailSendResult` (renamed `EmailSendAttempt`),
  `EmailErrorCode` move to `lib/sendProviders/types.ts`.
- `apps/api/convex/lib/emailProviders/mta.ts` — deleted. `MtaProvider`
  class, `MtaSendParams`, `createMtaProvider` factory go. Replaced by
  `lib/sendProviders/mta/index.ts`.
- `apps/api/convex/lib/emailProviders/ses.ts` — deleted. Replaced by
  `lib/sendProviders/ses/index.ts`.
- `apps/api/convex/lib/emailProviders/resend.ts` — deleted. Replaced
  by `lib/sendProviders/resend/index.ts`.
- `apps/api/convex/lib/emailProviders/routing.ts` — deleted. Replaced
  by the thin dispatcher in `lib/sendProviders/routing.ts` (the
  in-line strategy switch goes; the resolveRoute function shape
  carries forward).
- `apps/api/convex/lib/emailProviders/healthTracker.ts` — deleted.
  Replaced by `lib/sendProviders/health.ts` (identical content,
  renamed file, renamed Convex internal path).
- `delivery/sendCompletion.ts:84-95` — the
  `recordSendResult` scheduler call is deleted (dispatch helper
  records upstream); the surrounding mutation shrinks ~12 LOC.

Three files survive at `lib/emailProviders/` because ADR-0018's
domain-side adapters import them by current path:

- `mtaIdentity.ts` — MTA DKIM HTTP client.
- `sesIdentity.ts` — SES identity SDK wrapper.
- `domainVerification.ts` — DNS verification helpers.

A future ADR may collapse those into `convex/domains/providers/*/`
directly; out of scope here.

### Files that grow / appear

- `apps/api/convex/lib/sendProviders/index.ts` — new (~80 LOC).
  Registry + `providerFor` + `isSendProviderKind` + type re-exports.
- `apps/api/convex/lib/sendProviders/types.ts` — new (~120 LOC).
  `SendProviderModule<K>`, `ExtrasFor<K>`, `MtaExtras`, `SesExtras`,
  `ResendExtras`, `EmailSendAttempt`, `EmailErrorCode`,
  `EmailSendParams`, `EmailAttachment`.
- `apps/api/convex/lib/sendProviders/dispatch.ts` — new (~120 LOC).
  `sendProviderDispatch` helper, retry loop, health-recording
  scheduler calls, `isRetryable` predicate.
- `apps/api/convex/lib/sendProviders/routing.ts` — new (~60 LOC).
  Thin `resolveRoute` dispatcher + `fallback` helper.
- `apps/api/convex/lib/sendProviders/health.ts` — moved (~131 LOC,
  unchanged content).
- `apps/api/convex/lib/sendProviders/mta/index.ts` — new (~160 LOC).
  MTA adapter: `sendEmail` (single-attempt), `categorizeError`,
  `retryDelays`, MTA-specific extras.
- `apps/api/convex/lib/sendProviders/ses/index.ts` — new (~250 LOC).
  SES adapter.
- `apps/api/convex/lib/sendProviders/resend/index.ts` — new
  (~140 LOC). Resend adapter.
- `apps/api/convex/lib/sendProviders/strategies/index.ts` — new
  (~40 LOC). Strategy registry.
- `apps/api/convex/lib/sendProviders/strategies/types.ts` — new
  (~50 LOC). `SendRouteStrategyModule<K>` + value types.
- `apps/api/convex/lib/sendProviders/strategies/single/index.ts`
  — new (~15 LOC).
- `apps/api/convex/lib/sendProviders/strategies/priority_failover/index.ts`
  — new (~25 LOC).
- `apps/api/convex/lib/sendProviders/strategies/workload_split/index.ts`
  — new (~40 LOC).
- `apps/api/convex/lib/sendProviders/__tests__/dispatch.integration.test.ts`
  — new (~20 tests).
- `apps/api/convex/lib/sendProviders/__tests__/providers.test.ts`
  — new (~15 tests).
- `apps/api/convex/lib/sendProviders/__tests__/strategies.test.ts`
  — new (~12 tests).

Caller-side diffs (per call site):

- `apps/api/convex/emails.ts:43` (`sendEmail` action) — ~10 LOC swap;
  now resolves route + calls dispatch helper.
- `apps/api/convex/emails.ts:341, :760` (campaign + AB test
  orchestrator) — no change to `resolveRoute(...)` signature; passes
  through.
- `apps/api/convex/emailsSending.ts:93, :179` — ~10 LOC swap each.
- `apps/api/convex/emailWorker.ts:209-210` — ~5 LOC swap; the worker
  now passes `kind` directly to dispatch helper.
- `apps/api/convex/automations/steps/email/index.ts:90` — ~8 LOC
  swap; gains health recording for free.
- `apps/api/convex/transactionalApiHttp.ts:564` — no change to
  `resolveRoute(...)` signature; passes through.
- `apps/api/convex/delivery/sendCompletion.ts:84-95` — ~12 LOC
  deleted.

Net LOC change: roughly ~1100 LOC removed (deleted factory, classes,
sendBatch, retry-loop dupes, global categorizeError, health-tracker
scheduler call in sendCompletion), ~1300 LOC added (modules,
adapters, strategies, dispatch helper, types, tests). Net ~+200 LOC,
with the value distributed across: locality (provider classes 3 → 0;
retry loops 3 → 1; error categorization sites 1 global + 3 internal
→ 3 per-provider; routing strategy cases 1 switch with 3 inner forks
→ 3 modules; health-recording call sites 1 partial → 1 universal),
typed adapter contract with declared extras, registry-driven
dispatch with compile-time `satisfies`, and a per-provider seam that
survives the addition of a 4th provider as a one-folder change.

### No schema changes

`providerHealth` table is unchanged. `providerRoutes` table is
unchanged. The `EmailProviderType` literal union (validated at the
schema level via `providerType: v.string()`) keeps the same three
literals. `strategy` literal union (`'single' | 'priority_failover' |
'workload_split'`) keeps the same three literals. The deepening is
pure code structure.

### Migration

No data migration. No feature flags. No shadow window. The cutover
to `lib/sendProviders/` happens atomically in the caller-cutover
phase (see execution plan). Pre-deepening files at
`lib/emailProviders/` are deleted in the cleanup phase once tsc
proves there are no remaining importers.

### Test surface

`apps/api/convex/lib/sendProviders/__tests__/dispatch.integration.test.ts`
(new, ~20 tests):

**Retry semantics:**
- First-attempt success: asserts `result.success`, `attempts: 1`,
  health recorded as `success: true`.
- Retryable failure → retry → success: asserts `attempts > 1`,
  health recorded once as `success: true` (only on the terminal
  outcome, not per-attempt).
- Retryable failure → exhausted retries: asserts `attempts ===
  retryDelays.length + 1`, health recorded as `success: false`.
- Non-retryable failure on first attempt: asserts `attempts: 1`,
  no retry sleep, health recorded as `success: false`.
- Per-provider retry counts: MTA retries up to 3 times (initial +
  `[1s, 5s]`); Resend retries up to 4 times (initial + `[1s, 5s,
  30s]`).

**Health recording:**
- Recording fires exactly once per dispatch (not per attempt).
- Recording captures cumulative `latencyMs` across all attempts.
- Bypass-caller paths (test send, automation email step) record
  health — regression test for the silent-drift bug being closed.

**Error categorization integration:**
- Dispatch result's `errorCode` matches the module's
  `categorizeError(message, httpStatus)` for the same input —
  asserts the helper uses the module, not a global.

**Extras typing:**
- `sendProviderDispatch(ctx, 'mta', params, { ipPool: 'campaign' })`
  type-checks; `sendProviderDispatch(ctx, 'resend', params, {
  ipPool: 'campaign' })` is a TS compile error
  (`@ts-expect-error` + diagnostic match).

`apps/api/convex/lib/sendProviders/__tests__/providers.test.ts` (new,
~15 tests):

- MTA `sendEmail` succeeds with stubbed HTTP 200 → `{ success: true,
  id }`.
- MTA `sendEmail` with HTTP 500 → `{ success: false, errorCode:
  SERVER_ERROR }`.
- MTA `sendEmail` with HTTP 429 → `{ success: false, errorCode:
  RATE_LIMIT }`.
- MTA `categorizeError` covers each `EmailErrorCode` branch from
  the MTA's error wire format.
- SES `sendEmail` succeeds with stubbed SDK call.
- SES `categorizeError` maps AWS error types correctly
  (`Throttling`, `MessageRejected`, `MailFromDomainNotVerified`, etc.).
- Resend `sendEmail` succeeds with stubbed SDK call.
- Resend `categorizeError` maps Resend error names correctly.
- Each adapter's `kind` matches the registry entry's key (smoke
  test against the `satisfies` check).
- Each adapter's `retryDelays` matches pre-deepening intent
  (regression — same counts).

`apps/api/convex/lib/sendProviders/__tests__/strategies.test.ts`
(new, ~12 tests):

- `singleStrategy.select` returns the first enabled entry.
- `singleStrategy.select` with empty entries returns null.
- `priorityFailoverStrategy.select` with no health returns first.
- `priorityFailoverStrategy.select` skips entries with status
  `'down'`.
- `priorityFailoverStrategy.select` falls through to first when all
  are down.
- `workloadSplitStrategy.select` honors weights (statistical
  assertion over N samples).
- `workloadSplitStrategy.select` excludes entries with status
  `'down'`.
- `workloadSplitStrategy.select` with all-down entries returns
  using the full pool (today's behaviour preserved).
- `strategyFor('single')` returns the single strategy module; same
  for the other two.
- `strategyFor` with an unknown kind throws (registry invariant).
- `resolveRoute(null)` returns the env-var-or-default fallback.
- `resolveRoute({ providers: [], ... })` returns fallback (no
  enabled candidates).
- `resolveRoute` with `EMAIL_PROVIDER=resend` env returns
  `{ providerType: 'resend', source: 'env_fallback' }`.

### CONTEXT.md additions

The new section `## Send providers` lands between **Postbox outbound
lifecycle** and **MTA dispatch** (already added inline with this
ADR's design):

- **Send provider adapter (module)** — the per-provider unit.
- **Send dispatch (helper)** — the orchestrator wrapping single
  attempts.
- **Send route strategy (module)** — the per-strategy unit.
- **Send provider health (module)** — the read/write of
  `providerHealth`.

Updated existing entries:

- **Send completion (module)** — health-recording rationale updated:
  the write site moves one layer upstream to the dispatch helper,
  closing the silent-drift bug where bypass callers were missing
  from `providerHealth`. The "worker-attempt vs. lifecycle-state"
  split still holds.
- **Sending domain provider adapter (module)** — the `_Avoid_`
  collision note about "Email provider module" is updated to
  retire that vocabulary in favor of "Send provider adapter
  (module)."

### Vocabulary discipline

Avoid:

- **Email provider module** — the pre-deepening factory's name;
  retired by this ADR.
- **Send provider module** (without "adapter" or `(module)` suffix)
  — drops the role qualifier. Per LANGUAGE.md, "adapter" names *a
  concrete thing satisfying an interface at a seam*.
- **Mail send provider adapter** — verbose; "Send" is the
  established domain noun.
- **Send-side provider adapter** — over-qualified; the `(module)`
  suffix carries the dispatch-by-kind shape.
- **Provider dispatcher** — collides with the Webhook dispatcher
  vocabulary (ADR-0003).
- **Send dispatch (module)** — the `(module)` suffix implies a
  registry; the dispatch helper is one function, not a registry.
- **Send route module** (without "strategy") — collides with the
  `providerRoutes` config row name. The module owns *strategies*,
  not routes.
- **Routing strategy module** — drops the domain prefix; "routing"
  is overloaded with HTTP routing.

### Cross-references

- ADR-0005 (Channel inbound adapters) — per-provider adapter module
  pattern precedent; same `satisfies` registry shape.
- ADR-0006 (Send completion module) — defined the "worker-attempt
  vs. lifecycle-state" health-write split; this ADR moves the write
  site to a strictly upstream location without changing the
  framing.
- ADR-0018 (Sending domain provider adapter) — sibling adapter on
  the domain-registration side. The two registries (this ADR's
  send-side + ADR-0018's domain-side) are intentionally separate
  surfaces with parallel naming, parallel dispatch, and parallel
  satisfies-checks.

### Known follow-ups

1. `lib/emailProviders/{mtaIdentity,sesIdentity,domainVerification}.ts`
   — these three files are consumed only by ADR-0018's adapters.
   They could move into `convex/domains/providers/{mta,ses}/` as
   colocated HTTP/SDK clients. Out of scope here; tracked as a
   future cleanup PR with no behavioral change.
2. **Transactional send intake (module)** — `transactionalApiHttp.ts`
   (659 LOC) was identified during the same architecture review as a
   strong candidate for the Form submission (module) pattern. Not
   bundled here, but the caller-cutover in this ADR will leave that
   file marginally cleaner (one fewer concern to extract later).
3. **Per-strategy `least_loaded` / `geo_aware` modules** — adding a
   fourth or fifth strategy is now a one-folder change; left as a
   future opportunity rather than a commitment.
