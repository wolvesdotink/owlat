# ADR-0057: Universal send-provider bundles

## Status

Accepted.

## Context

Owlat's send path already dispatched core and bundled transports through one
adapter contract, but provider contributions were still assembled in parallel.
The browser-safe catalog, transport registry, feedback registry, sending-domain
registry, and setup surfaces each had their own join. That made a provider with
more than one capability a cross-cutting edit and left provenance implicit.

The incumbent integrations also require different webhook authentication and
domain-persistence mechanisms. Treating those differences as reasons for
different provider shapes would preserve the seam leak; letting provider code
authenticate its own webhook would weaken the internet-facing trust boundary.

## Decision

Every outbound provider is contributed as a bundle with a descriptor and
transport plus optional feedback, primary-domain identity, relay-domain
identity, setup, and platform-hook slots. Composition is deterministic and
build-time. Compatibility exports retain the existing provider kinds, transport
ids, environment names, webhook paths, and stored identity tables.

Provenance is supplied by the host registry as `own`, `first-party`, or
`third-party`; it is not a manifest field. The composer rejects an attempted
privilege escalation. Custody, pre-dispatch identity, host-attested feedback
provenance, and platform hooks remain own-only. Primary-domain ownership is not
available to third-party bundles.

Webhook authenticity remains host-owned. A feedback contribution selects one
of the verifier mechanisms implemented by the host and contributes parse-only
semantics. The initial mechanisms are timestamp-bound HMAC, Svix, AWS SNS, and
Mandrill's signed form. Provider code never receives the signing secret or the
decision that a request is authentic.

Domain identity has two explicit roles. Primary identity retains the existing
MTA and SES persistence bridges; relay identity can use the generic relay table.
The physical tables are not unified as part of this architectural conversion.

`@owlat/provider-kit` contains the runtime-neutral vocabulary and composition
guards. `@owlat/plugin-kit` re-exports the safe universal contract while keeping
its existing names compatible. Runtime hosts join descriptors to executable
modules in the runtime where those modules are valid; Node-only transport code
is never pulled into an isolate bundle to obtain catalog data.

## Consequences

- Adding a provider is a bundle contribution rather than an edit to every
  consumer registry.
- Trust and descriptor/module disagreement fail during composition.
- Existing integrations can move one at a time without dual-sending or data and
  provider-console migrations.
- Runtime-specific artifacts remain necessary. “One bundle” is one logical
  contribution and validation pipeline, not one JavaScript module imported by
  both Node and isolate runtimes.
- Provider-specific wire fixtures remain required in addition to universal
  conformance tests.
