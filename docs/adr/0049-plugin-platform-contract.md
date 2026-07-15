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
own versions. Before 1.0, contracts may break with the application.

### One validated manifest

Each plugin exports one manifest created with `definePlugin`. The manifest
declares:

- a lowercase kebab-case `id`, used to namespace flags, storage, spend, and
  audit attribution;
- a semantic `version`;
- requested `capabilities`;
- contribution buckets from the platform catalog;
- optional flag prerequisites, daily LLM budget, and bundled Convex component
  loader.

`definePlugin` preserves literal TypeScript inference and validates at runtime.
The non-throwing `validatePluginManifest` and throwing `parsePluginManifest`
forms serve codegen and CLI callers. Validation rejects unknown metadata,
accessor properties, malformed identifiers, duplicate capabilities and env
requirements, invalid budgets, and unknown contribution buckets. It validates
only the contribution container in this ADR; the host and each consumer seam
validate the concrete contribution definitions when those seams open.

Validation inspects component and contribution references but never invokes
them. Build-time composition remains the only path that imports bundled code.

### Capabilities are requests; grants are permissions

A manifest's `PluginCapability[]` states which host operations the plugin may
request. An operator's `PluginCapabilityGrant[]` records which requests are
allowed for an installation. Hosted code receives `PluginPermissionService`
and must pass its checks at call time. Declaring a capability never grants it.
The host will also reject contribution types whose required capability was not
declared.

Capability names use a lowercase `domain:action` namespace. The namespace is
open so a new contribution seam does not require a plugin-kit major solely to
add a capability literal; the host remains the authority that recognizes and
enforces capabilities.

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
