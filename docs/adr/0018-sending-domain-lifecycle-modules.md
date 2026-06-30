# Sending domain lifecycle module + per-provider Sending domain provider adapter modules

**Status:** proposed

## Context

`domains.status` together with the row's DNS records, verification
results, and provider-specific identity fields form the state surface of
a Sending domain. The row has **three writers** spread across two files,
each varying in what status it sets and what subset of the five
provider-specific columns it patches. Two separate inline
`if (providerType === 'mta')` switches dispatch the provider register
and delete actions. The "what counts as verified" rule is computed in
the DNS verifier with one inline `providerType !== 'ses' || ...` branch
on per-provider knowledge.

The friction is small in LOC (~120 LOC across writers + dispatchers) but
**three architectural shapes are missing at the same time**: the
lifecycle module, the per-provider adapter module, and the per-provider
sibling identity table. Sending domain is the only top-level row in the
codebase with a multi-state machine that has no lifecycle module — Send,
Postbox, DOI, Inbox, Abuse, Campaign, and AB test all do. It's also one
of two places (alongside ADR-0005's Channel inbound adapters) where the
"two adapters, real seam" rule applies but the seam isn't named.

### Writer landscape — `domains.status`

| Producer | Path | Transition | Companion fields | Provider-specific fields touched |
|---|---|---|---|---|
| Create | `domains/domains.ts:139` | `(insert) → registering` | `dnsRecords: {}`, `providerType`, `updatedAt`, `createdAt` | none |
| Regenerate | `domains/domains.ts:205` | `failed \| verified → registering` | `dnsRecords: {}`, `verificationResults: undefined`, `verifiedAt: undefined`, `providerType`, `updatedAt` | clears all 5: `registrationError`, `mtaDkimSelector`, `sesDkimTokens`, `sesVerificationToken`, `sesVerificationStatus`, `sesRegistrationError` |
| Verify | `domains/dnsVerificationQueries.ts:52` (`updateVerificationStatus`) | `pending → verified \| failed \| pending` | `verificationResults`, `lastVerifiedAt`, `verifiedAt` (only on first verify) | none |
| Register (SES) | `domains/dnsVerificationQueries.ts:72` (`updateDomainAfterSESRegistration`) | `registering → pending \| failed` | `dnsRecords`, `updatedAt` | `sesDkimTokens`, `sesVerificationToken`, `sesRegistrationError?` |
| Register (MTA or generic) | `domains/dnsVerificationQueries.ts:105` (`updateDomainAfterRegistration`) | `registering → pending \| failed` | `dnsRecords`, `updatedAt` | `mtaDkimSelector?`, `sesDkimTokens?`, `sesVerificationToken?`, `registrationError?`, `sesRegistrationError?` — all optional, all in the same arg shape |

Five status writers (counting the two provider-specific register
completion mutations as siblings of one another). Each mutation
declares a different validator subset for the provider-specific
columns; nothing on the schema side enforces that
`mtaDkimSelector` and `sesDkimTokens` cannot coexist on the same row.

### 1. Provider dispatch inlined three times

```ts
// domains.ts:149 (create)
if (providerType === 'mta') {
  await ctx.scheduler.runAfter(0, internal.mtaActions.registerDomainWithMTA, { domainId });
} else {
  await ctx.scheduler.runAfter(0, internal.sesActions.registerDomainWithSES, { domainId });
}

// domains.ts:221 (regenerateDnsRecords) — same shape
// domains.ts:179 (remove)              — same shape with delete actions
```

Three open-coded `if/else` dispatches. Adding a third provider
(Postmark, SendGrid) requires editing all three. The `else` branch
silently routes anything-not-MTA to SES, which is *not safe* — if
`EMAIL_PROVIDER` is set to `'resend'`, this code dispatches the SES
action against a domain that's actually meant for Resend.

### 2. Status decision duplicated between verifier and register completions

`dnsVerification.ts:336` derives the status from DNS results:

```ts
const status = allVerified ? 'verified' : anyFailed ? 'failed' : 'pending';
```

Where `allVerified` includes a provider-specific line:

```ts
&& (providerType !== 'ses' || results.sesStatus === 'Success')
```

The register completions (`updateDomainAfterSESRegistration`,
`updateDomainAfterRegistration`) hard-code their own status decision:
`'pending'` on success, `'failed'` on caught exception. Two writers,
two decision functions, both deciding "what is this domain's status
right now."

### 3. The kitchen-sink `updateDomainAfterRegistration` mutation

`dnsVerificationQueries.ts:84` declares one mutation accepting:

```ts
status: v.union(v.literal('pending'), v.literal('failed')),
providerType: v.optional(v.string()),
mtaDkimSelector: v.optional(v.string()),
sesDkimTokens: v.optional(v.array(v.string())),
sesVerificationToken: v.optional(v.string()),
registrationError: v.optional(v.string()),
sesRegistrationError: v.optional(v.string()),
```

Six optional provider-specific args in one shape. The mutation has
no way to know whether `sesDkimTokens` *should* be present given
`providerType: 'mta'` — the type system says "all optional, in any
combination." The handler then patches whichever subset the caller
provided. The SES register action calls the parallel
`updateDomainAfterSESRegistration` (with non-optional SES args); the
MTA register action calls this generic one with MTA args. The shape is
a leaky envelope masquerading as a typed contract.

### 4. Five provider-specific columns on one row

The `domains` schema (`schema/domains.ts:12-44`) carries:

- `mtaDkimSelector?` (MTA only)
- `sesDkimTokens?` (SES only)
- `sesVerificationToken?` (SES only)
- `sesVerificationStatus?` (SES only — also mirrored into
  `verificationResults.sesStatus` by the verifier; redundant)
- `sesRegistrationError?` (SES only)
- `registrationError?` (provider-agnostic)
- `providerType?` (the discriminator)

Six fields on the row, five provider-specific, no schema-level
constraint that only one provider's fields can be populated.
Pre-deepening, `regenerateDnsRecords` clears all of them in one patch;
that's the only place in the codebase that reads the *full* set of
provider columns at once.

### 5. `domains.create` reads `EMAIL_PROVIDER` from env

```ts
const providerType = (getOptional('EMAIL_PROVIDER') ?? 'mta') as string;
```

The same logic is re-derived in `regenerateDnsRecords:202`. Today this
is acceptable because Owlat self-hosts mean a single deployment has one
configured provider — but the row carries `providerType` as data
(written by create) and the regenerate mutation re-reads env *again*
instead of using the row's value. If a deployment switches providers
between create and regenerate, behavior diverges. Even today, the
per-row `providerType` is the source of truth at deletion time
(`remove:175` reads `domain.providerType ?? 'ses'`) but not at
regenerate time. Drift.

### 6. No audit log on domain transitions

Sending domain has **no** audit-log entries today. Compare with the
five lifecycle modules already deepened (Send, Postbox, DOI, Inbox,
Campaign) — each fires an `audit_log` effect on every transition. The
audit catalog at `auditActions/catalog.ts` has no `sending_domain.*`
literals. A platform admin auditing "who triggered DNS regeneration on
this domain at 2am" finds nothing.

### 7. CONTEXT.md has no Sending domain vocabulary

CONTEXT.md describes Send, Postbox, DOI, Inbox, Abuse, Campaign,
Contact, Topic, Form, Block, Webhook event, Channel inbound, Agent
step, IMAP command, Contact activity — fifteen named seams. Sending
domain is not one. "Domain" is mentioned in the abuse section as a
data attribute on `domainReputation`; the sending-domain table itself
has no entry. A new dev asking "where does adding a sending domain
live?" gets the writer-landscape table above as the answer they need.

### 8. `dnsVerification.verifyDomain` mixes generic and provider logic

`dnsVerification.ts:218-350` (133 LOC) interleaves:

- Pure DNS lookup helpers (`verifyTxtRecord`, `verifyCnameRecord`,
  `verifyMxRecord` — 200 LOC above).
- Generic record-by-record verification loop (DKIM all, DMARC, SPF,
  MAIL FROM).
- A provider-specific branch (`if (providerType === 'ses')`) that
  calls `createSESIdentityManager().getVerificationStatus(...)` and
  writes `results.sesStatus`.
- A provider-aware status derivation
  (`providerType !== 'ses' || results.sesStatus === 'Success'`).
- A direct call into `updateVerificationStatus` to write the result.

The action knows three providers' worth of detail
(MTA omits SPF when `MTA_SPF_INCLUDE` is absent, SES requires the
sesStatus check, etc.) and is also the writer of the resulting status.
Two responsibilities in one place.

### Shared framing

Per LANGUAGE.md's deletion test: deleting the three register/delete
inline dispatches and inlining at call sites reveals the same
`if (providerType === 'mta') / else` pattern three times — deleting
the dispatcher concentrates the smear at the dispatcher's site rather
than spreading it. Deleting the per-provider register-completion
mutations (`updateDomainAfterSESRegistration`,
`updateDomainAfterRegistration`) and inlining their patches into the
actions makes the wide-row provider-columns problem worse, not better
— the actions then directly know the schema layout. The kitchen-sink
mutation is a *symptom* of the missing per-provider table.

Two adapters exist (MTA, SES). Per LANGUAGE.md's "two adapters = real
seam" rule, the seam is real but unnamed. The MTA and SES register
actions duplicate the action shape (load domain, call provider API,
build DNS records, write back) — they should be one shape with two
provider-keyed implementations, the same way ADR-0005 unified Twilio,
Meta, and the generic webhook into one `InboundAdapter` interface.

## Decision

Three new modules and one schema reshape, all under
`apps/api/convex/domains/`:

- **`lifecycle.ts`** — **Sending domain lifecycle (module)** owns
  transitions of `domains.status` plus row creation and removal.
- **`providers/<kind>/index.ts`** — **Sending domain provider adapter
  (module)** per provider (`mta`, `ses`). Owns the per-provider
  identity sibling table, the provider API calls, and the optional
  per-provider verification check.
- **`providers/index.ts`** — Registry dispatching by
  `domains.providerType`.

Plus: two new sibling tables (`sendingDomainMtaIdentities`,
`sendingDomainSesIdentities`), removal of five provider-specific
columns from `domains`, and a `sending_domain.*` action family added
to `auditActions/catalog.ts`.

### Sending domain lifecycle (module) shape

```ts
// apps/api/convex/domains/lifecycle.ts

import { internalMutation } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

export type SendingDomainStatus =
  | 'registering' | 'pending' | 'verified' | 'failed';

export type SendingDomainProviderKind = 'mta' | 'ses';

export type SendingDomainTransitionInput =
  | { to: 'registering' /* from failed | verified (regenerate) */ }
  | { to: 'pending';
      dnsRecords: DnsRecords;
      identity: ProviderIdentity;     // discriminated by `kind` — see adapter
    }
  | { to: 'verified';
      verificationResults: VerificationResults;
    }
  | { to: 'failed';
      /* registering → failed has `error`; pending → failed has `verificationResults` */
      error?: string;
      verificationResults?: VerificationResults;
    };

export type SendingDomainTransitionOutcome =
  | { ok: true; from: SendingDomainStatus; to: SendingDomainStatus; applied: true }
  | { ok: true; from: SendingDomainStatus; to: SendingDomainStatus; applied: false;
      reason: 'duplicate' }
  | { ok: false; reason: 'illegal_edge' | 'domain_not_found' };

// Five entry points
export const create: (ctx, args: { domain: string }) =>
  Promise<{ ok: true; domainId: Id<'domains'> } |
          { ok: false; reason: 'invalid_format' | 'already_exists' }>;

export const transition: (ctx, args: {
  domainId: Id<'domains'>;
  input: SendingDomainTransitionInput;
  source?: 'user' | 'register_complete' | 'verifier' | 'admin';
}) => Promise<SendingDomainTransitionOutcome>;

export const requestVerification: (ctx, args: { domainId: Id<'domains'> }) =>
  Promise<{ ok: true } | { ok: false; reason: 'still_registering' | 'domain_not_found' }>;

export const recordVerification: (ctx, args: {
  domainId: Id<'domains'>;
  verificationResults: VerificationResults;
  providerCheck: { verified: boolean; lastError?: string };
}) => Promise<SendingDomainTransitionOutcome>;

export const remove: (ctx, args: { domainId: Id<'domains'> }) =>
  Promise<{ ok: true } | { ok: false; reason: 'domain_not_found' }>;
```

### Sending domain status — legal edges

```
(insert)    → registering        (create)
registering → pending             (provider register completed)
registering → failed              (provider register failed)
pending     → verified            (all DNS records + provider check pass)
pending     → failed              (some DNS record failed verification)
pending     → pending             (re-verify: some records still missing, none failed — recorded)
verified    → registering         (regenerate)
failed      → registering         (regenerate)
verified    → verified            (re-verify: still all good — recorded, patches results)
failed      → failed              (re-verify: still failing — recorded, patches results)
verified    → failed              (re-verify: was verified, now failing — e.g., DNS changed)
verified    → pending             (re-verify: was verified, now some records missing — e.g., DNS partly removed)
```

No terminal states — every status can be left via regenerate or
re-verify. The `recorded` outcome covers the three self-loops; the
reducer still patches `verificationResults` and `lastVerifiedAt` on
recorded self-loops (the input carries fresh data).

### Sending domain lifecycle effects

```ts
type SendingDomainEffect =
  | {
      kind: 'audit_log';
      action: 'sending_domain.created'
            | 'sending_domain.registered'
            | 'sending_domain.registration_failed'
            | 'sending_domain.verified'
            | 'sending_domain.verification_failed'
            | 'sending_domain.regenerated'
            | 'sending_domain.deleted';
      domainId: Id<'domains'>;
      details?: Record<string, unknown>;
    }
  | {
      kind: 'register_with_provider';
      domainId: Id<'domains'>;
      providerType: SendingDomainProviderKind;
    }
  | {
      kind: 'clear_provider_identity';
      domainId: Id<'domains'>;
      providerType: SendingDomainProviderKind;
    }
  | {
      kind: 'run_dns_verification';
      domainId: Id<'domains'>;
    }
  | {
      kind: 'delete_with_provider';
      domain: string;                          // the domain name string
      providerType: SendingDomainProviderKind;
    };
```

Per-transition effect table:

| Transition / op | `audit_log` | `register_with_provider` | `clear_provider_identity` | `run_dns_verification` | `delete_with_provider` |
|---|---|---|---|---|---|
| `create()` → `registering` | ✅ `sending_domain.created` | ✅ | ❌ | ❌ | ❌ |
| `→ registering` (regenerate from `verified` or `failed`) | ✅ `sending_domain.regenerated` | ✅ | ✅ (only if previous identity row exists) | ❌ | ❌ |
| `registering → pending` | ✅ `sending_domain.registered` | ❌ | ❌ | ❌ | ❌ |
| `registering → failed` | ✅ `sending_domain.registration_failed` | ❌ | ❌ | ❌ | ❌ |
| `pending → verified` (and self-loops to `verified`) | ✅ `sending_domain.verified` (only on edge, not self-loop) | ❌ | ❌ | ❌ | ❌ |
| `pending → failed` (and `verified → failed`) | ✅ `sending_domain.verification_failed` | ❌ | ❌ | ❌ | ❌ |
| `pending → pending` / `failed → failed` self-loop | ❌ (no audit on verification self-loop — would spam) | ❌ | ❌ | ❌ | ❌ |
| `requestVerification()` | ❌ (the audit fires on the resulting transition) | ❌ | ❌ | ✅ | ❌ |
| `remove()` | ✅ `sending_domain.deleted` | ❌ | ❌ | ❌ | ✅ |

### Sending domain companion-field patches

Atomic with the status patch in the reducer:

| Transition / op | Field writes on `domains` | Sibling-table writes |
|---|---|---|
| `create()` | inserts row: `domain`, `status: 'registering'`, `dnsRecords: {}`, `providerType` (from env), `createdAt`, `updatedAt` | — |
| `→ registering` (regenerate) | `dnsRecords: {}`, `verificationResults: undefined`, `verifiedAt: undefined`, `lastVerifiedAt: undefined`, `lastRegistrationError: undefined`, `updatedAt` | adapter's `clearIdentity` deletes the sibling row |
| `registering → pending` | `dnsRecords`, `lastRegistrationError: undefined`, `updatedAt` | adapter's `writeIdentity` inserts sibling row from `input.identity` |
| `registering → failed` | `lastRegistrationError: input.error`, `updatedAt` | — |
| `pending → verified` | `verificationResults`, `lastVerifiedAt: Date.now()`, `verifiedAt: Date.now()` (only on first verify — preserves the "first verified" timestamp), `updatedAt` | — |
| `pending → failed` (verify) | `verificationResults`, `lastVerifiedAt: Date.now()`, `updatedAt` | — |
| `pending → pending` self-loop | `verificationResults`, `lastVerifiedAt: Date.now()`, `updatedAt` | — |
| `verified → verified` / `failed → failed` self-loop | `verificationResults`, `lastVerifiedAt: Date.now()`, `updatedAt` | — |
| `verified → failed` / `verified → pending` | `verificationResults`, `lastVerifiedAt: Date.now()`, `updatedAt` (note: `verifiedAt` is **not** cleared — it preserves the first-verified history) | — |
| `remove()` | row deleted | sibling row deleted via `adapter.clearIdentity` |

The reducer never branches on `providerType`. All provider-specific
sibling-row writes go through the adapter's `writeIdentity` /
`clearIdentity` methods.

### Sending domain provider adapter (module) shape

```ts
// apps/api/convex/domains/providers/types.ts

import type { Id } from '../../_generated/dataModel';
import type { DnsRecords } from '../domains';
import type { MutationCtx } from '../../_generated/server';

export type SendingDomainProviderKind = 'mta' | 'ses';

export type MtaIdentity = {
  kind: 'mta';
  dkimSelector: string;
};

export type SesIdentity = {
  kind: 'ses';
  dkimTokens: readonly string[];
  verificationToken: string;
};

export type ProviderIdentity = MtaIdentity | SesIdentity;

export type ProviderIdentityFor<K extends SendingDomainProviderKind> =
  K extends 'mta' ? MtaIdentity :
  K extends 'ses' ? SesIdentity :
  never;

export interface SendingDomainProviderModule<K extends SendingDomainProviderKind> {
  readonly kind: K;

  // ── Provider API calls (run inside 'use node' actions) ────────────────

  /** Register the domain at the provider; return DNS records to publish
   *  and the identity row to insert. Throws on provider failure — the
   *  effect handler translates the throw to a `→ failed` transition. */
  registerDomain(domain: string): Promise<{
    dnsRecords: DnsRecords;
    identity: ProviderIdentityFor<K>;
  }>;

  /** Best-effort cleanup at the provider's API. Called on `→ registering`
   *  (regenerate, when a previous identity exists) and on `remove()`. */
  deleteFromProvider(domain: string): Promise<void>;

  /** Optional per-provider verification check. Today only SES has one
   *  (live `getVerificationStatus` call). MTA omits this — the lifecycle
   *  treats it as `{ verified: true }`. */
  runProviderCheck?(domain: string): Promise<{ verified: boolean; lastError?: string }>;

  // ── Sibling-row persistence (run inside mutations) ────────────────────

  /** Insert the per-provider sibling row. Called from the lifecycle
   *  reducer on `registering → pending`. */
  writeIdentity(
    ctx: MutationCtx,
    domainId: Id<'domains'>,
    identity: ProviderIdentityFor<K>,
  ): Promise<void>;

  /** Load the per-provider sibling row by `domainId`. Returns null when
   *  no identity exists (e.g., still in `registering` or after
   *  `clearIdentity`). */
  loadIdentity(
    ctx: MutationCtx,
    domainId: Id<'domains'>,
  ): Promise<ProviderIdentityFor<K> | null>;

  /** Delete the per-provider sibling row. Called from the lifecycle
   *  reducer on `→ registering` (regenerate) and `remove()`. */
  clearIdentity(
    ctx: MutationCtx,
    domainId: Id<'domains'>,
  ): Promise<void>;
}
```

### Registry

```ts
// apps/api/convex/domains/providers/index.ts

import { mtaProvider } from './mta';
import { sesProvider } from './ses';
import type { SendingDomainProviderKind, SendingDomainProviderModule } from './types';

export const SENDING_DOMAIN_PROVIDERS = {
  mta: mtaProvider,
  ses: sesProvider,
} as const satisfies Record<SendingDomainProviderKind, SendingDomainProviderModule<SendingDomainProviderKind>>;

export function providerFor<K extends SendingDomainProviderKind>(
  kind: K,
): SendingDomainProviderModule<K> {
  const mod = SENDING_DOMAIN_PROVIDERS[kind];
  if (!mod) {
    throw new Error(`Unknown sending domain provider: ${kind}`);
  }
  return mod as unknown as SendingDomainProviderModule<K>;
}

export type { SendingDomainProviderKind, SendingDomainProviderModule, ProviderIdentity, ProviderIdentityFor, MtaIdentity, SesIdentity } from './types';
```

Adding a third provider: one new folder under `providers/`, one new
sibling table in `schema/domains.ts`, one new entry in
`SENDING_DOMAIN_PROVIDERS`. The compile-time `satisfies` check on the
registry catches missing methods. No edit to the lifecycle.

### Sibling table shape

```ts
// schema/domains.ts (additions)

sendingDomainMtaIdentities: defineTable({
  domainId: v.id('domains'),
  dkimSelector: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_domain', ['domainId']),  // 1:0..1 invariant enforced by adapter

sendingDomainSesIdentities: defineTable({
  domainId: v.id('domains'),
  dkimTokens: v.array(v.string()),
  verificationToken: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_domain', ['domainId']),
```

The 1:0..1 invariant (at most one identity row per domain in one
provider's table) is application-enforced by the adapter's
`writeIdentity`: if an identity row already exists for the domain,
patch it; otherwise insert. Same discipline as **Contact identity**'s
application-enforced `(channel, identifier)` uniqueness.

### `domains` table reshape

The `domains` table loses:

- `mtaDkimSelector` — moves to `sendingDomainMtaIdentities.dkimSelector`
- `sesDkimTokens` — moves to `sendingDomainSesIdentities.dkimTokens`
- `sesVerificationToken` — moves to `sendingDomainSesIdentities.verificationToken`
- `sesVerificationStatus` — deleted (redundant with `verificationResults.sesStatus`)
- `sesRegistrationError` — deleted (folded into `lastRegistrationError` on `domains`)
- `registrationError` — renamed to `lastRegistrationError` for clarity (only the most-recent attempt's error matters)

The `domains` table keeps:

- `domain`, `status`, `dnsRecords`, `verificationResults`,
  `providerType`, `lastRegistrationError?`, `lastVerifiedAt?`,
  `verifiedAt?`, `createdAt`, `updatedAt`.

### Verification flow

```ts
// dnsVerification.ts (rewritten as the run_dns_verification effect handler)

export const verifyDomain = action({
  args: { domainId: v.id('domains') },
  handler: async (ctx, args) => {
    const domain = await ctx.runQuery(internal.domains.queries.getDomainForVerification,
      { domainId: args.domainId });
    if (!domain) throw new Error('Domain not found');

    // Pure DNS lookups — unchanged. Helpers verifyTxtRecord, verifyCnameRecord,
    // verifyMxRecord stay where they are.
    const dnsResults = await runDnsLookups(domain.domain, domain.dnsRecords);

    // Per-provider check — SES adapter calls getVerificationStatus; MTA omits.
    const adapter = providerFor(domain.providerType as SendingDomainProviderKind);
    const providerCheck = adapter.runProviderCheck
      ? await adapter.runProviderCheck(domain.domain)
      : { verified: true };

    // Lifecycle owns the next-status decision.
    await ctx.runMutation(internal.domains.lifecycle.recordVerification, {
      domainId: args.domainId,
      verificationResults: dnsResults,
      providerCheck,
    });
  },
});
```

`recordVerification`'s reducer computes the next status:

```ts
const dnsAllVerified = dnsRecordsAllVerified(verificationResults);
const dnsAnyFailed = dnsAnyRecordFailed(verificationResults);

const allVerified = dnsAllVerified && providerCheck.verified;
const anyFailed = dnsAnyFailed || (providerCheck.lastError !== undefined);

const next: SendingDomainStatus =
  allVerified ? 'verified' : anyFailed ? 'failed' : 'pending';

return transition({ domainId, input: { to: next, verificationResults }, source: 'verifier' });
```

The reducer never branches on `providerType`. "Provider-specific
verification rules" live entirely inside `runProviderCheck`.

### Call-site shape after the cut

```ts
// apps/api/convex/domains/domains.ts (thinned)

// `create` public mutation — auth shell + lifecycle delegate
export const create = mutation({
  args: { domain: v.string() },
  handler: async (ctx, args): Promise<Id<'domains'>> => {
    const outcome = await ctx.runMutation(
      internal.domains.lifecycle.create,
      { domain: args.domain },
    );
    if (!outcome.ok) {
      if (outcome.reason === 'invalid_format') {
        throwInvalidInput('Invalid domain format.');
      }
      if (outcome.reason === 'already_exists') {
        throwAlreadyExists('This domain has already been added.');
      }
    }
    return outcome.domainId;
  },
});

// `regenerateDnsRecords` — auth shell + lifecycle delegate
export const regenerateDnsRecords = mutation({
  args: { domainId: v.id('domains') },
  handler: async (ctx, args) => {
    const outcome = await ctx.runMutation(
      internal.domains.lifecycle.transition,
      {
        domainId: args.domainId,
        input: { to: 'registering' },
        source: 'user',
      },
    );
    if (!outcome.ok) {
      if (outcome.reason === 'domain_not_found') throwNotFound('Domain');
      throwInvalidState(`Cannot regenerate: ${outcome.reason}`);
    }
  },
});

// `remove` — auth shell + lifecycle delegate
export const remove = mutation({
  args: { domainId: v.id('domains') },
  handler: async (ctx, args) => {
    const outcome = await ctx.runMutation(
      internal.domains.lifecycle.remove,
      { domainId: args.domainId },
    );
    if (!outcome.ok && outcome.reason === 'domain_not_found') {
      throwNotFound('Domain');
    }
  },
});

// Public verify entry — auth shell + lifecycle delegate
export const verify = mutation({
  args: { domainId: v.id('domains') },
  handler: async (ctx, args) => {
    const outcome = await ctx.runMutation(
      internal.domains.lifecycle.requestVerification,
      { domainId: args.domainId },
    );
    if (!outcome.ok) {
      if (outcome.reason === 'still_registering') {
        throwInvalidState('Domain is still being registered. Please wait a moment and try again.');
      }
      throwNotFound('Domain');
    }
  },
});

// Read queries (listByOrganization, get, getByDomain, countByStatus,
// listVerified, isDomainVerified, isDomainVerificationFresh,
// getEmailDomainVerificationStatus) — unchanged.
```

```ts
// apps/api/convex/domains/providers/mta/index.ts (new)

import type { SendingDomainProviderModule, MtaIdentity } from '../types';
import { createMtaIdentityManager } from '../../../lib/emailProviders/mtaIdentity';
import { getOptional } from '../../../lib/env';
import type { DnsRecord, DnsRecords } from '../../domains';

export const mtaProvider: SendingDomainProviderModule<'mta'> = {
  kind: 'mta',

  async registerDomain(domain) {
    const mta = createMtaIdentityManager();
    const { selector, dnsRecord } = await mta.registerDomain(domain);

    const dkimRecords: DnsRecord[] = [{
      type: 'TXT',
      host: `${selector}._domainkey`,
      value: dnsRecord,
    }];

    const dnsRecords: DnsRecords = {
      dkim: dkimRecords,
      dmarc: {
        type: 'TXT',
        host: '_dmarc',
        value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
      },
    };

    const spfInclude = getOptional('MTA_SPF_INCLUDE');
    if (spfInclude) {
      dnsRecords.spf = {
        type: 'TXT',
        host: '@',
        value: `v=spf1 include:${spfInclude} ~all`,
      };
    }

    return {
      dnsRecords,
      identity: { kind: 'mta', dkimSelector: selector } satisfies MtaIdentity,
    };
  },

  async deleteFromProvider(domain) {
    const mta = createMtaIdentityManager();
    await mta.deleteDomain(domain);
  },

  // runProviderCheck — omitted. MTA has no provider-side verification call.

  async writeIdentity(ctx, domainId, identity) {
    const existing = await ctx.db
      .query('sendingDomainMtaIdentities')
      .withIndex('by_domain', (q) => q.eq('domainId', domainId))
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { dkimSelector: identity.dkimSelector, updatedAt: now });
    } else {
      await ctx.db.insert('sendingDomainMtaIdentities', {
        domainId,
        dkimSelector: identity.dkimSelector,
        createdAt: now,
        updatedAt: now,
      });
    }
  },

  async loadIdentity(ctx, domainId) {
    const row = await ctx.db
      .query('sendingDomainMtaIdentities')
      .withIndex('by_domain', (q) => q.eq('domainId', domainId))
      .first();
    return row ? { kind: 'mta', dkimSelector: row.dkimSelector } : null;
  },

  async clearIdentity(ctx, domainId) {
    const existing = await ctx.db
      .query('sendingDomainMtaIdentities')
      .withIndex('by_domain', (q) => q.eq('domainId', domainId))
      .first();
    if (existing) await ctx.db.delete(existing._id);
  },
};
```

The SES adapter has the same shape with `runProviderCheck` implemented
(calls `createSESIdentityManager().getVerificationStatus(...)`) and the
`sendingDomainSesIdentities` table backing identity persistence.

### File layout

```
apps/api/convex/domains/
  lifecycle.ts                       (new) — entry points + reducer + LEGAL_EDGES + effects
  queries.ts                         (new) — internalQuery `getDomainForVerification`
                                              (replaces dnsVerificationQueries' read query)
  domains.ts                         (thinned) — public CRUD shells
  dnsVerification.ts                 (rewritten) — verifier action; calls runProviderCheck +
                                                  lifecycle.recordVerification
  trackingDomains.ts                 (unchanged) — disjoint domain
  providers/
    index.ts                         (new) — registry
    types.ts                         (new) — adapter interface, identity unions
    mta/
      index.ts                       (new) — adapter
      registerAction.ts              (new) — 'use node' effect handler for register_with_provider
    ses/
      index.ts                       (new) — adapter
      registerAction.ts              (new) — 'use node' effect handler
```

Deletions at the convex root:

- `apps/api/convex/sesActions.ts` — actions migrate to `providers/ses/`.
- `apps/api/convex/mtaActions.ts` — actions migrate to `providers/mta/`.
- `apps/api/convex/domains/dnsVerificationQueries.ts` — the three
  status-writing mutations (`updateVerificationStatus`,
  `updateDomainAfterSESRegistration`, `updateDomainAfterRegistration`)
  all collapse into the lifecycle reducer; the read query
  (`getDomain`, `listAllDomains`) moves to `domains/queries.ts`.

## Considered options

### Lifecycle scope

1. **Status transitions only** — lifecycle owns `domains.status`
   transitions, provider-specific work stays in
   `sesActions.ts` / `mtaActions.ts`. Adding a 3rd provider still
   requires edits to dispatch switches in `domains.create` /
   `regenerateDnsRecords` / `remove`. Rejected — the provider seam is
   already real (two adapters) and leaving it unnamed re-introduces
   the same per-provider smear the lifecycle is supposed to close.
2. **Status + provider effects** — lifecycle owns transitions and
   emits typed effects (`register_with_provider`, etc.) but
   per-provider work stays in flat `*Actions.ts` files keyed by
   provider name. Better than (1) but still leaves provider state
   sprawled across one row's columns. Rejected — fixes the dispatch
   smear but leaves the wide-row provider-columns problem
   unaddressed.
3. **Status + provider effects + per-provider adapter modules with
   sibling tables** *(chosen)*. Closes all four pain points (status
   writers, dispatch smear, kitchen-sink mutation, wide-row provider
   columns) in one pass.

### Provider-state storage

1. **Discriminated `providerState` union on the `domains` row** —
   replace 5 columns with one union field. Schema-enforces "only one
   provider's state at a time." Pros: central, one place to see all
   shapes. Cons: doesn't match the dominant "module owns its own
   storage" pattern from Block / Step / Channel inbound / Webhook
   event modules. A 3rd provider edits a central union. Rejected.
2. **Per-provider sibling rows in per-provider tables** *(chosen)* —
   `sendingDomainMtaIdentities`, `sendingDomainSesIdentities`. Each
   adapter owns its own table. Adding a 3rd provider = new folder +
   new table, no central edit. Matches the **Contact identities**
   pattern (sibling rows per identity kind) and the per-kind storage
   discipline.
3. **Keep the 5 wide columns; lifecycle is the discipline** — no
   schema change. Lifecycle reducer trusts itself to write only the
   right subset. Rejected — schema enforces nothing; future writers
   could re-introduce the multi-provider-columns-set bug.

### Regenerate as transition vs companion entry point

1. **`requestRecreation({ domainId })` companion entry point** —
   named convenience for the regenerate button. Deletion test:
   inlining as `transition({ to: 'registering' })` is one line; the
   companion is a pass-through. Rejected.
2. **Legal edges `failed → registering` and `verified → registering`**
   *(chosen)*. Same `transition` API as every other change. UI
   button's label is not a lifecycle concern.

### Verifier ownership of status

1. **Verifier action computes status and passes it to a generic
   `recordVerification({ nextStatus, results })`** — the existing
   shape lifted into the lifecycle. Easy migration. Rejected —
   another writer could in principle pass any status, undermining
   "single decision rule" guarantee.
2. **Lifecycle reducer derives status from raw results;
   `recordVerification({ dnsResults, providerCheck })`** *(chosen)*.
   The decision rule lives in one place. The per-provider check
   contributes `{ verified, lastError? }` from the adapter; the
   reducer combines with the generic DNS rule.
3. **Lifecycle reducer derives status; adapter exposes
   `evaluateVerification(dnsResults): { verified, anyFailed }` pure
   function for per-provider rules** — generalizes the per-provider
   decision logic. Rejected as premature: today only SES has a
   per-provider rule (the live status check), and the rule reduces
   to one boolean. The boolean flows through `runProviderCheck`'s
   return; no per-provider pure decision function needed yet.

### `remove` as lifecycle entry vs non-lifecycle direct call

1. **`remove()` is a non-lifecycle mutation** that calls the adapter
   directly. Rejected — leaves audit-log writes outside the
   lifecycle and creates an inconsistency with `create()` which *is*
   lifecycle-owned.
2. **`remove()` is a lifecycle entry point** *(chosen)*. Mirrors
   Topic subscription module's `subscribe` / `unsubscribe` symmetry.
   Lifecycle owns row birth and row death; audit log is uniform.

### Module naming

1. **`Sending domain lifecycle (module)` at `convex/domains/lifecycle.ts`**
   *(chosen)*. Matches the Outbound-lifecycle naming pattern (Send
   lifecycle, Postbox outbound lifecycle, DOI lifecycle, Inbox
   processing lifecycle, Abuse status, Campaign lifecycle — each named
   after the column they own). The "Sending" qualifier disambiguates
   from `trackingDomains` (separate table, separate concept, no
   lifecycle).
2. **`Domain lifecycle (module)`** — rejected. "Domain" without
   qualifier reads ambiguously alongside `trackingDomains` and the
   `domainReputation` table.
3. **`Sending domain provider adapter (module)`** *(chosen)* for the
   per-provider half. Matches ADR-0005's **Channel inbound adapter**
   naming.
4. **`Sending domain provider module`** — rejected for the per-provider
   half. Without "adapter," the term collides with the existing
   `lib/emailProviders/` factory shape; "adapter" carries the role of
   "a concrete thing satisfying an interface at a seam" per
   LANGUAGE.md.

### Audit-log universality

1. **Add `sending_domain.*` audit actions to the catalog and fire on
   every lifecycle transition** *(chosen)*. Matches Campaign / DOI /
   Send / Postbox lifecycle discipline. Closes the today-zero
   coverage gap.
2. **Skip audit log for now; add later** — rejected. Adding audit
   later means an extra migration pass; landing it with the
   deepening costs one line per transition.

### Provider sibling table naming

1. **`sendingDomainMtaIdentities`, `sendingDomainSesIdentities`**
   *(chosen)*. Singular per-provider naming, prefixed for grep-ability.
   Matches `contactIdentities` pattern.
2. **`domainMtaProviderConfig`, `domainSesProviderConfig`** —
   rejected. "Config" suggests user-settable; these rows are
   provider-issued credentials/tokens, not configuration.
3. **`mtaSendingDomains`, `sesSendingDomains`** — rejected. Reads as
   "domains the MTA owns" rather than "MTA-side identity of a
   sending domain."

## Consequences

### Files that collapse / disappear

- `apps/api/convex/sesActions.ts` — deleted. `registerDomainWithSES`
  moves to `providers/ses/registerAction.ts`. `deleteDomainFromSES`
  becomes the SES adapter's `deleteFromProvider` method.
  `checkSESVerificationStatus` becomes the SES adapter's
  `runProviderCheck`. `migrateExistingDomains` (one-shot ops migration
  helper) moves to an internal-action under `providers/ses/` or is
  deleted if no longer needed post-deepening.
- `apps/api/convex/mtaActions.ts` — deleted. `registerDomainWithMTA`
  moves to `providers/mta/registerAction.ts`. `deleteDomainFromMTA`
  becomes the MTA adapter's `deleteFromProvider` method.
- `apps/api/convex/domains/dnsVerificationQueries.ts` — the three
  status-writing mutations all collapse into the lifecycle reducer.
  `getDomain` moves to `domains/queries.ts`; `listAllDomains` moves
  there too.
- The three inline `if (providerType === 'mta')` dispatches in
  `domains.ts` (create, regenerate, remove) collapse to one
  `lifecycle.transition` call each; the dispatch lives once, inside
  the `register_with_provider` / `clear_provider_identity` /
  `delete_with_provider` effect handlers.
- The five open-coded `ctx.db.patch(domainId, { status: ..., ... })`
  calls across `domains.ts:205`, `dnsVerificationQueries.ts:52, 72,
  105`, all go.
- The provider-aware status branch in `dnsVerification.ts:316-323`
  collapses into the lifecycle reducer's `runProviderCheck`-driven
  derivation.

### Files that grow

- `apps/api/convex/domains/lifecycle.ts` — new module (~380 LOC).
  Five entry points (`create`, `transition`, `requestVerification`,
  `recordVerification`, `remove`), the reducer per `to` value,
  legal-edges graph, effect runner.
- `apps/api/convex/domains/providers/index.ts` — new (~30 LOC).
  Registry + `providerFor` lookup.
- `apps/api/convex/domains/providers/types.ts` — new (~50 LOC).
  Adapter interface, identity unions.
- `apps/api/convex/domains/providers/mta/index.ts` — new (~100 LOC).
  MTA adapter (5 methods + identity-table CRUD).
- `apps/api/convex/domains/providers/mta/registerAction.ts` — new
  (~50 LOC). `'use node'` effect handler — calls
  `mtaProvider.registerDomain` then
  `lifecycle.transition({ to: 'pending' | 'failed', ... })`.
- `apps/api/convex/domains/providers/ses/index.ts` — new (~140 LOC).
  SES adapter (5 methods + identity-table CRUD + `runProviderCheck`).
- `apps/api/convex/domains/providers/ses/registerAction.ts` — new
  (~70 LOC). `'use node'` effect handler.
- `apps/api/convex/domains/queries.ts` — new (~30 LOC). Internal read
  query consumed by the verifier action.
- `apps/api/convex/domains/__tests__/lifecycle.integration.test.ts`
  — new (~25 tests; see §Test surface).
- `apps/api/convex/domains/__tests__/providers.integration.test.ts`
  — new (~10 tests covering identity-row writes per adapter and
  `runProviderCheck` interaction).
- `apps/api/convex/domains/domains.ts` — shrinks. The four mutations
  (`create`, `regenerateDnsRecords`, `remove`, `verify`) become
  ~10 LOC auth shells each. Read queries unchanged. Net ~120 LOC down.
- `apps/api/convex/domains/dnsVerification.ts` — shrinks. The
  TXT/CNAME/MX helpers (lines 12-216) stay verbatim. The
  `verifyDomain` action body shrinks from ~133 LOC to ~25 LOC
  (load → DNS lookups → adapter.runProviderCheck →
  lifecycle.recordVerification). Net ~110 LOC down.
- `apps/api/convex/schema/domains.ts` — gains the two sibling table
  defs; loses 5 provider-specific column defs from `domains`. Net
  ~40 LOC up.
- `apps/api/convex/auditActions/catalog.ts` — adds 7
  `sending_domain.*` action literals. Net ~10 LOC up.

Net LOC change: ~230 LOC down (deleted dispatches, collapsed
mutations, thinned shells) plus ~890 LOC up (new modules, adapters,
sibling tables) plus ~400 LOC up (new tests). Net ~+1060 LOC. Value:
locality (status writers 5 → 1; provider dispatches 3 → 0; status
decision sites 2 → 1; provider columns sprawled across 5 fields on
one row → owned by per-provider tables), typed adapter contract,
audit-log universality on every transition, and a per-provider seam
that survives the addition of a 3rd provider as a one-folder change.

### Migration

The `domains` schema change has production data. Pre-prod-only is
not an option; existing self-hosted deployments have live `domains`
rows.

**Migration steps** (one Convex internal mutation,
`migrations/0018_sending_domain_identity_sibling.ts`):

1. For every `domains` row:
   - If `providerType === 'mta'` and `mtaDkimSelector` is set:
     insert one `sendingDomainMtaIdentities` row with
     `{ domainId, dkimSelector: mtaDkimSelector }`.
   - If `providerType === 'ses'` (or absent, treated as `'ses'` per
     today's default) and both `sesDkimTokens` and
     `sesVerificationToken` are set: insert one
     `sendingDomainSesIdentities` row with `{ domainId, dkimTokens,
     verificationToken }`.
   - Rename `registrationError` → `lastRegistrationError`
     (or coalesce `registrationError ?? sesRegistrationError`).
2. Drop the 5 provider-specific columns from `domains` in a second
   schema deployment after the backfill.

Two-deploy migration. Step 1 (backfill) is idempotent — re-running
patches existing identity rows rather than duplicating. Step 2 is
the schema removal once the backfill is confirmed.

Rows in `'registering'` at migration time have no identity to
backfill — the register completion has not yet written
`mtaDkimSelector` / `sesDkimTokens`. They land in the new world
correctly: no sibling row exists; when register completes via the
new effect handler, the adapter inserts the sibling row.

### Test surface

`apps/api/convex/domains/__tests__/lifecycle.integration.test.ts`
(new, ~25 tests):

**Legal edges — happy path:**
- `create()` on a fresh domain: asserts insert at `'registering'`,
  `audit_log` `sending_domain.created`, `register_with_provider`
  scheduled.
- `create()` on duplicate domain: asserts
  `{ ok: false, reason: 'already_exists' }`, no insert, no effects.
- `create()` with invalid format: asserts
  `{ ok: false, reason: 'invalid_format' }`.
- `registering → pending` with MTA identity: asserts `dnsRecords`
  patched, `audit_log` `sending_domain.registered`, MTA identity row
  inserted via `mtaProvider.writeIdentity`.
- `registering → pending` with SES identity: same, SES identity row.
- `registering → failed`: asserts `lastRegistrationError` patched,
  audit log, no identity row.
- `pending → verified`: asserts `verificationResults`,
  `lastVerifiedAt`, `verifiedAt` (first-time) patched, audit log
  `sending_domain.verified`.
- `verified → verified` self-loop: asserts `verificationResults`,
  `lastVerifiedAt` patched, no audit log, `verifiedAt` unchanged.
- `pending → failed` (verify): audit log
  `sending_domain.verification_failed`, no identity row touched.
- `verified → failed` (DNS broke after first verify): asserts
  `verifiedAt` is preserved (the first-verified history doesn't
  reset).
- `verified → registering` (regenerate): asserts `dnsRecords: {}`,
  `verificationResults: undefined`, `verifiedAt: undefined`,
  `lastVerifiedAt: undefined`, identity row deleted via
  `clearIdentity`, `clear_provider_identity` and
  `register_with_provider` effects fire, audit log
  `sending_domain.regenerated`.
- `failed → registering` (regenerate from failed): same effects,
  identity row may not exist (test with and without).
- `remove()`: asserts identity row deleted, domain row deleted,
  `delete_with_provider` scheduled, audit log
  `sending_domain.deleted`.

**Legal edges — illegal:**
- `registering → verified`: `{ ok: false, reason: 'illegal_edge' }`.
- `registering → registering`: `{ ok: false, reason: 'illegal_edge' }`
  (regenerate disallowed while still registering).
- `pending → registering` (no regenerate from pending): `illegal_edge`.

**Verification path:**
- `requestVerification` on `pending`: asserts `run_dns_verification`
  scheduled, no status patch yet.
- `requestVerification` on `registering`: asserts
  `{ ok: false, reason: 'still_registering' }`, no effect.
- `recordVerification` with all verified + provider check verified:
  asserts transitions `pending → verified`.
- `recordVerification` with DNS verified but SES `lastError`:
  asserts transitions `pending → failed`.
- `recordVerification` with some DNS pending, none failed: asserts
  `pending → pending` recorded self-loop with results patched.

**Outcome shapes:**
- Idempotent re-application of `→ pending` (same identity): asserts
  `{ ok: true, applied: false, reason: 'duplicate' }` — no second
  identity row insert.
- Unknown domain returns
  `{ ok: false, reason: 'domain_not_found' }`.

`apps/api/convex/domains/__tests__/providers.integration.test.ts`
(new, ~10 tests):

- `mtaProvider.writeIdentity` then `loadIdentity` round-trip.
- `mtaProvider.writeIdentity` twice with different selectors:
  asserts the second writes a patch, not a second insert.
- `mtaProvider.clearIdentity` when no row exists: no-op.
- `sesProvider.writeIdentity` then `loadIdentity` round-trip
  (DKIM tokens array preserved).
- `sesProvider.runProviderCheck` mocked to return `{ verified: true }`:
  asserts lifecycle's `recordVerification` reduces with
  `providerCheck.verified = true`.
- `sesProvider.runProviderCheck` mocked to throw: asserts the
  verifier action surfaces the error to the lifecycle as
  `providerCheck.lastError`.
- `providerFor('mta')` returns the MTA adapter; `providerFor('ses')`
  returns the SES adapter; `providerFor('unknown' as any)` throws.

### CONTEXT.md additions

New section `## Sending domains` between **Forms** and **Campaigns**
(domains are inputs to campaigns; the sequencing reads top-to-bottom
in dependency order):

- **Sending domain** — the row noun.
- **Sending domain status** — the column + legal-edges graph.
- **Sending domain lifecycle (module)** — the writer.
- **Sending domain provider adapter (module)** — the per-provider
  half.
- **Sending domain identity** — the per-provider sibling row.

The existing **Tracking domain** disjoint is called out in the
**Sending domain** entry's *Avoid* clause.

### Vocabulary discipline

Avoid:

- **Domain (module)** — collides with `trackingDomains` (separate
  table, different lifecycle, no module needed today).
- **Domain registration module** — names one transition path, not
  the whole machine.
- **Domain provider module** — collides with the existing
  `lib/emailProviders/` factory shape; "adapter" carries the role
  per LANGUAGE.md.
- **Sending domain registration lifecycle** — too narrow; the
  lifecycle covers verification and recreation too.

### Cross-references

- ADR-0005 (Channel inbound adapters) — per-adapter module pattern
  precedent.
- ADR-0011 (Abuse status modules) — singleton-table lifecycle
  precedent.
- ADR-0012 (Postbox outbound lifecycle) — per-machine reducer +
  effects + legal-edges shape.
- ADR-0017 (Campaign lifecycle modules) — most recent lifecycle
  deepening; uses `audit_log` effect on every transition and the
  `source` discriminator pattern this ADR adopts.
