# ADR-0053: Sandboxed plugin jobs

## Status

Accepted.

## Context

ADR-0049 named sandboxed workers as the third execution tier and deferred their
registration to a later decision. This is that decision.

Some plugin work does not belong inside Convex: parsing untrusted input, heavy
analysis, anything that can hang or exhaust memory. Convex actions are the wrong
place for it — they share the deployment's credentials and have no OS-level
containment.

Owlat already runs one untrusted executor: the `code-worker` container that
executes inbound-email-driven coding tasks behind a confined-root orchestrator
that drops each untrusted child to a separate unprivileged uid. Building a second
worker would mean a second hardening surface to keep correct. Generalizing the
existing one keeps exactly one place where untrusted compute runs.

## Decision

### One worker, two queues

The `code-worker` container serves both the coding-agent queue and the plugin
task queue. Both run through the same sandbox seam, so there is one hardened
executor to reason about. Compose profiles activate them independently:
`inbox-codetasks` for the coding agent, `plugin-tasks` for plugin jobs.

Enabling the profile is an explicit operator decision. A manifest flag carries
only `default` and `requiredEnvVars`; it does not bring infrastructure up. A
plugin that enqueues without the profile running simply accumulates `queued`
rows.

### Enqueue is the only thing a plugin can do

`worker:enqueue` grants enqueue and nothing else. Claiming, cancelling,
reclaiming, and reading are host and operator operations.

A job kind is `plugin.<pluginId>.<localId>`. Ownership is decided from the string
alone, so a plugin attempting another plugin's job kind is denied without any
lookup. One module owns the kind grammar and the host and the worker both use it,
so the two sides cannot disagree about which kinds are well-formed. The
host-to-worker wire shape is likewise defined once in `@owlat/plugin-kit` and
projected by a single function, so a field rename fails to compile on whichever
side did not follow.

Enqueue fails closed on a disabled, ungranted, or undeclared plugin, a
cross-plugin job kind, an oversized payload, or an exhausted in-flight budget:
nothing is inserted.

### Every budget is host-clamped

Attempts, per-execution wall clock, payload bytes, result bytes, and the
per-(organization, plugin) count of unfinished jobs are all clamped by the host
at enqueue. A plugin can request less; it can never request more. A poison job
terminates as `failed` at the retry ceiling instead of looping forever, and one
plugin cannot monopolize the single worker or the queue's storage.

### The command is host-controlled

A job kind maps to an entry in a registry that lives in the worker image, keyed
by the local job id. The plugin chooses *which* built-in kind to run; it never
supplies the command. The untrusted payload is always passed as a discrete argv
element with `shell: false`, never interpolated into a shell string. Adding a job
kind is a reviewed change to the worker image, not something a plugin package can
introduce.

### The sandbox boundary is a separate uid, not a language feature

Every untrusted child is spawned through one seam that drops to the unprivileged
sandbox uid/gid, runs detached so the child leads its own process group, and runs
with the job environment stripped of every ambient credential. A plugin job never
sees the deployment admin key, the Git token, or the LLM key: the orchestrator
holds those, and a cross-uid kernel boundary prevents the child from reading
`/proc/<orchestrator>/environ` or ptracing it. Any credentialed capability is
mediated by the host over Convex.

Timeouts and cancellations kill the whole process group, so grandchildren cannot
outlive the job. The container drops all Linux capabilities except the three the
confined-root model needs, keeps a read-only root filesystem with writes confined
to a dedicated volume and a size-capped tmpfs, sets `no-new-privileges`, caps
memory, CPU and process count, and sits on an isolated network shared only with
Convex — so a compromised job has no route to the mail or infrastructure tier.

### Cancellation and retries are host-authoritative

A heartbeat loop proves liveness and is how a running job learns of an operator
cancel. A cancelled queued job is marked cancelled at claim and never runs; a
cancelled running job is killed at its next heartbeat; a cancelled job is never
retried. A `running` row whose heartbeat is older than a lease window set
generously beyond the maximum execution budget is reclaimed as abandoned, with
each sweep bounded. Terminal failure reasons are a fixed taxonomy and any error
message is clamped.

Enqueue and every terminal outcome write a `pluginId`-attributed audit row.

## Consequences

- Untrusted plugin compute has an OS-level containment story rather than a
  language-level one, and there is exactly one such executor in the system.
- A Tier-3 job cannot exfiltrate deployment credentials even if it is fully
  compromised, because they are not present in its environment or reachable
  across the uid boundary.
- Plugin job kinds ship with the worker image, so a new kind requires a worker
  release. That is deliberate: the command surface is the sensitive part.
- Enabling a Tier-3 plugin is a two-part operator action — the plugin flag and
  the compose profile. Documentation must make that explicit, because a missing
  profile presents as jobs that never start.

## Non-goals

- Running arbitrary plugin-supplied executables or shell strings.
- A second worker, per-plugin workers, or plugin-controlled concurrency.
- Streaming or interactive jobs; the contract is enqueue, run once within the
  clamped budget, report a bounded result.
