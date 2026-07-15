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
- Concrete module definitions, ordering, registry wiring, component storage,
  LLM spend enforcement, or conformance harnesses; each lands with its consumer
  seam in the plugin-platform sequence.
- Native Tauri menus, shortcuts, or a generic IPC extension bridge.
