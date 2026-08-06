# Abstraction Surface

Single source of truth for the provider/adapter interfaces in Owlat. Every
external dependency we want to keep swappable lives behind one of these.
When adding a new backend (Bedrock, Twilio, Mailgun, …), write an adapter
file alongside the existing one — never reach for the SDK directly from a
feature module.

## Pattern

Each abstraction follows the same shape:

```
lib/<providers>/
├── types.ts        — interface, type aliases, shared helpers
├── <name>.ts       — concrete implementations (one per backend)
└── index.ts        — factory that reads an env var and returns the cached instance
```

Factories cache the resolved provider per-process. Tests can call
`clear*ProviderCache()` between cases to swap env.

---

## Providers in apps/api (`apps/api/convex/lib/`)

| Interface | Env var | Implementations | Files |
|---|---|---|---|
| `EmailProvider` (domain identity/verification) — **legacy, superseded** | `EMAIL_PROVIDER` (mta) | see `domains/providers/` below | `emailProviders/{sesIdentity,mtaIdentity,domainVerification}.ts` |
| Send providers (delivery dispatch + health + routing) | per-org config | `mta`, `ses`, `resend`, `smtp`, `mandrill` | `sendProviders/` (adapters) + `packages/shared/src/sendProviderCatalog.ts` (the catalog) |
| `LLMProvider` | `LLM_PROVIDER` (openai) | OpenAI-compatible endpoints (OpenAI, OpenRouter, Ollama, Claude-via-compat) | `llmProvider.ts` |

The first row is **history, not a seam to implement**: there is no `EmailProvider`
interface left in the tree. Its job moved to the sending-domain provider registry
([below](#sending-domain-identity-providers)), so write a
`domains/providers/<kind>/` adapter, never an implementation of that row. What
survives under `emailProviders/` is what those adapters call:
`sesIdentity.ts` / `mtaIdentity.ts` are the two provider identity API clients,
and `domainVerification.ts` holds the From-address helpers **and** the
`domains`-table verification gate (`isDomainVerified`,
`isDomainVerificationFresh`, `validateDomainForSending`,
`getDomainVerificationStatus`) that the send path checks before a campaign goes
out. `EMAIL_PROVIDER` stays on the row because it is still what picks a newly
created domain's `providerType` — see the section below.

The send-provider seam is deliberately **two halves**. The DATA half — what each
kind is, needs and can do (`kind`, `label`, `tier`, `requiredEnvVars`,
`optionalEnvVars`, `credentialFields`, `supportsCustomReturnPath`,
`hasProviderFeedback`, `providerFeedback`, `domainVerification`, `retryDelays`,
the dispatch semantics, `setupProbe`) — is `packages/shared/src/sendProviderCatalog.ts`, a
leaf module with no adapter code and no secrets, so `apps/web`, `apps/setup-cli`
and the docs suite read the same declaration the backend does. The kind union
(`SEND_TRANSPORT_KINDS`), the setup surfaces' `DELIVERY_PROVIDER_KINDS`,
`getSendPathRequiredEnv`, `PROVIDER_ENV_KEYS` and the SMTP relay presets are all
derived from it rather than restated — before the seams plan's P1.1 they were
five independent declarations. The CODE half —
`apps/api/convex/lib/sendProviders/catalog.ts` — joins those entries to the
adapter modules and to the bundled plugin tier, and owns the kind-keyed
accessors that resolve against the COMPOSED catalog. Those accessors are a
lookup plus a rule, and only the lookup is the backend's: each field's
fail-closed default (`hasProviderFeedback` absent ⇒ `false`,
`acceptanceSemantics` absent ⇒ `unknown-on-timeout`, …) is applied by the shared
module's `…Of(entry)` functions, so web and the CLI get the same reading from
their own core-only lookup. `tier: 'own'` is likewise read through
`isOwnSendProviderKind` rather than compared to a literal — the one identity
question D3 sanctions, asked in the one place that declares the answer. Adding a
provider means adding an entry, not editing a table somewhere else; the
accompanying `bun run lint:providers` ratchet parses its kinds out of that same
literal.

Send providers additionally take **operator-installed** implementations: a
bundled plugin contributing a `sendTransports` entry appears as the kind
`plugin.<pluginId>.<localId>`, catalogued at
`convex/plugins/sendTransportCatalog.generated.ts` and adapted to the same
`SendProviderModule` interface by `sendProviders/pluginProvider.ts`. Dispatch,
retries, health and routing stay host-owned; see the [plugin contribution
reference](../apps/docs/content/3.developer/42.plugin-contributions.md).

Speculative single-implementation seams (auth, storage, analytics,
notifications, vector stores) have been **deleted**, per the project's
deletion-over-seams rule: a provider directory exists only once a second
real implementation (or a real caller) does. Re-introduce one by following
the Pattern above when that day comes — don't keep empty sockets around.

### Sending-domain identity providers

`SendingDomainProviderModule` (`apps/api/convex/domains/providers/`) — a
registry keyed by `domains.providerType`, one adapter folder per kind (`mta`,
`ses`, `mandrill`). It owns everything provider-specific about a *sending
domain*: registering the identity at the provider, the DNS records to publish,
the provider-side verification check, and — for relays — the proof the
deliverability fallback reads before handing a From domain over. Every piece of
that work is dispatched through `providerFor(kind)`.

Which kind a *newly created* domain gets is still an env decision:
`domains/lifecycle.ts` reads `EMAIL_PROVIDER`, narrows it through
`isSendingDomainProviderKind` (the registry's own guard, so an unrecognized
value is not a crash) and falls back to `mta`. Registering an adapter therefore
makes a kind *reachable*; naming it in `EMAIL_PROVIDER` is what makes new
domains use it.

**But registering an adapter is not yet the whole wiring.** Relay-identity
provisioning is: both the forward path (a domain reaching `verified`) and the
catch-up drain walk this registry and ask `ensureRelayIdentity`, so a newly
registered kind is on both the moment it registers (the seams plan's P0.4).
What `domains/lifecycle.ts` still carries `providerType` branches for is the
RETURN-PATH family — which `mailFrom` bundle a custom return-path host
publishes, and which reflection action pushes it to the provider — and a new
kind silently gets neither. That capability has no home on the adapter
interface yet. It is one of the surviving families of kind literals, and the
families are DATA rather than prose, split by what the literal is. A kind
*declaration* (`const X = 'ses'`) is enumerated by `SURVIVING_KIND_LITERALS` in
`apps/api/convex/lib/sendProviders/__tests__/kindLiteralCustody.test.ts`, with
its family and its owner; a *comparison* — the return-path branches included —
is enumerated by the ratchet's allowlist below. Both fail in both directions:
an unenumerated literal fails, and an entry whose literal has been swept fails
until it is deleted.

The comparison half is `bun run lint:providers`
(`scripts/check-provider-identity.sh`), the CI gate that carries the rule across
`apps/`, `packages/` and `examples/`: no comparison against a kind literal —
`===`, `==`, `case`, or membership (`kinds.includes('ses')`,
`kinds.indexOf('ses') !== -1`, `['ses', 'resend'].some(…)`) — outside an
adapter bundle. `examples/` is in scope because it is a workspace root and the
home of the plugin tier, whose whole promise is that a provider ships without
host edits. An "adapter bundle" is a kind-named directory directly under
`lib/sendProviders/`, `domains/providers/`, `integrationImports/providers/` or
`webhooks/adapters/` — anchored to those roots rather than to any path segment
that spells a kind, so a per-vendor folder of UI panels still fails. Also out of
reach on purpose: `apps/mta` (its `'mta' | 'relay' | 'defer'` routing decisions
are its own alphabet, not the catalog's), `migrations/` (frozen replays, pinned
to the kinds of their date), tests (`__tests__/`, `*.test.*`, `*.spec.*` and the
Playwright tree `e2e/`, whose page objects are scaffolding for specs that are
already exempt), and generated code. A module merely *named* `fixtures.ts` ships,
so it is scanned like any other source. Matching runs over a three-line window,
so reformatting a long condition or a long membership array does not de-fang it,
and the comment stripper tracks string literals — a `//` in a doc link or a `*/`
in a glob is not a comment, and reading one as a comment is how a text gate goes
quietly blind.

Two checked-in files license the rest, both strict in both directions so they
can only shrink: `scripts/provider-identity-allowlist.txt` is debt, written once
per entry under a family header naming the piece that deletes it, and its entry
count is what "zero identity checks" is measured against;
`scripts/provider-identity-collisions.txt` is the permanent set where the
spelling belongs to a different vocabulary (the MTA routing API's answer, a
docker compose profile, the contact-import registry) and there is no coupling to
remove. Entries are `path` or `path:literal`; collision entries must be
qualified, because a permanent whole-file licence would excuse a real kind
branch added to that file years later.

The two checks are disjoint, not overlapping: declarations in the backend belong
to the vitest one, comparisons everywhere belong to the ratchet, and neither
list is derived from or restated in the other.

Which seams a kind must implement is declared, not assumed: the send-provider
catalog's `domainVerification: 'api' | 'none'` field is the promise. For a
**core** kind, declaring `api` must both register an adapter here and implement
the three relay seams (`RelayProvingProviderModule`) — both are compile errors
otherwise. A bundled plugin transport's generated catalog entry is untyped, so
it gets neither error; the runtime seam stays fail-closed (an unregistered kind
is unverifiable, never credited with another provider's proof) and the type-level
half is the seams plan's P3.2.

Where a kind's identity row lives depends on when the kind arrived. Anything
added after MTA and SES writes to the generic, org-scoped
`sendingDomainRelayIdentities` table — Mandrill does. The two per-provider
sibling tables (`sendingDomainMtaIdentities`, `sendingDomainSesIdentities`) are
frozen: no third sibling is ever added, no new kind gets rows there, and they
keep the MTA's and SES's.

**Neither half of that access is encapsulated yet.** Each adapter has
`writeIdentity` / `clearIdentity`, but the SES relay provisioning does not go
through them: `sesRelay.provision` (the action the SES adapter's own
`ensureRelayIdentity` schedules) calls `sesRelayMutations.storeProvisioning`,
which inserts into `sendingDomainSesIdentities` from outside `domains/providers/` —
so the pattern to mirror for relay kind #4 is an out-of-adapter
`<kind>RelayMutations.ts` plus a scheduled `provision` action, not an adapter
method. `sendingDomainMtaIdentities` has out-of-adapter writers too
(`devShortcuts/forceVerifyDomain.ts`, the demo seed). And SES/MTA-shaped
**readers** sit outside the adapters as well, the largest being
`providerRoutes.listDeliverabilityRelayDomains`, which point-reads the frozen
SES sibling for every domain and therefore reports nothing once the configured
relay is some other kind.

**No piece card owns either half.** P0.4 routed the SCHEDULING of that write
through the adapter (`ensureRelayIdentity`) but left the insert where it is;
folding the insert itself in is unclaimed. Nor is the read. P1.2
(catalog-driven web UI) is its natural home, but that card's scope names the
four Vue files and two composables and neither this query nor
`RelayDomainStatus.vue` — the two have to change together, since the per-kind
identity shapes differ. So the pair is carried into P1.2 as an added input, not
as work someone already signed up for; the query's own docblock says so at
length and is the home for that statement.

### Inbound channel adapters

`@owlat/channels` (`packages/channels/src/inboundRegistry.ts`) — registry
mapping vendor name (`mta`, `resend`, `ses`, `postmark`, `mailgun`) to an
adapter that normalizes the webhook payload into a canonical
`InboundEmailMessage`. Used by `mtaWebhook.ts` and any future inbound source
via `getInboundChannelAdapter(source)`.

---

## Channel adapters (`packages/channels/`)

| Adapter | Outbound | Inbound |
|---|---|---|
| `EmailAdapter` | delegates to email provider | normalizes inbound (legacy MTA shape) |
| `SmsAdapter` | Twilio (stub) | — |
| `WhatsAppAdapter` | Meta (stub) | — |
| `WebhookAdapter` | generic HTTP | — |
| `ChatAdapter` | native Convex | — |

---

## Feature flags & packs (`packages/shared/src/featureFlags.ts`)

The pluggability story isn't just providers — it's also product surfaces.
Every toggleable feature is declared in one place with dependency rules,
docker profile mappings, and required env vars.

### Atomic flags

- 26 flags across categories: sending, receiving, ai, integrations,
  security, deliverability, hosted-only.
- `resolveFlags()` does fixed-point dependency resolution.
- `applyToggle()` cascades on/off through the requirement graph.

### Feature packs

UI grouping over atomic flags. Toggling a pack flips every member.

- `emailClient` = `inbox`, `chat`, `mail.compose`
- `marketing` = `campaigns`, `automations`, `transactional`
- `ai` = `ai`, `ai.agent`, `ai.autonomy`, `ai.knowledge`, `ai.visualizations`

### Where flags are enforced

- **Backend gates** — `assertFeatureEnabled(ctx, flag)` at the top of public
  Convex functions. Implementation: `apps/api/convex/lib/featureFlags.ts`.
- **Frontend nav** — `apps/web/app/layouts/dashboard.vue` reads
  `useFeatureFlag().isEnabled(flag)` to conditionally render sections.
- **Route gates** — pages declare `definePageMeta({ requiresFeature: '…' })`
  and `apps/web/app/middleware/feature.global.ts` redirects to the dashboard
  when the flag is off. Closes the deep-link hole.
- **Docker profiles** — `getActiveProfiles(flags)` maps active flags to
  compose profiles so disabled features don't even start their containers.
- **Setup CLI** — `owlat-setup pack <key> <on|off>` and
  `owlat-setup feature <key> <on|off>` are the operator-facing toggles.

---

## Adding a new backend

1. Read the existing `types.ts` for the abstraction.
2. Create `<name>.ts` next to the current implementations. Export
   `create<Name>Provider()` and a class implementing the interface.
3. Add the new type to the union in `types.ts`.
4. Add a `case` in `index.ts`'s factory switch.
5. If the new backend introduces config — env vars or a feature flag — add
   them to `packages/shared/src/featureFlags.ts` so the setup wizard / CLI
   surface them.
6. Run the package's vitest suite to confirm the factory dispatches.

## Migrating legacy callers

Some modules historically reached for the SDK directly. Each migration is a
mechanical search-and-replace:

```ts
- import { Resend } from 'resend';
- const r = new Resend(process.env.RESEND_API_KEY);
- await r.emails.send({ ... });
+ import { getEmailProvider } from './lib/emailProviders';
+ await getEmailProvider().sendEmail({ ... });
```

Already done:
- `automationStepExecutor.ts` → `getEmailProvider()`
