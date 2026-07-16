# Plugin platform contract — one manifest and host-mediated services

**Status:** accepted

## Context

Owlat already implements its major variation points as typed module registries:
Block modules, Agent step modules, Send provider adapter modules, Automation
modules, Webhook event modules, and Integration import provider adapter modules.
Those registries are composed by static imports. Their individual interfaces are
strong, but there is no package-level contract for an operator to add several
modules as one extension, no common capability declaration, and no safe service
surface for extension code.

Convex bundles backend functions at deploy time and does not load arbitrary code
at runtime. Treating that constraint as a trust boundary is safer than inventing
a dynamic loader. At the same time, connected services and isolated worker jobs
need a contract that does not expose Convex internals or ambient credentials.

The platform needs a stable outer boundary before any existing registry is
opened. Freezing every contribution's concrete module interface in that first
change would be speculative: each registry has different runtime, validation,
ordering, and safety rules that its dedicated migration must preserve.

## Decision

Add `@owlat/plugin-kit` as the public compatibility boundary. Its package major
version is the compatibility line; contribution interfaces do not carry their
own versions. Before 1.0, contracts may break with the application. During that
pre-1.0 period the package follows Owlat's unified repository version and is
cut by the existing release command.

### One validated manifest

Each plugin exports one manifest created with `definePlugin`. The manifest
declares:

- a lowercase kebab-case `id`, used to namespace flags, storage, spend, and
  audit attribution;
- a semantic `version`;
- requested `capabilities`;
- contribution buckets from the platform catalog;
- optional flag prerequisites, daily LLM budget, and a bundled Convex component
  package export.

`definePlugin` preserves literal TypeScript inference and validates at runtime.
The non-throwing `validatePluginManifest` and throwing `parsePluginManifest`
forms serve codegen and CLI callers. Validation rejects unknown metadata,
accessor properties, malformed identifiers, duplicate capabilities and env
requirements, invalid budgets, and unknown contribution buckets. It validates
only the contribution container in this ADR; the host and each consumer seam
validate the concrete contribution definitions when those seams open.
To keep validation bounded at the public unknown-input boundary, a manifest may
declare at most 64 capabilities, 64 required environment variables, and 256
entries in each contribution bucket.

Validation inspects component and contribution references as data and never
invokes them. Component exports are imported statically by generated Convex
composition, so the framework can discover their isolated namespaces during
bundling. Build-time composition remains the only path that imports bundled
code.

### One static composition config

The checked-in root `plugins.config.ts` is the single source of bundled plugin
membership. It contains only a literal package-name list and is parsed as data;
codegen never evaluates the config module. Each entry must be a safe exact npm
package name installed directly as a production or optional root registry
dependency. Codegen verifies the installed package identity, Bun lock integrity,
and realpath containment; aliases, git/URL/file/workspace sources, and external
symlinks fail closed. A plugin's default manifest must use one
condition-independent root package export string, so Bun, Convex, Nuxt SSR, and
the Nuxt browser build cannot select different manifests. Codegen imports those
explicitly installed packages, validates one immutable manifest snapshot,
rejects duplicate package names and manifest ids, and orders the result by
manifest id using code-point order.

The generator emits checked-in Convex and Nuxt composition modules that both
pass manifests through the host composition contract, plus a Convex-only
installer that statically imports each declared component export and installs
it under an injective `plugin_<id>` namespace. CI and the build graph run the
generator in non-writing check mode, and a package-boundary lint rejects core
imports of configured plugin packages outside the generated composition files,
including Node/Bun loaders and repository aliases. The zero-plugin
composition remains a valid no-op deployment. Generated module specifiers are
branded and revalidated package names encoded as JavaScript strings. Output is
written through adjacent random exclusive temporary files before atomic rename;
generated targets and parent directories may not be symbolic links.

### Capabilities are requests; grants are permissions

A manifest's `PluginCapability[]` states which host operations the plugin may
request. An operator's `PluginCapabilityGrant[]` records which requests are
allowed for an installation. Hosted code receives `PluginPermissionService`
and must pass its checks at call time. Declaring a capability never grants it.
The host will also reject contribution types whose required capability was not
declared.

Capability names use a lowercase `domain:action` namespace with exact-match
semantics. Wildcards are not part of the contract. The namespace is open so a
new contribution seam does not require a plugin-kit major solely to add a
capability literal; the host remains the authority that recognizes and enforces
capabilities.

### Plugins receive services, not framework contexts

Plugin handlers receive a `PluginContext` made only from host-mediated services:

- namespaced JSON storage;
- metered LLM text generation through Owlat's LLM dispatch;
- structured logging;
- named-task scheduling;
- permission checks.

The public context does not expose a Convex `ctx`, database handle, environment
variables, raw model objects, or arbitrary scheduler function references. This
keeps the contract usable across the three execution tiers and leaves tenant
isolation, spend attribution, scrubbing, quotas, and audit enforcement with the
host.

### Component and storage isolation

A bundled manifest declares a condition-independent Convex component package
export as data. Codegen verifies that installed export and emits a static
`app.use` registration under an injective `plugin_<id>` namespace. Installing
or removing a component therefore changes the checked-in composition and
requires a rebuild; no backend module is loaded dynamically.

The host-mediated JSON KV service is a separate boundary for connected code.
Its methods accept keys and values, never tenant or plugin scope. The host binds
the service to the authenticated organization and validated registered plugin,
then rechecks the plugin flag and exact `plugin-storage:read` or
`plugin-storage:write` grant for every operation. Entries are indexed by
organization, plugin, and key; canonical versioned JSON and UTF-8 keys are
bounded, paginated cursors are authenticated-encrypted and scope-bound, and
exact entry/byte quota counters update in the same Convex transaction as each
write. Because access cannot be enabled or revoked honestly without a flag,
manifest validation requires an explicit flag whenever either plugin-storage
capability is declared; flags remain optional without storage. Tier-2 API key
and HTTP surfaces remain deferred to their dedicated changes.

### Hosted-action audit and LLM budgets

Every successful host-service operation writes the existing tenant audit log
with explicit `organizationId` and `pluginId` attribution. Storage audit rows
record only a fixed operation name and outcome; keys, values, prefixes, and
cursors never enter the audit boundary. Plugin LLM rows likewise allow only
bounded counters and fixed reason codes. Prompts, messages, generated text,
provider errors, credentials, and arbitrary caller metadata are forbidden.
The operator surface remains admin-only and validates plugin filters. Legacy
core rows without organization attribution remain instance-global under
Owlat's enforced single-organization deployment invariant.

`llm:invoke` requires both an explicit plugin flag and a validated manifest
daily budget. The host authorizes before resolving tenant provider config, then
rechecks registration, flag, declaration, operator grant, and budget in the
same transaction that reserves spend immediately before dispatch. Requests are
bounded to 64 KiB of UTF-8 input, 32 messages, and 2,048 output tokens. Only
exact model identities in a provider-specific admission catalog are accepted.
The resolver also supplies a secret-free endpoint provenance: native catalog
pricing is trusted only for the provider's built-in endpoint, while every
explicit base URL, Azure deployment, compatible/local server, or unknown
provider fails closed. OpenRouter has its own exact namespaced catalog.

Money enforcement uses integer micro-USD. `chargedMicrousd` is consumed daily
headroom: pending maximums, ambiguous-failure maximums, and settled successful
charges. `actualMicrousd` is known priced usage from valid successes;
`admittedCallCount` counts atomic admissions, including calls that later fail.
A reservation covers every retry allowed by the shared dispatch policy.
Success releases unused headroom but retains a maximum for each failed attempt
before the successful one. Missing or malformed usage, provider failure,
action crash, or accounting failure retains the conservative reservation
through that UTC day. The reservation persists its admitted model and endpoint
provenance; if a provider reports a different model, settlement retains the
full reservation and records no priced usage. Missing or malformed raw provider
identity is treated the same way; the dispatcher never substitutes the requested
model or the AI SDK's requested-model fallback. This availability tradeoff never
reopens spend the provider may have billed.

### Bundled send transports

A bundled plugin may declare `contributes.sendTransports` only with an explicit
feature flag and the `send:transport` capability. Each data-only descriptor has
a local kebab-case id, label, bounded host-owned retry schedule, and one
condition-independent package export. The stored provider kind is namespaced as
`plugin.<pluginId>.<localId>` so plugin and core kinds cannot collide.

Codegen verifies the export without executing it, emits an isolate-safe metadata
catalog, and emits executable imports in a separate `'use node'` registry. A
transport module exposes only `parseExtras(unknown)` and a single-attempt
`send(params, extras)` operation. The host validates the exact module and result
shapes, normalizes message attachments and typed failure codes, owns retries,
and never exposes environment values, Convex contexts, routing state, health
state, or audit writers to plugin code.

Immediately before every network attempt, a mutation rechecks the singleton
organization, bundled registration, enabled flag, manifest declaration, exact
operator grant, and required environment-variable presence. The generic plugin
host then mediates the call. Denial never invokes plugin code. Terminal outcomes
schedule one health update and one audit entry containing only system
attribution, outcome, and attempt count; message content, recipient data,
provider ids, raw errors, and credentials are excluded. Authorization denial is
recorded as `access_denied` in the authorization transaction together with the
number of completed prior attempts.

The composed provider catalog is the authority for route reads and writes.
Reads skip unavailable or retired providers and apply the same readiness rule
to the environment fallback. Writes reject unknown, duplicate, or enabled-but-
unavailable providers. The operator UI reads the backend catalog, preserves
stale route entries as unavailable for display, and omits those unregistered
kinds from canonical write payloads without reordering or enabling surviving
entries. It treats unknown plugin authentication alignment conservatively. The
built-in MTA, SES, Resend, and SMTP adapters keep their existing order, retry
counts, routing selection, health behavior, and ambiguous-timeout semantics
behind the same dispatch seam.

### Bundled agent pipeline steps

An agent-step contribution requires an explicit feature flag and the
`agent:step` capability. Its manifest descriptor declares a local id, insertion
anchor, condition-independent module export, and zero or more requested
lifecycle edges. Codegen namespaces the kind as
`plugin.<pluginId>.<localId>`, verifies the export without executing it, emits a
pure catalog plus a separate Node module registry, and rejects duplicate or
unknown kinds, terminal anchors, insertion cycles, and unsafe edges.

The six built-in steps map to three host-owned plugin placements with
restrict-only edge policies. Security scan, context retrieval, and classify
form the `classification` placement; their descendants continue from
`classifying` and may only archive or fail. Clarify forms the `before_draft`
placement; its descendants continue from `drafting` but may only archive or
fail because no draft is guaranteed to exist yet. Draft forms the `after_draft`
placement; its descendants continue from `drafting` and may archive, fail, or
request the `drafting` to `draft_ready` review edge. A plugin chained after
another plugin inherits its placement. No plugin may request `approved` or
`sent`, choose the next step, run before the security scan, or edit the core
`LEGAL_EDGES` graph.

Immediately before execution, the host rechecks singleton scope, bundled
registration, enabled flag, manifest capability, exact operator grant, and
required environment presence. Denial skips the disabled contribution and
resumes the unchanged core continuation without invoking plugin code. An
authorized module receives a bounded, unsealed message projection rather than
a Convex context. Its result is descriptor-safe bounded JSON and either
`continue` or a declared `caution`; invalid output, an undeclared edge, or an
exception fails the inbox lifecycle closed. Agent-action rows and redacted
`agent.step` audit rows remain host-owned.

### Bundled draft strategies

Draft contributions require a feature flag and `draft:strategy`. Static codegen
separates their data-only catalog from Node modules and namespaces each kind.
Selection is contact, then mailbox, then classification, then `default`.

Only primary generation is replaceable. The host retains assembled-context
injection scanning, quality self-check, review options, persistence, routing,
autonomy, and sending. Modules receive a frozen bounded projection and optional
attributed/budgeted LLM service, never a Convex context. Last-moment denial,
timeout, failure, malformed/oversized/injection-like output, and stale selection
all conservatively fall back to `default`. See ADR-0050.

### Three execution tiers

1. **Bundled plugins** are operator-installed packages composed at build time.
   They may contribute backend and frontend modules and may ship an isolated
   Convex component. Runtime feature flags can disable them; install or removal
   requires a rebuild.
2. **Connected apps** run out of process and use scoped APIs, webhooks, and
   signed synchronous hooks. They do not execute code inside Convex or Nuxt.
3. **Sandboxed workers** handle untrusted or resource-heavy compute behind an OS
   process boundary and return data through host-controlled task interfaces.

The same capability vocabulary and host-service principles apply to all tiers;
execution-specific registration is implemented in later ADRs.

## Consequences

- Plugin authors have one importable public package and one manifest format.
- Codegen can reject malformed packages before editing generated composition
  files, while runtime host checks remain authoritative.
- Framework internals stay private and can evolve without becoming plugin API.
- Each contribution migration can define and test its honest module interface
  without expanding this kernel speculatively.
- Bundled plugin code has the same trust as the operator's deployed code. The
  manifest is not a sandbox; capability and service wrappers reduce authority,
  while untrusted code belongs in a connected app or sandboxed worker.

## Non-goals

- Runtime loading of arbitrary JavaScript into Convex or the browser.
- A marketplace, separate signing system, or instant install for bundled code.
- Concrete module definitions, ordering, registry wiring, or conformance
  harnesses; each lands with its consumer
  seam in the plugin-platform sequence.
- Native Tauri menus, shortcuts, or a generic IPC extension bridge.
