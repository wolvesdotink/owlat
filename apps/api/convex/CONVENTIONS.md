# Convex Backend Conventions

This document captures the conventions for organizing files in
`apps/api/convex/`. The flat 161-file layout has outgrown the legacy
single-prefix-per-file pattern; new code should follow the rules below, and
existing files migrate to them as touched.

---

## File layout

### Domain folders

Each business area lives in its own folder under `apps/api/convex/`:

```
convex/
├── mail/         # SMTP/IMAP, mailboxes, messages, drafts, identities
├── campaigns/    # Marketing campaigns + scheduling + archives
├── contacts/     # CRM contacts, identities, segments
├── automations/  # Trigger-based workflows
├── topics/       # Topics + DOI flows
├── webhooks/     # Outbound webhooks + delivery logs
├── inbox/        # Shared inbox + threading
├── analytics/    # Funnels, reports, AI-driven viz
├── domains/      # SPF/DKIM/DMARC, warming, reputation
├── delivery/     # Provider-agnostic send pipeline
├── forms/        # Embeddable signup forms
├── auth/         # BetterAuth integration, sessions, roles
├── lib/          # Shared helpers (env, permissions, providers)
├── _utils/       # Lower-level utilities (errors, IDs)
└── _generated/   # Convex codegen output
```

Convex generated function paths mirror the folder structure: a query in
`mail/imap.ts` is reached via `api.mail.imap.<funcName>`.

### One file per `<domain>/<feature>.ts`

Default: queries, mutations, and actions for one feature live in a single file
mixing them together.

```ts
// mail/imap.ts
export const listFolders = query({ ... });
export const fetchMessage = query({ ... });
export const setFlag = mutation({ ... });
export const syncMailbox = action({ ... });
```

### Split only above ~500 LOC

When a single feature file grows past ~500 LOC, split into siblings:

```
mail/
├── outbound.ts                  # entry-point types/helpers
├── outboundQueries.ts
├── outboundMutations.ts
└── outboundActions.ts
```

Don't pre-emptively split — the cost of locating a function across three files
outweighs the cost of scrolling. Wait for real growth.

This is enforced by a ratchet: `scripts/check-file-size.sh` (wired into
`bun run lint` via `ci:lint`/`ci:verify`) fails when a `.ts`/`.vue` file under
`apps/**` or `packages/**` crosses ~500 LOC and is not already in the frozen
`scripts/file-size-baseline.txt`. The existing oversized files are grandfathered
there; split a new god-file instead of adding a baseline line, and drop a
baseline entry once its file falls back under the cap.

### Drop redundant prefixes

Once a file lives in its domain folder, drop the prefix from the filename:

| Before                    | After                |
| ------------------------- | -------------------- |
| `mailAliases.ts`          | `mail/aliases.ts`    |
| `mailMailbox.ts`          | `mail/mailbox.ts`    |
| `campaignArchive.ts`      | `campaigns/archive.ts` |
| `contactsOrganization.ts` | `contacts/index.ts` (or feature-named) |

The `*Organization.ts` suffix should disappear — it was a workaround for the
flat namespace. Within a domain folder, just use the feature name.

### `*Http.ts` is preserved

Files ending in `Http.ts` register HTTP routes (`http.route(...)`) and run on
a different runtime than queries/mutations. Keep them separate from sibling
queries to make that distinction obvious:

```
forms/
├── api.ts        # queries/mutations
└── apiHttp.ts    # HTTP routes that call into api.ts
```

---

## Imports & paths

- Within `apps/api/convex/`, prefer relative imports for siblings (`./helpers`)
  and parent helpers (`../lib/env`).
- The generated API surface (`internal.mail.imap.*`, `api.mail.imap.*`) is the
  cross-runtime call shape — never reach across via direct file imports for
  queries/mutations/actions. Use the generated `internal` / `api` objects.
- External callers (`apps/web`, `apps/imap`, `apps/mta`) consume the generated
  types via `@owlat/api` and the `api` / `internal` objects from
  `convex/_generated/api`.

## Public function builders (secure by default)

Convex publishes **every** non-`internal` `query`/`mutation`/`action` on the
deployment's public client API — an anonymous internet caller can invoke any of
them. Never reach for the bare `query`/`mutation`/`action` builders from
`_generated/server`; use the secure-by-default wrappers in
[`lib/authedFunctions.ts`](lib/authedFunctions.ts):

- `authedQuery` / `authedMutation` / `authedAction` — require an authenticated
  session (mutations require an active org + member role). This is the default.
- `authedIdentityMutation` — authenticated identity only, no org membership;
  for the narrow pre-org signup path (e.g. `auth/userProfiles.create`).
- `publicQuery` / `publicMutation` / `publicAction` — explicit opt-out for
  endpoints that are intentionally reachable unauthenticated (token-gated
  share/DOI/unsubscribe links, signature-verified webhooks, tracking pixels,
  the pre-auth setup page). Every use **must** carry a `// public: <reason>`
  comment.

The wrapper only enforces the auth floor; privileged writes still layer a
`requirePermission(hasPermission(role, '<scope>:<verb>'))` (or the
query/mutation-compatible `requireOrgPermission(ctx, '<scope>:<verb>')`) check
inside the handler. `internalQuery`/`internalMutation`/`internalAction` and
`httpAction` are unaffected (server-only, or a separately-authenticated HTTP
surface). HTTP routes that call into a session-gated function from an
API-key/no-session context must call an `internal*` sibling (see
`contacts.contacts.getInternal`, `topics.topics.addContactInternal`).

`scripts/check-public-functions.sh` (wired into `bun run lint`) bans the bare
builders outside `lib/authedFunctions.ts` — a forgotten gate fails CI.

### Feature-flag floors

Modules behind an instance feature flag (`chat`, `ai.assistant`, …) must not let
handlers reach the DB when the flag is off. Rather than repeating
`await assertFeatureEnabled(ctx, '<flag>')` at the top of every handler, compose
the flag check into the wrapper with `featureGated`:

```ts
// chat/_helpers.ts
export const chatQuery = featureGated(authedQuery, 'chat');
export const chatMutation = featureGated(authedMutation, 'chat');
```

`featureGated(builder, flag)` returns a builder of the same type that runs
`assertFeatureEnabled(ctx, flag)` **after** the wrapped builder's auth floor and
**before** the handler — the same floor-baking pattern as `adminMutation` /
`ownerMutation`. Per-record authz (e.g. chat `assertCan*Room`, the
`chat:participate` / `chat:manage` role gates, or owner-scoping in the assistant
data plane) still lives in the handler. Only query/mutation builders can be
gated this way — `assertFeatureEnabled` reads `ctx.db`, which **actions** lack,
so feature-gated actions keep the in-handler check against a query they call.

## Permissions

`authedMutation` / `authedAction` only enforce the auth *floor* (an authenticated
org member of **any** role, including `editor`). Every **state-changing** public
function must additionally make an explicit **authorization** decision — *who* may
run it. `scripts/check-permissions.sh` (wired into `bun run lint`, baseline 0)
fails CI on any `authedMutation`/`authedAction` that makes none. Satisfy it one of
three ways:

- **Role-bearing wrapper** — `adminMutation` / `ownerMutation` (and `adminQuery`
  for sensitive reads) from `lib/authedFunctions.ts` bake the role check in. Use
  these for admin-only writes.
- **In-handler gate** — `requirePermission(hasPermission(role, '<scope>:<verb>'))`
  (or `requireAdminContext` / `requireOrgPermission`, or the per-user
  `requireMailboxAccess` / `loadOwnedMessage`, chat `assertCan*Room`,
  `requirePlatformAdmin`). Prefer the specific `<scope>:<verb>` permission where
  one fits the capability.
- **Explicit opt-out comment** — `// authz: <reason>` when the gate genuinely
  lives elsewhere (a delegated `internal*` mutation, or a self-scope check like
  `args.userId === session.userId`), or `// all-members: <reason>` when the write
  is intentionally available to every member.

Do **not** use `isAdminRole`/`isOwnerRole` inline (removed) — they obscure the
capability being checked. See ADR-0039 (enforcement model) and ADR-0040
(shared-inbox example).

## Environment variables

All `process.env.X` reads must go through `lib/env.ts`. Add the key to the
`EnvKey` union there and use `getRequired` / `getOptional` / `getWithDefault`.
Test files (`__tests__/**`, `*.test.ts`) are exempt — they need to mutate the
env at runtime via `vi.stubEnv` and `delete process.env.X`.

The `bun run lint:env` script enforces this.

## Convex best practices

This codebase tracks the official Convex AI/cursor rules
(https://docs.convex.dev/production/best-practices). Some load-bearing ones:

- **Always declare `args:`** on every exported `query`, `mutation`, `action`,
  `internalQuery`, `internalMutation`, `internalAction`. For zero-arg
  functions use `args: {}`. The `lint:patterns` check enforces this.
- **Index, don't filter.** Prefer `.withIndex('by_x', q => q.eq('x', val))`
  over `.query('table').filter(...)`. New `.filter()` call sites must not
  push the count above the baseline in `scripts/check-convex-patterns.sh`.
- **Bound `.collect()`.** Use `.take(n)`, pagination
  (`paginationOptsValidator`), or a cached counter for any table that can
  grow unboundedly. If a scan is intentional (e.g. an intrinsically tiny
  table), trail the call with a `// bounded: reason` comment so the lint
  check ignores it.
- **Cache the singleton-org check.** `assertSingletonOrgInvariant` in
  `lib/sessionOrganization.ts` is process-cached after the first hit — do
  not re-implement the check inline in callers.
- **Use `console.info`/`warn`/`error`, never `console.log`.** Convex's stdout
  pipe to log sinks treats all four equivalently, but the typed level
  signals intent and dodges the `no-console` ratchet.
- **Load-or-404 with `getOrThrow`.** For the ubiquitous
  `const x = await ctx.db.get(id); if (!x) throwNotFound('Label')` pattern, call
  `getOrThrow(ctx, id, 'Label')` from `_utils/errors.ts` instead — it returns
  the non-null `Doc<T>` or throws the same `not_found` `ConvexError`. It is
  structurally typed on `db.get`, so both `QueryCtx` and `MutationCtx` satisfy
  it. Keep hand-rolling `throwNotFound` only where the guard is not a plain
  `get(id)` null check (e.g. `query().unique()` or outcome-based results).

The `bun run lint:patterns` script (also wired into `bun run lint`) tracks
all four of these against a checked-in baseline.

## Schema

`schema.ts` composes per-domain table modules from `schema/`:

```ts
import { mailTables } from './schema/mail';
import { campaignTables } from './schema/campaigns';

export default defineSchema({
  ...mailTables,
  ...campaignTables,
  // ...
});
```

Add new tables to the matching `schema/<domain>.ts` file. `defineSchema` does
not accept spread directly, so the index file is the merge point.

## Schema evolution (post-launch immutability)

Pre-launch we move freely. Post-launch, any change to data on disk is a
migration: existing rows already use the old shape, and external consumers
(SDKs, webhook receivers) depend on the wire contract.

### Never do these without a version bump
- Rename a field on a production table. Add a new field, dual-write,
  deprecate the old one, then drop after a deprecation window.
- Change a `v.literal()` literal value. Add a new value; migrate writers
  first; deprecate the old value last.
- Narrow a `v.union(...)` — removes a case that existing rows may already
  use, breaking deserialization on read.
- Change the structure of a JSON blob stored as `v.string()` without
  bumping its sibling `<field>Version`.

### Versioning rules
- Every JSON blob in a `v.string()` or `v.any()` field MUST be paired with a
  sibling `<field>Version: v.optional(v.number())` field. Bump the matching
  constant in `lib/constants.ts` when the shape changes; reader code can
  branch on the stored version.
- `webhookDeliveryLogs.payloadVersion` is the contract version for external
  customer-side webhook receivers. Bumping is a breaking change. Document
  the per-version shape in `docs/webhook-payloads.md`.
- `emailTemplates.contentBlockVersion` / `transactionalEmails.contentBlockVersion`
  / `mailDrafts.bodyBlocksVersion` track the `EditorBlock[]` JSON format.
  `packages/email-renderer` must support every historical version, or write
  a one-shot migration when a version is retired.
- `*.rendererVersion` tracks the renderer engine. Bump when re-rendering
  the same blocks produces materially different HTML — needed when reading
  a `shareLinks` snapshot or rehydrating cached output.

### Boolean naming
All boolean fields use the `is*` prefix: `isVerified`, `isEnabled`, `isActive`,
`isDefault`, `isPrimary`. Domain enums that happen to spell `'verified'` as a
literal value (e.g. `domains.status='verified'`) are status strings, not
booleans, and are exempt.

### Soft-delete contract
Tables with `deletedAt: v.optional(v.number())`:
- `contacts`, `userProfiles`, `emailSends`, `transactionalSends`

Rules:
- User-initiated deletes mark the row (`softDeleteContact` etc.) — never
  hard-delete from a user-facing mutation.
- All list / search / lookup queries MUST filter `deletedAt === undefined`
  (use `notSoftDeleted` from `lib/queryHelpers.ts` or the indexed
  `.filter((q) => q.eq(q.field('deletedAt'), undefined))`). Repository
  helpers like `getContactOrThrow` already filter; prefer them at read sites.
- A daily cron (`cleanupSoftDeletedContacts`) permanently deletes rows
  whose `deletedAt < now - 30 days`. The hard-delete cascade list lives
  in `lib/contactMutations.ts:permanentlyDeleteContactWithRelations`.

### Polymorphic foreign keys
When a table can reference one of multiple parents (e.g. `shareLinks` →
`emailTemplate | transactionalEmail`), include a `<name>Type` discriminator
literal union alongside the optional id fields. Mutations enforce the xor
invariant at insert time: exactly one id must be set, matching the
discriminator. See `shareLinks.targetType` and `blockedEmails.sourceType`.

### Denormalized & snapshot fields
- Snapshot fields (captured at an event, never updated) are marked with
  a `// SNAPSHOT —` comment in the schema. Examples: `emailSends.contactEmail`,
  `emailSends.contactFirstName`, `emailSends.contactLastName` — they record
  what we sent, not the contact's current state. Touching them post-send is
  a corruption bug.
- Aggregated fields (computed from child rows) are marked with `// AGGREGATED —`.
  Examples: `campaigns.statsSent` etc. Update only via the dedicated
  aggregator — for campaign send stats this is the Send lifecycle's effect
  system (`campaign_stats_sent` / `campaign_stats_failed` etc. in
  `delivery/sendLifecycle.ts`); never write these from a user-facing
  mutation. Track freshness with `statsUpdatedAt`/`cachedCountUpdatedAt`.

### Cascade contracts
Parent tables document their cascade-on-delete contract in the schema header
comment (see `schema/contacts.ts`). Permanent-delete helpers in
`lib/contactMutations.ts` are the only place that performs the cascade —
mutation code calls the helper rather than handling children inline.

### Audit logging
Use `recordAuditLog` from `lib/auditLog.ts`. Never call
`ctx.db.insert('auditLogs', ...)` directly — the helper is the only place
the action/resource literal union is validated against the schema. Every
state-changing mutation on a primary table (campaigns, contacts, topics,
emailTemplates, automations, segments, settings, apiKeys, webhooks,
domains, blocklist) should emit an audit log. See
`docs/audit-log-actions.md` for the action catalog and expected
`details` / `detailsBlob` shapes.

### Embeddings
Every embedding-bearing row (`knowledgeEntries`, `semanticFiles`) MUST
record `embeddingModel: v.string()` and `embeddingGeneratedAt: v.number()`.
Switching models or bumping the model version triggers a re-embed —
the timestamp gates which rows are stale.
