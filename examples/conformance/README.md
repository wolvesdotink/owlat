# Plugin conformance gallery

The final conformance gate for the Owlat plugin platform. It drives the three
maintained reference plugins — one per trust tier — through the **shipped** host,
codegen and CLI, and asserts the properties that make them a reference set
rather than three unrelated demos.

| Tier | Reference                       | What it proves                                           |
| ---- | ------------------------------- | -------------------------------------------------------- |
| 1    | `../plugins/escalation-guard`   | Bundled, in-process contributions and the agent pipeline |
| 2    | `../plugins/slack-approvals`    | A connected app over the signed synchronous hook         |
| 3    | `../plugins/deliverability-lab` | A sandboxed worker job, plus a restrict-only send gate   |

## Suites

- **`gallery.test.ts`** — coverage and ceiling invariants: exactly one reference
  per tier, every manifest valid, every reference off by default, no duplicate
  ids/hrefs/event kinds, every contribution bucket paired with the capability it
  needs, an LLM budget exactly when `llm:invoke` is requested, grants that can
  only narrow, and nav items that target real core sidebar sections.
- **`lifecycle.test.ts`** — clean install, `add`, `remove`, disable and upgrade,
  each run against a real disposable deployment. `@owlat/plugin-cli` rewrites a
  real `plugins.config.ts` (including `--dry-run` capability previews) and
  `@owlat/plugin-codegen` regenerates the real composition. Covers idempotent
  no-ops, staleness detection, an add/remove round trip returning byte-identical
  generated files, and the refusals: uninstalled package, tampered lockfile
  integrity, duplicate manifest id, invalid upgraded manifest, malformed
  package argument.
- **`replay.test.ts`** — one message replayed across all three tiers with the
  plugins' own modules, including the adversarial Tier-2 paths (forged
  signature, wrong secret, wrong app, wrong protocol version, wrong hook kind,
  stale timestamp, replayed nonce, cross-tenant approval) and the Tier-3
  plugin↔worker payload/result contract, with the plugin's declared job kind
  resolved through the worker's own command registry (`resolveJobCommand`) so a
  renamed job kind fails here rather than at runtime. The sandbox invariants
  around that command — separate uid, stripped environment, resource and time
  limits, cancellation and cleanup — belong to the worker and are covered by
  `apps/code-worker/src/__tests__/{uidSandbox,processIsolation,pluginTaskRunner}.test.ts`;
  this suite does not re-run them.
- **`hookClient.test.ts`** — the tutorial contract of `src/hookClient.ts`, the
  independent client half of the signed hook protocol the Tier-2 replay signs
  with: a last-hex-character near miss is rejected in constant time, a truncated
  signature is rejected rather than thrown at, a missing header fails closed, and
  the signature is bound to the nonce, app id, body and secret.

## Why a temporary workspace

`plugins.config.ts` accepts only registry-published packages: the codegen loader
requires a root dependency with a registry version spec, a matching `bun.lock`
artifact with a canonical sha512 integrity, and condition-independent package
exports. A workspace-linked example therefore can never be listed in the
repository's own config. The harness in `src/workspace.ts` instead installs
published-shaped copies of the **real** manifests into a throwaway root, so the
suites exercise the genuine install contract rather than a mock of it.

## Running

```sh
bun run --cwd examples/conformance test
bun run --cwd examples/conformance typecheck
```
