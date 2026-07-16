# ADR-0050: Host-owned draft strategy registry

## Status

Accepted.

## Context

The shared-inbox agent and personal Postbox already call one function,
`runSharedDraft`. It combined primary generation with the safety and review
envelope: assembled-context injection scanning, quality self-check, alternative
review drafts, and consumer-owned persistence. Making the whole function
replaceable would let an extension omit those controls and would leak AI SDK
models, tool sets, or a Convex action context as public API.

Draft selection must also be deterministic and safe when configuration outlives
an installed plugin. Connected-app execution is not available yet, so this
change defines its failure boundary without inventing HTTP credentials, signing,
or callback infrastructure owned by later connected-app work.

## Decision

`runSharedDraft` remains the host-owned orchestrator. Its deliberate host
contract is `SharedDraftParams` to `SharedDraftResult`; both existing consumers
continue through it. Only primary draft generation is a strategy. The built-in
`default` strategy is the previous generation path, including its model, tools,
message shape, temperature, and attribution behavior.

The execution order is fixed:

1. Re-scan the complete assembled inbound context for prompt injection.
2. Resolve one configured strategy.
3. Reauthorize and invoke a custom strategy, or fall back once to `default`.
4. Run the host quality self-check.
5. Generate host review options when confidence or quality requires them.
6. Return to the existing consumer, which owns persistence and routing.

Autonomy gates, review, persistence, and sending remain outside every strategy.
A strategy can return only a draft body and cannot approve, persist, route, or
send mail.

### Public plugin contract

A bundled plugin declares a data-only descriptor with local id, label, static
module export, and a host-enforced timeout. Codegen emits an isolate-safe catalog
and a separate Node executable registry. Kinds are namespaced as
`plugin.<pluginId>.<localId>` and require an enabled feature flag plus an explicit
`draft:strategy` grant.

The module receives a copied and frozen, size-bounded projection: surface,
assembled context, trusted confirmed facts and stance, sanitized classification,
and host presentation guidance. It never receives tenant ids, credentials,
models, tools, or a Convex context. Optional LLM work goes through the existing
host service and separately requires `llm:invoke`; admission, fixed-point budget
reservation, settlement, provider dispatch, and audit are system-attributed and
rechecked at call time.

The host accepts only one own enumerable `draftBody` string. Empty, oversized,
accessor-bearing, extra-field, or injection-like results are invalid. Denial,
timeout, exception, invalid output, and missing executable registration all
fall back to `default`. Audit rows contain only fixed operation/outcome/reason
taxonomy and plugin attribution, never mail text, drafts, prompts, provider
errors, secrets, or selection ids.

### Selection

Selections are dedicated organization-scoped rows. Precedence is:

1. contact
2. mailbox
3. classification category
4. `default`

Writes require settings administration, validate the referenced mailbox/contact
and a currently registered strategy, and upsert one row per scope. Selecting
`default` removes the override. Runtime reads retain stale kinds deliberately;
the executable registry and last-moment authorization are authoritative, so an
uninstalled, disabled, revoked, or environment-incomplete strategy safely falls
back without rewriting operator intent or leaking across organizations.

Postbox currently supplies mailbox plus the neutral `other` category. The
shared-inbox path supplies CRM contact plus its sanitized category. Postbox mail
contacts and CRM contacts are not conflated.

Tier-2 connected strategies will enter this same timeout, validation, and
fallback boundary when signed synchronous hooks exist. This ADR does not add a
network adapter, endpoint field, secret, or retry policy ahead of that work.

## Consequences

- Default behavior remains a directly testable conformance fixture for both
  consumers.
- Plugin failures reduce customization, never the safety or review envelope.
- Background plugin LLM calls use the same grants, pricing, daily budget, and
  redacted audit guarantees as authenticated plugin calls.
- Selection is deterministic and stale configuration is non-blocking.
- Retrieval extensions and autonomy-gate plugins remain separate later seams.
