# Escalation Guard — Tier-1 reference plugin

A worked example of a **bundled** Owlat plugin (Tier 1): it ships inside the
Owlat build, its contributions are resolved by the generated composition at
codegen time, and it makes no outbound call and runs no sandboxed job.

Together with `../deliverability-lab` (Tier 3 sandboxed jobs) and
`../slack-approvals` (Tier 2 connected app) this is the maintained
one-plugin-per-tier gallery. It is the reference that covers the Tier-1
contribution points the other two do not.

## What it does

It notices escalation-shaped inbound mail — legal threats, regulators,
chargebacks, cancellations, formal complaints — from one deterministic detector
(`src/detector.ts`), then uses that verdict across every Tier-1 contribution
bucket:

| Contribution           | Module                  | Effect                                                          |
| ---------------------- | ----------------------- | --------------------------------------------------------------- |
| `agentSteps`           | `./agentStep`           | Routes an escalation reply to a human instead of auto-sending   |
| `draftStrategies`      | `./draftStrategy`       | Writes a conservative acknowledgement via the host LLM dispatch |
| `automationTriggers`   | `./automationTrigger`   | Starts an automation when an escalation is raised               |
| `automationConditions` | `./automationCondition` | Branches on whether the contact is a priority account           |
| `automationSteps`      | `./automationStep`      | Blocks a run until the contact has a named escalation owner     |
| `webhookEvents`        | `./webhookEvent`        | Publishes `plugin.escalation-guard.escalation-raised`           |
| `navItems`             | manifest only           | An "Escalations" entry in the core Inbox section                |
| `settingsPanels`       | manifest only           | A settings entry rendered from the declared `settingsSchema`    |

## Why it is safe

- **It can only restrict.** The agent step returns `continue` or a `caution`
  whose single target is `draft_ready` — the "a human reviews this" edge. That
  is the only lifecycle edge the manifest declares, the host re-checks the
  request against the declaration, and nothing the step returns can send,
  approve, or skip a core step.
- **A plugin automation step cannot force a run forward.** The step contract
  admits `completed` and `failed` only; `failed` is retried by the host exactly
  like a thrown error, and the host owns every branch.
- **Untrusted input is parsed strictly.** All three automation modules validate
  their operator-persisted config in `parseConfig` — plain objects only, no
  getters, no inherited properties, bounded lists — and throw on anything else.
  A throwing condition does not take the priority branch.
- **Untrusted output is clamped.** Model completions are control-stripped and
  length-clamped before they become a draft body, and an unusable completion
  throws so the host stays on its own core strategy.
- **No ambient credentials.** LLM access is the injected `services.llm` host
  dispatch: no provider key, no model name, attribution to this plugin, and the
  manifest's hard daily budget.
- **Off by default.** `flag.default` is `false`, so an operator opts in; until
  then the plugin contributes nothing.

## Wiring it up (operator)

Add the published package to `plugins.config.ts` (`owlat-plugins add <package>
--dry-run` previews the capability diff first), run `owlat-plugins
codegen`, enable the `plugin.escalation-guard` flag, and grant the capabilities
you want. Removing the package and re-running codegen removes every
contribution again; the stored settings survive so a re-add is lossless, and the
plugin settings screen offers to purge them.

The declared `settingsSchema` is a **declaration only**. The host renders,
validates, persists and redacts those fields, but there is no channel from
plugin settings into a bundled module: an agent step is `execute(input)`, and an
automation module is handed the automation's own persisted
`step.config.pluginConfig` through its `parseConfig`. Behaviour that must differ
per build is composed at build time instead —
`createEscalationAgentStep({ minimumLevel })` — which is what each field's
description says.

## Tests

```sh
bun run --cwd examples/plugins/escalation-guard test
bun run --cwd examples/plugins/escalation-guard typecheck
```

The cross-tier lifecycle and pipeline-replay suites for all three references
live in `examples/conformance`.
