# Integration import provider adapter modules + walker — typed seam across paginated remote contact imports, closing per-provider plumbing duplication

**Status:** accepted

## Context

`convex/integrationImports.ts` (443 LOC, `'use node'`) and
`convex/integrationImportsMutations.ts` (248 LOC) together implement the
paginated-contact-import path against Mailchimp and Stripe. Two
per-provider page-processor actions (`processMailchimpPage`,
`processStripePage`) re-implement the same orchestration in parallel,
and two per-provider start mutations (`startMailchimpImport`,
`startStripeImport`) re-implement the same validation + insert + schedule
block. ADR-0025 explicitly named this as a "surviving switch-where-
walker-belongs" candidate that lands cleanly after the
**Organization deletion module-family**.

The friction is structural duplication: ~200 LOC of orchestration
(retries, pagination cursor handling, progress patching, completion
mutation calls, page-to-row transformation, schedule-next-page) is
present twice today, with the only genuine per-provider differences
being auth header shape, URL construction, response shape parsing, and
cursor format. The **Sending domain provider adapter (module)**
(ADR-0018) closed exactly this shape — one TypeScript interface, N
concrete adapters at a seam, registry-driven dispatch — and is the
direct precedent for this ADR.

### Writer landscape — paginated integration import path

| Producer                              | Path                                              | Concern                                                  | Per-provider knowledge                                                            |
|---------------------------------------|---------------------------------------------------|----------------------------------------------------------|-----------------------------------------------------------------------------------|
| `startMailchimpImport`                | `integrationImportsMutations.ts:11-65`            | validate topic + check running + insert row + schedule   | `provider: 'mailchimp'`, scheduled target is `processMailchimpPage`               |
| `startStripeImport`                   | `integrationImportsMutations.ts:71-123`           | validate topic + check running + insert row + schedule   | `provider: 'stripe'`, scheduled target is `processStripePage`                     |
| `processMailchimpPage`                | `integrationImports.ts:49-240` (192 LOC)          | fetch + retry + parse + normalize + importBatch + sched  | Basic auth, datacenter URL, `members[]/total_items`, numeric `offset` cursor      |
| `processStripePage`                   | `integrationImports.ts:246-443` (198 LOC)         | fetch + retry + parse + normalize + importBatch + sched  | Bearer auth, fixed URL, `data[]/has_more`, string `starting_after` cursor         |
| `cancelImport`                        | `integrationImportsMutations.ts:154-176`          | terminal `status: 'failed'` patch by user                | none                                                                              |
| `updateImportProgress`                | `integrationImportsMutations.ts:182-209`          | per-page counter accumulation + cursor patch             | none — already provider-agnostic                                                  |
| `completeImport`                      | `integrationImportsMutations.ts:215-235`          | terminal `status` patch + error append                   | none — already provider-agnostic                                                  |

Two producers per page processor; two producers per start mutation;
two of three internal mutations already provider-agnostic. The pattern
is structurally a candidate for the `providerFor(kind)` registry
dispatch shape ADR-0018 introduced. Six distinct drift signals follow.

### 1. Duplicated retry / backoff plumbing

```ts
// integrationImports.ts:86-140 (Mailchimp) and :269-313 (Stripe)
const maxRetries = 2;
let retries = 0;
let response: Response | null = null;
while (retries <= maxRetries) {
  try {
    response = await fetch(/* per-provider URL + headers */);
    if (response.ok) break;
    if (response.status === 429 && retries < maxRetries) {
      retries++;
      await new Promise((r) => setTimeout(r, 1000 * retries));
      continue;
    }
    // non-retryable: per-provider error parse
    /* ... ~25 LOC of mostly identical code per provider ... */
    return;
  } catch {
    if (retries < maxRetries) { retries++; /* ... */ continue; }
    /* ... terminal failure mutation call ... */
    return;
  }
}
```

Two near-identical retry blocks, ~55 LOC each. Adding a third provider
copies the block a third time. Same drift signature as the
provider-dispatch inlining ADR-0018 closed (the `if (providerType ===
'mta') { ... } else { ... }` open-coded thrice in `domains.ts`).

### 2. Duplicated start-mutation block

```ts
// integrationImportsMutations.ts:11-65 (Mailchimp) and :71-123 (Stripe)
export const startXImport = mutation({
  args: { /* provider-specific config + handleDuplicates + topicId? */ },
  handler: async (ctx, args) => {
    await getMutationContext(ctx);
    if (args.topicId) {
      const list = await ctx.db.get(args.topicId);
      if (!list) throwInvalidInput('Topic not found');
    }
    const existing = await ctx.db
      .query('integrationImports')
      .withIndex('by_status', (q) => q.eq('status', 'running'))
      .first();
    if (existing) throwInvalidState('An import is already running');
    const importId = await ctx.db.insert('integrationImports', {
      provider: '<provider>',  /* per-provider literal */
      status: 'running',
      cursor: '<initial>',     /* per-provider sentinel: '0' vs '' */
      imported: 0, updated: 0, skipped: 0, failed: 0,
      errors: [],
      handleDuplicates: args.handleDuplicates,
      topicId: args.topicId,
      startedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.integrationImports.processXPage, {
      importId,
      /* per-provider initial args */
    });
    return importId;
  },
});
```

Two mutations, ~55 LOC each, with three real differences: the
`provider` literal, the initial cursor sentinel (`'0'` vs `''`), and
the scheduled action target. The validate-topic / check-running /
insert-row block is byte-identical. A future provider's mutation
silently relies on the convention of including these checks; under the
walker the check lives once, behind the only public start entry.

### 3. Diverging per-provider error-message extraction

```ts
// integrationImports.ts:112-119 (Mailchimp)
const errorText = await response.text();
let errorMessage = `Mailchimp API error: ${response.status}`;
try {
  const errorJson = JSON.parse(errorText);
  errorMessage = errorJson.detail || errorJson.title || errorMessage;
} catch { /* Non-JSON error response */ }

// integrationImports.ts:292-293 (Stripe)
const errorData = await response.json();
const errorMessage = errorData?.error?.message || `Stripe API error: ${response.status}`;
```

Two providers, two error-parse paths. Mailchimp's path is
defensive-parse with try/catch; Stripe's path assumes JSON. The walker
catches a thrown `Error` from the adapter uniformly — the adapter's
`fetchPage` throws with the meaningful message already extracted.
Provider-specific knowledge ("Mailchimp uses `detail`; Stripe uses
`error.message`") moves behind the adapter seam.

### 4. Stringly-typed per-provider config in scheduler args

The two `processXPage` actions declare different arg shapes
(`apiKey + listId + offset` vs `apiKey + startingAfter`). Convex args
validation is per-action, so the type system has no way to express
"this set of args is for `provider: 'mailchimp'`, that set is for
`provider: 'stripe'`." A future provider's action could declare any
arg shape and the rest of the codebase would have to keep up by
convention. Same drift signature as the stringly-typed `step: v.string()`
in `deleteOrgBatch` that ADR-0025 closed by introducing
`tableValidator` against a literal union.

The walker's `processIntegrationPage` action takes one discriminated
`IntegrationProviderConfig` arg validated as a `v.union` over per-provider
shapes. Adding a third provider extends the union by one branch.

### 5. Latent silent-skip risk on the no-import-running check

The "no other import is running" check exists in `startMailchimpImport`
and `startStripeImport` by convention, not by enforcement. A future
provider's start mutation that omits the check would silently allow
concurrent imports — the schema doesn't prevent multiple `'running'`
rows, and the `processXPage` actions don't refuse to run when a sibling
import is in flight. The walker's single `startIntegrationImport`
mutation enforces the check once at the only entry point that creates
`integrationImports` rows.

### 6. Zero integration-test coverage

The 50+ `__tests__/*.integration.test.ts` files in the codebase cover
every other deepened module-family (Contact import, Send completion,
DOI lifecycle, Sending domain lifecycle, etc.). There is no
`integrationImports.integration.test.ts`. The only way to exercise the
two `processXPage` actions today is end-to-end through the public
HTTP fetch against the live Mailchimp / Stripe APIs. Per LANGUAGE.md's
"the interface is the test surface" principle: there is no interface
to test, because the orchestration is fused with the HTTP I/O. Under
the walker + adapter split, the adapter's `fetchPage` is unit-testable
against a stub HTTP and the walker is testable against stub adapters.

### 7. CONTEXT.md vocabulary gap (closed inline)

Pre-this-ADR, CONTEXT.md mentions `integrationImports.ts` "adapters"
informally in the **Contact import (module)** entry (under the
"Three thin shells" list), but does not define the adapter shape as a
typed module. The deepening introduces three terms — **Integration
import**, **Integration import provider adapter (module)**,
**Integration import walker** — added in a new `## Integration imports`
section between `## Contacts` and `## Topics`. Plus one new
Relationships entry documenting the walker / adapter / Contact import
chain, and two reference updates in the existing Contact import (module)
entry. Landed inline alongside this ADR.

### Shared framing

Per LANGUAGE.md's deletion test: deleting `integrationImports.ts` (the
443-LOC `'use node'` file) replays its two page-processor actions into
the walker — and the duplicated retry / pagination / normalize / dispatch
plumbing concentrates at the walker, while the per-provider HTTP /
response-shape knowledge concentrates at the adapter modules. Two
adapters means a real seam (per LANGUAGE.md's "two adapters = real
seam" rule). Adding a third provider becomes a one-folder change
instead of a ~200-LOC copy-paste.

**The interface is the test surface** — pre-deepening, the
`processMailchimpPage` action's only test surface is end-to-end through
the live Mailchimp API. Post-deepening, the adapter's `fetchPage` is
unit-testable against a stub HTTP fetcher; the walker is unit-testable
against stub adapters returning canned page sequences; integration tests
exercise the public `startIntegrationImport` entry with adapters wired
to fixture HTTP responses.

Confidence: high. Pattern mirrors ADR-0018 (Sending domain provider
adapter — same `providerFor(kind)` registry shape, same `satisfies`
compile-time check, same one-folder-per-provider layout) and ADR-0005
(Channel inbound adapter — same "typed interface, two adapters,
registry-driven dispatch" shape on a different concern). No new
architectural ground; the deepening's value is in the substance
corrections (deduplicated orchestration + unified start mutation +
typed config args) and the consistent layout under
`convex/integrationImports/`.

## Decision

One new module-family at `convex/integrationImports/`, two top-level
files deleted, two per-provider adapters introduced, one walker
action + one unified start mutation replacing the four per-provider
producers.

- **`convex/integrationImports/_common.ts`** — shared types: the
  `IntegrationProviderKind` literal union, the
  `IntegrationProviderConfig` discriminated union, the `ImportRow`
  shape (re-exported from `contacts/import.ts`), the
  `RetryableProviderError` class, the
  `IntegrationImportProviderModule<K>` interface definition, and the
  `AttestSource` type for `defaultDoiAttest`.
- **`convex/integrationImports/providers/<kind>/index.ts`** — one per
  provider (`mailchimp/`, `stripe/`). Exports the adapter satisfying
  `IntegrationImportProviderModule<K>`. Owns provider-specific HTTP
  fetch, response parsing, page normalization, and the per-provider
  `defaultDoiAttest` constant.
- **`convex/integrationImports/providers/index.ts`** — registry and
  dispatch (`INTEGRATION_IMPORT_PROVIDERS`, `providerFor(kind)`,
  `isIntegrationProviderKind`). Compile-time `satisfies` guard.
- **`convex/integrationImports/walker.ts`** — the **Integration import
  walker**. Owns the two entry points (`startIntegrationImport`
  public mutation; `processIntegrationPage` internal action) plus the
  three internal mutations relocated from
  `integrationImportsMutations.ts` (`updateImportProgress`,
  `completeImport`, `getImportById`). Also owns the public
  `cancelImport` mutation and the public `getImportProgress` query
  (relocated as-is).

The two top-level files `integrationImports.ts` and
`integrationImportsMutations.ts` are deleted outright. Their public
surface (`startMailchimpImport`, `startStripeImport`, `cancelImport`,
`getImportProgress`) shrinks to `startIntegrationImport`,
`cancelImport`, `getImportProgress`, all under the new
`api.integrationImports.walker.*` surface. The frontend updates one
file (`IntegrationImportModal.vue`, four call sites).

### Adapter interface

```ts
// convex/integrationImports/_common.ts

import type { Id } from '../_generated/dataModel';
import type { ImportRow } from '../contacts/import';

export const INTEGRATION_PROVIDER_KINDS = ['mailchimp', 'stripe'] as const;
export type IntegrationProviderKind = (typeof INTEGRATION_PROVIDER_KINDS)[number];

export type IntegrationProviderConfig =
  | { provider: 'mailchimp'; apiKey: string; listId: string }
  | { provider: 'stripe';    apiKey: string };

/** Thrown by `fetchPage` to signal "retry me up to N more times." */
export class RetryableProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableProviderError';
  }
}

export type FetchPageResult = {
  rows: ImportRow[];          // already-normalized; ready for importBatch
  nextCursor: string | null;  // null = terminal page; '' is reserved for "first page"
  totalEstimate?: number;     // only when the provider gives one (Mailchimp does, Stripe doesn't)
};

export interface IntegrationImportProviderModule<K extends IntegrationProviderKind> {
  readonly kind: K;

  /** Per-provider default DOI attestation; threaded into Contact import (module)'s
   *  importBatch as `doiAttest: { attestSource: defaultDoiAttest }`. */
  readonly defaultDoiAttest?: string;

  /** Pure check of config shape (no I/O). Walker calls at startIntegrationImport
   *  time before scheduling the first page. */
  validateConfig(
    config: Extract<IntegrationProviderConfig, { provider: K }>,
  ): { ok: true } | { ok: false; reason: string };

  /** Provider API call. Cursor is opaque; adapter interprets internally.
   *  '' = first page sentinel.
   *  Throws `RetryableProviderError` on 429 / network blip (walker retries
   *  with backoff up to maxRetries).
   *  Throws regular `Error` on fatal (walker marks the import `failed`
   *  immediately, no retry). */
  fetchPage(args: {
    config: Extract<IntegrationProviderConfig, { provider: K }>;
    cursor: string;
  }): Promise<FetchPageResult>;
}
```

### Provider adapter — Mailchimp example

```ts
// convex/integrationImports/providers/mailchimp/index.ts
'use node';

import {
  IntegrationImportProviderModule,
  RetryableProviderError,
  type FetchPageResult,
} from '../../_common';

const PAGE_SIZE = 100;

export const mailchimpProvider: IntegrationImportProviderModule<'mailchimp'> = {
  kind: 'mailchimp',
  defaultDoiAttest: 'mailchimp',

  validateConfig(config) {
    const datacenter = config.apiKey.split('-').pop();
    if (!datacenter || !/^[a-z]{2}\d+$/.test(datacenter)) {
      return {
        ok: false,
        reason: 'Invalid Mailchimp API key format. Expected: apikey-datacenter (e.g., abc123-us21)',
      };
    }
    if (!config.listId) {
      return { ok: false, reason: 'Mailchimp listId is required' };
    }
    return { ok: true };
  },

  async fetchPage({ config, cursor }) {
    const offset = cursor === '' ? 0 : parseInt(cursor, 10);
    const datacenter = config.apiKey.split('-').pop()!;
    const url = `https://${datacenter}.api.mailchimp.com/3.0/lists/${config.listId}/members`
      + `?count=${PAGE_SIZE}&offset=${offset}`
      + `&fields=members.email_address,members.status,members.merge_fields,total_items`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${Buffer.from(`anystring:${config.apiKey}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 429) {
      throw new RetryableProviderError('Mailchimp rate limit (429)');
    }
    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `Mailchimp API error: ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.detail || errorJson.title || errorMessage;
      } catch { /* non-JSON */ }
      throw new Error(errorMessage);
    }

    const data = await response.json() as {
      members: Array<{
        email_address: string;
        status: string;
        merge_fields?: { FNAME?: string; LNAME?: string; [k: string]: string | undefined };
      }>;
      total_items: number;
    };

    const rows = data.members
      .filter((m) => m.status === 'subscribed')
      .map((m) => {
        const mergeFields = m.merge_fields ?? {};
        const properties: Record<string, string | number | boolean | null> = {};
        for (const [key, value] of Object.entries(mergeFields)) {
          if (key === 'FNAME' || key === 'LNAME') continue;
          if (value === undefined || value === null || value === '') continue;
          properties[key] = value;
        }
        return {
          email: m.email_address.toLowerCase(),
          firstName: mergeFields.FNAME,
          lastName: mergeFields.LNAME,
          ...(Object.keys(properties).length > 0 ? { properties } : {}),
        };
      });

    const nextOffset = offset + PAGE_SIZE;
    const nextCursor: string | null =
      data.members.length === PAGE_SIZE ? String(nextOffset) : null;

    return { rows, nextCursor, totalEstimate: data.total_items };
  },
};
```

The Stripe adapter follows the same shape with `Bearer` auth, the
`starting_after` cursor, and `data[]/has_more` parsing. Both adapters
sit in `'use node'` files because the existing `processXPage` actions
already do — `fetch` and `Buffer` are Node-only in Convex.

### Provider registry

```ts
// convex/integrationImports/providers/index.ts

import { mailchimpProvider } from './mailchimp';
import { stripeProvider } from './stripe';
import type {
  IntegrationImportProviderModule,
  IntegrationProviderKind,
} from '../_common';

export const INTEGRATION_IMPORT_PROVIDERS = {
  mailchimp: mailchimpProvider,
  stripe: stripeProvider,
} as const;

const _typecheck: Record<
  IntegrationProviderKind,
  IntegrationImportProviderModule<IntegrationProviderKind>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
> = INTEGRATION_IMPORT_PROVIDERS as any;
void _typecheck;

export function providerFor<K extends IntegrationProviderKind>(
  kind: K,
): IntegrationImportProviderModule<K> {
  const mod = INTEGRATION_IMPORT_PROVIDERS[kind];
  if (!mod) {
    throw new Error(`Unknown integration import provider: ${kind}`);
  }
  return mod as unknown as IntegrationImportProviderModule<K>;
}

export function isIntegrationProviderKind(
  kind: string | undefined | null,
): kind is IntegrationProviderKind {
  return kind === 'mailchimp' || kind === 'stripe';
}
```

### Walker shape

```ts
// convex/integrationImports/walker.ts
'use node';

import { v } from 'convex/values';
import { internalAction, mutation, internalMutation, internalQuery, query } from '../_generated/server';
import { internal } from '../_generated/api';
import {
  getMutationContext,
  hasPermission,
  requirePermission,
} from '../lib/sessionOrganization';
import {
  throwInvalidInput,
  throwInvalidState,
  throwNotFound,
} from '../_utils/errors';
import { providerFor } from './providers';
import {
  RetryableProviderError,
  type IntegrationProviderConfig,
} from './_common';

const MAX_RETRIES = 2;

const integrationProviderConfigValidator = v.union(
  v.object({
    provider: v.literal('mailchimp'),
    apiKey: v.string(),
    listId: v.string(),
  }),
  v.object({
    provider: v.literal('stripe'),
    apiKey: v.string(),
  }),
);

export const startIntegrationImport = mutation({
  args: {
    config: integrationProviderConfigValidator,
    handleDuplicates: v.union(v.literal('skip'), v.literal('update')),
    topicId: v.optional(v.id('topics')),
  },
  handler: async (ctx, args) => {
    const session = await getMutationContext(ctx);
    requirePermission(
      hasPermission(session.role, 'imports:manage'),
      'Only owners and admins can start imports',
    );

    const adapter = providerFor(args.config.provider);
    const configCheck = adapter.validateConfig(args.config as never);
    if (!configCheck.ok) throwInvalidInput(configCheck.reason);

    if (args.topicId) {
      const topic = await ctx.db.get(args.topicId);
      if (!topic) throwInvalidInput('Topic not found');
    }

    const running = await ctx.db
      .query('integrationImports')
      .withIndex('by_status', (q) => q.eq('status', 'running'))
      .first();
    if (running) throwInvalidState('An import is already running');

    const importId = await ctx.db.insert('integrationImports', {
      provider: args.config.provider,
      status: 'running',
      cursor: '',
      imported: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      handleDuplicates: args.handleDuplicates,
      topicId: args.topicId,
      startedAt: Date.now(),
    });

    await ctx.scheduler.runAfter(0, internal.integrationImports.walker.processIntegrationPage, {
      importId,
      config: args.config,
      cursor: '',
    });

    return importId;
  },
});

export const processIntegrationPage = internalAction({
  args: {
    importId: v.id('integrationImports'),
    config: integrationProviderConfigValidator,
    cursor: v.string(),
  },
  handler: async (ctx, args) => {
    // Status check — cancellation by the public cancelImport mutation
    // patches `status: 'failed'`; we short-circuit before any HTTP.
    const importRecord = await ctx.runQuery(
      internal.integrationImports.walker.getImportById,
      { importId: args.importId },
    );
    if (!importRecord || importRecord.status !== 'running') return;

    const adapter = providerFor(args.config.provider);

    // Retry loop — RetryableProviderError → backoff + retry; any other Error → fail.
    let result: Awaited<ReturnType<typeof adapter.fetchPage>> | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        result = await adapter.fetchPage({ config: args.config as never, cursor: args.cursor });
        break;
      } catch (err) {
        if (err instanceof RetryableProviderError && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        await ctx.runMutation(internal.integrationImports.walker.completeImport, {
          importId: args.importId,
          status: 'failed',
          errorMessage: err instanceof Error ? err.message : 'Unknown error',
        });
        return;
      }
    }
    if (!result) return;

    // Delegate to Contact import (module). ADR-0019.
    let batchImported = 0, batchUpdated = 0, batchSkipped = 0, batchFailed = 0;
    const batchErrors: string[] = [];
    if (result.rows.length > 0) {
      try {
        const batchResults = await ctx.runMutation(internal.contacts.import.importBatch, {
          rows: result.rows,
          source: args.config.provider,
          handleDuplicates: importRecord.handleDuplicates,
          ...(importRecord.topicId
            ? { topicAssignments: { kind: 'single' as const, topicId: importRecord.topicId } }
            : {}),
          ...(adapter.defaultDoiAttest
            ? { doiAttest: { attestSource: adapter.defaultDoiAttest } }
            : {}),
        });
        batchImported = batchResults.imported;
        batchUpdated = batchResults.updated;
        batchSkipped = batchResults.skipped;
        batchFailed = batchResults.failed;
        batchErrors.push(...batchResults.errors.slice(0, 10));
      } catch (error) {
        batchFailed = result.rows.length;
        batchErrors.push(
          `Batch at cursor "${args.cursor}" failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }

    await ctx.runMutation(internal.integrationImports.walker.updateImportProgress, {
      importId: args.importId,
      imported: batchImported,
      updated: batchUpdated,
      skipped: batchSkipped,
      failed: batchFailed,
      errors: batchErrors,
      ...(result.totalEstimate !== undefined ? { totalEstimate: result.totalEstimate } : {}),
      newCursor: result.nextCursor ?? args.cursor,
    });

    if (result.nextCursor !== null) {
      await ctx.scheduler.runAfter(0, internal.integrationImports.walker.processIntegrationPage, {
        importId: args.importId,
        config: args.config,
        cursor: result.nextCursor,
      });
    } else {
      await ctx.runMutation(internal.integrationImports.walker.completeImport, {
        importId: args.importId,
        status: 'completed',
      });
    }
  },
});

// updateImportProgress, completeImport, getImportById, cancelImport,
// getImportProgress all relocated as-is from integrationImportsMutations.ts
// (no behavior change). See file body in implementation.
```

### Replaces

| File:line                                                                 | Pre-deepening                                                  | Post-deepening                                                                                              |
|---------------------------------------------------------------------------|----------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------|
| `convex/integrationImports.ts` (443 LOC)                                  | `processMailchimpPage` + `processStripePage` actions           | Deleted — one `processIntegrationPage` (~120 LOC) in `walker.ts` + two adapters (~80 LOC each)              |
| `convex/integrationImportsMutations.ts` (248 LOC)                         | `startMailchimpImport` + `startStripeImport` + three internals | Deleted — `startIntegrationImport` + relocated internals in `walker.ts`                                     |
| `integrationImports.ts:49-240` `processMailchimpPage` (192 LOC)           | provider-specific orchestration                                | `providers/mailchimp/index.ts:fetchPage` (~80 LOC, HTTP + parse + normalize only)                           |
| `integrationImports.ts:246-443` `processStripePage` (198 LOC)             | provider-specific orchestration                                | `providers/stripe/index.ts:fetchPage` (~70 LOC, HTTP + parse + normalize only)                              |
| `integrationImportsMutations.ts:11-65` `startMailchimpImport` (55 LOC)    | provider-specific start                                        | Caller migrates to `startIntegrationImport({ config: { provider: 'mailchimp', ... } })`                     |
| `integrationImportsMutations.ts:71-123` `startStripeImport` (53 LOC)      | provider-specific start                                        | Caller migrates to `startIntegrationImport({ config: { provider: 'stripe', ... } })`                        |

### Closes drift bugs

1. **Duplicated retry / pagination plumbing** — ~100 LOC × 2 collapses
   to one retry loop in the walker (~30 LOC). Per-provider knowledge
   ("Mailchimp uses offset, Stripe uses starting_after") lives in
   `fetchPage` (drift #1).
2. **Duplicated start-mutation block** — validate-topic + check-running
   + insert-row + schedule-first-page lives once at
   `startIntegrationImport`. A future provider's mutation cannot skip
   the no-running check (drift #2).
3. **Diverging per-provider error-message extraction** — Mailchimp's
   `detail`/`title` parse and Stripe's `error.message` parse both
   move behind `fetchPage`. Walker treats thrown messages uniformly
   (drift #3).
4. **Stringly-typed scheduler args** — `processIntegrationPage`'s
   `config` arg is a Convex-validated `v.union` over per-provider
   shapes. Adding a third provider extends the union by one branch;
   any caller drifting from the typed shape is a compile error
   (drift #4).
5. **Latent silent-skip risk on no-running check** — closed by drift
   #2 above. The check exists exactly once, behind the only public
   entry that inserts `integrationImports` rows (drift #5).
6. **Zero integration-test coverage** — the per-module adapter +
   walker split makes a real interface to test (see Tests section
   below). Net new coverage where there was none (drift #6).
7. **CONTEXT.md vocabulary gap** — added in this ADR alongside the
   existing **Sending domain provider adapter (module)** and
   **Channel inbound adapter** patterns (drift #7).

### Caller migration

Mechanical change across one frontend file plus the deleted top-level
backend files:

| Old surface                                              | New surface                                                                                       | Sites                                                                |
|----------------------------------------------------------|---------------------------------------------------------------------------------------------------|----------------------------------------------------------------------|
| `api.integrationImportsMutations.startMailchimpImport`   | `api.integrationImports.walker.startIntegrationImport` with `config: { provider: 'mailchimp', … }` | 1 frontend (`IntegrationImportModal.vue:176`)                        |
| `api.integrationImportsMutations.startStripeImport`      | `api.integrationImports.walker.startIntegrationImport` with `config: { provider: 'stripe', … }`    | 1 frontend (`IntegrationImportModal.vue:183`)                        |
| `api.integrationImportsMutations.cancelImport`           | `api.integrationImports.walker.cancelImport`                                                      | 1 frontend (`IntegrationImportModal.vue:201`)                        |
| `api.integrationImportsMutations.getImportProgress`      | `api.integrationImports.walker.getImportProgress`                                                 | 1 frontend (`IntegrationImportModal.vue:31`)                         |
| `internal.integrationImports.processMailchimpPage`       | `internal.integrationImports.walker.processIntegrationPage`                                       | 0 callers outside the deleted files (self-rescheduled)               |
| `internal.integrationImports.processStripePage`          | `internal.integrationImports.walker.processIntegrationPage`                                       | 0 callers outside the deleted files (self-rescheduled)               |
| `internal.integrationImportsMutations.updateImportProgress` / `completeImport` / `getImportById` | `internal.integrationImports.walker.*`                                  | 0 frontend callers; internal to walker                               |

No backend internal-caller changes outside the new walker file. The
frontend modal is the only consumer of the public surface.

### Tests

The deepening produces three new test surfaces where there were zero:

1. **Per-adapter unit tests** at
   `integrationImports/providers/__tests__/mailchimp.test.ts` and
   `stripe.test.ts`. Stub `fetch` to return canned page responses.
   Assert per-page:
   - Valid config passes `validateConfig`; malformed datacenter / missing
     listId / missing apiKey fail with typed reason strings.
   - `fetchPage` returns normalized `rows` with expected shape (the
     `properties` blob excludes name fields and empty values; lowercase
     email).
   - 429 response → `RetryableProviderError`; 500 with parseable error
     → `Error` with extracted message; network throw → `Error`.
   - Terminal page (response smaller than `PAGE_SIZE` for Mailchimp;
     `has_more: false` for Stripe) returns `nextCursor: null`.
2. **Walker dispatch test** at
   `integrationImports/__tests__/walker.test.ts`. Stub the registry
   with a fake adapter producing a 3-page sequence ending in `nextCursor:
   null`. Assert:
   - `startIntegrationImport` enforces the no-running gate (second call
     while a first is `'running'` throws).
   - `startIntegrationImport` calls `validateConfig` and rejects on
     `{ ok: false }`.
   - `processIntegrationPage` short-circuits when `importRecord.status !==
     'running'` (cancellation race).
   - `processIntegrationPage` retries on `RetryableProviderError` up to
     `MAX_RETRIES`, then fails. Non-retryable `Error` fails immediately.
   - Terminal page triggers `completeImport({ status: 'completed' })`;
     non-terminal page schedules the next hop with the adapter's
     `nextCursor`.
3. **Integration test** at
   `__tests__/integrationImports.integration.test.ts`. Drive
   `startIntegrationImport` end-to-end with stub adapters wired via
   the registry. Assert:
   - One full Mailchimp-shape import inserts contacts via
     `importBatch`, populates `imported` / `updated` counters, ends in
     `'completed'`.
   - `cancelImport` mid-import halts the next scheduled hop.
   - `defaultDoiAttest` threads through to `importBatch` (assertable
     via stubbed `contacts.import.importBatch` capturing args).

Net new test coverage where there was effectively none.

## Consequences

**Closes the integration-imports candidate from ADR-0025's "surviving
switch-where-walker-belongs" follow-up list.** After this lands,
`integrationImports.ts` and `integrationImportsMutations.ts` are
deleted; the only surviving switches-where-walkers-might-belong are
the chat / agent surfaces, which the architecture review confirmed are
already typed-dispatch-driven (ADR-0014's Agent walker pattern), and
the `visualizationAgent.ts` CRUD file (not actually a switch, just
a single-shot LLM action).

**Surface area:** ~691 LOC of pre-deepening file deletes. New files:
`_common.ts` (~70 LOC), `providers/mailchimp/index.ts` (~80 LOC),
`providers/stripe/index.ts` (~70 LOC), `providers/index.ts` (~30 LOC),
`walker.ts` (~250 LOC). Total new: ~500 LOC. Net production-code LOC:
~-190. Plus new test surface (~250-300 LOC) where coverage was zero.

**One re-tightened invariant:** the `integrationImports` row has
exactly *one* writer module (the **Integration import walker**) and
*one* reader of provider variation (the **Integration import provider
adapter (module)** family). Per-provider HTTP knowledge cannot leak
into the walker; per-walker orchestration concerns cannot leak into
adapters. Future writers of new providers choose: add an adapter under
`providers/<kind>/` and one registry entry. They do not append to a
shared catch-all file.

**Migration:** one PR. Schema unchanged (`integrationImports` table
shape is provider-agnostic already). No data backfill. Cutover:
1. New module files added with full bodies (adapters + walker).
2. Old files deleted (`integrationImports.ts`,
   `integrationImportsMutations.ts`).
3. `_generated/api.d.ts` regenerates automatically.
4. Frontend `IntegrationImportModal.vue` updated to call
   `startIntegrationImport` with the discriminated config arg (four
   call sites).
5. New unit + integration tests land in the same PR.

No risk to in-flight imports: an `integrationImports` row at
`'running'` when this PR deploys will have its next scheduled
`processMailchimpPage` / `processStripePage` invocation arrive at a
deleted action. Mitigation: include a one-shot
`migrations/2026XX_drainInflightImports.ts` that patches every
`'running'` row to `'failed'` with `errorMessage: 'Migration to
integration-import walker; please retry.'`. The frontend already
surfaces per-row error messages, so the operator sees the message
and re-starts the import under the new surface. The drain is
idempotent and runs at migration time only.

**Out of scope for follow-up:** adding a third integration provider
(Klaviyo, HubSpot, Brevo). The deepening's surface is designed so
the addition is a one-folder change post-landing, but the providers
themselves are out of this ADR's scope and tracked separately.

**Out of scope for follow-up:** unifying the `contacts/import.ts`
batch-import path with the integration-walker path. The two share
the **Contact import (module)** behind both, but the front halves are
genuinely different: CSV / API imports take inline `rows[]` payloads
and skip pagination + retries entirely. The current split (Contact
import owns the row-loop; Integration import walker owns the page-
loop) names the asymmetry honestly.

**Out of scope for follow-up:** the Lifecycle factor question
(CONTEXT.md flags this as "active design but not landed" across
ten lifecycle modules). This ADR is *not* a lifecycle module (no
status column with a `LEGAL_EDGES` graph — the
`integrationImports.status` field has only three terminal-ish values
and no inter-state transitions worth a reducer) and does not bear
on that question.
