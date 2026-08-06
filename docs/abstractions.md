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
| `EmailProvider` (domain identity/verification) — **legacy, superseded** by the sending-domain provider registry below; there is no `EmailProvider` interface left in the tree. Write a `domains/providers/<kind>/` adapter, never an implementation of this row. | — | — | `emailProviders/{sesIdentity,mtaIdentity}.ts` survive as the two provider identity API clients those adapters call; `domainVerification.ts` is From-address helpers only |
| Send providers (delivery dispatch + health + routing) | per-org config | `mta`, `ses`, `resend`, `smtp`, `mandrill` | `sendProviders/` |
| `LLMProvider` | `LLM_PROVIDER` (openai) | OpenAI-compatible endpoints (OpenAI, OpenRouter, Ollama, Claude-via-compat) | `llmProvider.ts` |

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

**But registering an adapter is not yet the whole wiring.** `domains/lifecycle.ts`
still carries `providerType` branches of its own, and one of them decides
whether a new adapter is reached at all: the forward relay-identity
provisioning (the `provision_relay_identity_if_enabled` effect) is a
hand-written list of relay kinds, so a fourth kind's `ensureRelayIdentity` is
called by the catch-up drain in `providerRoutes.ts` and by nothing on the
forward path — domains verifying after that point silently get no identity. The
return-path branches in the same file are the same family. Clearing them is the
seams plan's P0.4 leak sweep; until it lands, read that file when you add a
kind.

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
keep the MTA's and SES's. They are *written* only through their own adapters —
but SES/MTA-shaped **readers** still sit outside `domains/providers/`, the
largest being `providerRoutes.listDeliverabilityRelayDomains`, which reports the
relay DNS status the web UI renders and is carried into P1.2 together with
`RelayDomainStatus.vue`. Do not read "encapsulated" here.

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
