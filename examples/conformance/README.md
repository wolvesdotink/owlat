# Plugin conformance gallery

The final conformance gate for the Owlat plugin platform. It drives the three
maintained reference plugins — one per trust tier — through the host contracts,
codegen and CLI, and asserts the properties that make them a reference set
rather than three unrelated demos.

| Tier | Reference                       | What it proves                                           |
| ---- | ------------------------------- | -------------------------------------------------------- |
| 1    | `../plugins/escalation-guard`   | Bundled, in-process contributions and the agent pipeline |
| 2    | `../plugins/slack-approvals`    | A connected app over the signed synchronous hook         |
| 3    | `../plugins/deliverability-lab` | A sandboxed-worker protocol fixture, plus a live restrict-only send gate |

## Suites

- **`gallery.test.ts`** — coverage and ceiling invariants: exactly one reference
  per tier, every manifest valid, every reference off by default, no duplicate
  ids/hrefs/event kinds, every contribution bucket paired with the capability it
  needs, an LLM budget exactly when `llm:invoke` is requested, grants that can
  only narrow, and nav items that target real core sidebar sections.
- **`dispatchReachability.test.ts`** — the honesty gate on the contribution
  buckets. Each capability-enforced MODULE EXPORT is classed `wired` or
  `declared` in the kernel's requirement table; this suite names the one symbol a
  host path has to reach for that export to run, then asserts a `wired` one has a
  production consumer and a `declared` one has none. Wiring a declared export, or
  deleting the last consumer of a wired one, turns it red until the table and the
  Contribution Reference agree with the code. Most buckets carry one module; a
  bucket that carries two (`sendTransports`, whose contributions may declare a
  feedback `webhook`) is asked about each separately.
- **`pluginWebhookSeam.test.ts`** — the send-transport feedback webhook (D6) from
  manifest to generated artifact: the declared signature contract, its replay
  provisions and the opt-in raw-payload flag reach the host unchanged; the parse
  half is imported into the isolate runtime while the send half stays in Node;
  and a webhook the host could not verify — no signature contract, no replay
  provisions, an unbounded tolerance, a secret outside the plugin namespace — is
  refused at validation, so it never becomes an artifact at all.
- **`pluginTransportParity.test.ts`** — the send transport's CAPABILITY contract
  (D4) over the same chain: the configuration variables, the capability fields
  and the derived `hasProviderFeedback` reach the generated catalog exactly as
  declared, a transport written against the older contract composes unchanged,
  and a declaration the host could not honour — a credential outside the plugin
  namespace, a base name that would alias an instance suffix, a capability value
  whose prerequisites live in host code — is refused at validation.
- **`pluginProviderParity.test.ts`** — the PARITY PROOF (P3.3, acceptance
  criterion A4). Where the two suites above walk the authoring chain, this one
  starts at the generated artifacts and drives the **shipped** core modules with
  them: `resolveRoute` under every strategy the registry declares, the
  deliverability fallback and its per-domain proof gate, governed dispatch
  through the plugin's own send module on a named instance's credentials (with
  the capability recheck asserted and the extras seam driven end to end),
  `armForTransport`, the return-path fold, the feedback route's verify → parse →
  revalidate chain, the domain-identity split between the plugin's observations
  and the host's derived status, and the credential form in the vocabulary the
  web renderer draws. Its subject is
  [`src/fixtures/mockEsp/`](src/fixtures/mockEsp), a complete fixture bundle —
  manifest, send module, feedback webhook, domain identity — written as a
  third-party author would write it. The last block asserts the headline claim:
  no non-test file under `apps/` or `packages/` mentions the fixture, so all of
  the above runs against code that has never heard of it, and the two test files
  that ARE allowed to know are named and bound to the composed kind.

  The credentials-UI obligation is closed by the generated web catalog and
  `pluginTransportCredentials.test.ts`: the same rendered descriptors reach the
  picker, required-field gate, env patch and server allowlist. One older
  obligation is superseded rather than missing:

  1. _Return-path probes._ P3.1 made
     `supportsCustomReturnPath: 'no'` the only value this tier may declare, so a
     plugin kind is unprobeable by construction and the obligation is discharged
     as "the fold reads the declaration and the sweep excludes the kind". The
     price — a permanent `degraded` measurement quality for every plugin ESP — is
     asserted rather than hidden.

  The ramp half of the proof needs a database and lives at
  `apps/api/convex/delivery/ramp/__tests__/pluginReferenceArm.test.ts`, which
  also covers the one door the composed catalog is read at: saving a
  `providerRoutes` row that names a plugin kind.

  **What stays text-pinned.** The fixture is a module tree, not a workspace
  package, so the three generated MODULE registries (which codegen emits as
  `import` statements against a published specifier) are supplied directly rather
  than resolved. `plugins.config.ts` is empty in this repository and none of the
  three reference plugins contributes a `sendTransports` bucket, so the emitted
  import statements for a send transport are pinned as text by
  `packages/plugin-codegen/src/__tests__/render.test.ts` and by no suite as code.
  The piece that closes that is P5.3 (the first real plugin provider, listed in
  `plugins.config.ts` — the repo's first non-empty composition).
- **`scaffoldedProviderConformance.test.ts`** — the SCAFFOLD'S GATE (P3.4,
  acceptance criterion A7). The parity proof above asks whether a package _can_
  be a provider, against a fixture written by hand; this one asks whether the
  package Owlat _hands an author_ already is one. Its subject is the real output
  of `owlat plugins create --template send-provider`:
  [`src/fixtures/scaffolded/bundle.ts`](src/fixtures/scaffolded) calls the
  shipped `buildScaffold`, writes the emitted files to a throwaway directory,
  imports the emitted TypeScript, and composes it through the real host and
  renderer — so every value the core modules are fed travelled generator → file →
  module → validation → composition → codegen. The suite then drives that bundle
  through `resolveRoute` under every declared strategy, the deliverability
  fallback and its per-domain proof gate, governed dispatch on a named instance's
  credentials (with the emitted module's real `fetch` stubbed, so its
  status→retry mapping is exercised at the governed boundary), `armForTransport`,
  the return-path fold, the feedback route's verify → parse → revalidate chain,
  the domain-identity split and the credential form. Nothing subject-specific is
  spelled: the kind, the variable names, the signature contract and the fields
  are all read off the composed artifact. It also runs the four emitted
  `src/__tests__` files themselves, in a child process through the package's own
  emitted `vitest.config.ts` — the first thing a real author runs, and otherwise
  the one part of the template nothing keeps green. That is why the bundle
  materialises under the git-ignored `examples/conformance/.scaffolded/` rather
  than `/tmp`: a package outside the checkout cannot resolve `vitest` at all. The
  last block reads every materialised file back off disk and compares it byte for
  byte with what the generator emitted, so a fixture that patched a `TODO` to
  make a case pass fails there.
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
- **`convexPluginOrphans.test.ts`** — the guard on
  `scripts/check-convex-plugin-orphans.ts`, the dead-code gate for the Convex
  plugin host. knip declares the whole Convex tree as `entry`, so an orphaned
  composition seam there is invisible to `lint:deadcode`; that gate closes the
  hole, and this suite runs it against throwaway repositories so it cannot go
  quiet on the drift it exists to catch. Covers a seam nothing reaches, the three
  ways a seam can legitimately be reached (relative import, generated function
  reference, worker client path string), a test-only or codegen-only "consumer",
  an allowlisted seam that quietly gains a caller, and a stale allowlist entry.
- **`namespacedKindGrammar.test.ts`** — the guard that keeps
  `plugin.<pluginId>.<localId>` a single definition. The grammar is a security
  boundary (core-vs-plugin dispatch and every ownership compare read it), so this
  suite fails on any module outside `@owlat/plugin-kit`'s `namespacedKind.ts`
  that constructs it inline, and round-trips every contributed kind of every
  reference plugin through the one builder and its parser.
- **`dockerWorkspaces.test.ts`** — the guard that keeps the examples installable
  in every image: `scripts/check-docker-workspaces.sh` is run against throwaway
  repositories so it cannot go quiet on the drift it exists to catch. Covers a
  COPY wrapped across backslash continuations (still checked, globs intact and
  glob dropped) and an image that runs `bun install --frozen-lockfile` while
  copying no manifest at all.

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
