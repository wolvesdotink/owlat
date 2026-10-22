# oxlint-plugin-owlat

Owlat's own oxlint rules. The root `oxlintrc.json` loads `src/index.ts` through
`jsPlugins`, so every `oxlint --config …/oxlintrc.json` run (the root gates and
each workspace's `lint`) applies them. oxlint imports the source directly with
Node's type stripping: there is no build step, and the code must stay erasable
TypeScript with explicit `.ts` import specifiers.

| Rule                               | What it enforces                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `owlat/require-suppression-reason` | Every `oxlint-disable` / `eslint-disable` / `@ts-*` directive says why: a `-- reason` tail or a comment on the line above. TypeScript directives are recognized in every comment form the compiler obeys (`///` and block comments included, checked against the real compiler). Generated files are exempt. The root config keeps `@ts-ignore` / `@ts-nocheck` banned through `ban-ts-comment` and leaves the `@ts-expect-error` reason to this rule. |
| `owlat/no-test-environment-pragma` | No per-file `@vitest-environment` pragma; the package's vitest config selects the environment. Matched with vitest's own pattern over the whole file text (comments, prose and strings alike). Deliberate exceptions are listed under the rule's `allow` option in `oxlintrc.json`.                                                                                                                                                                    |
| `owlat/no-test-in-loop`            | No vitest `it` / `test` / `describe` declared inside a loop, including modifier chains, curried factories and tagged-template `.each` tables; use `.each`.                                                                                                                                                                                                                                                                                             |
| `owlat/no-crypto-primitives`       | HMAC signing (Web Crypto `importKey` / `sign` / `verify` / `generateKey` / `deriveKey` with HMAC, or an `importKey` whose algorithm is not a literal), any `timingSafeEqual` use and XOR-accumulate compares stay in the modules listed under `allow`.                                                                                                                                                                                                 |
| `owlat/no-process-env`             | Environment reads go through the env module: every access form of the `process.env` object (dotted, bracket, optional, destructured, `node:process` imports) is reported elsewhere in `files`.                                                                                                                                                                                                                                                         |
| `owlat/no-log-pii`                 | A process-log call (`logInfo` … `console.*`) carries no correspondent address or subject key unless its value goes through a redaction helper; `// log-pii-safe: <reason>` opts out.                                                                                                                                                                                                                                                                   |
| `owlat/convex-error-taxonomy`      | `ConvexError` is constructed or subclassed only in the modules under `allow`, and no bare `Error` is thrown inside a function registered with a public builder.                                                                                                                                                                                                                                                                                        |
| `owlat/no-raw-convex-builder`      | No use of the raw Convex `query` / `mutation` / `action` builders (resolved by import, aliases and namespaces included) outside the wrapper module.                                                                                                                                                                                                                                                                                                    |
| `owlat/use-threaded-session`       | A handler on an org-scoped builder takes the session the builder threads instead of calling a session-resolving helper; `// session: <reason>` opts out. A warning, ratcheted.                                                                                                                                                                                                                                                                         |
| `owlat/feature-floor-in-builder`   | A gated family's handlers use its `featureGated` builder instead of asserting the flag inline or using a bare org-member builder; justified sites are listed under `allow`.                                                                                                                                                                                                                                                                            |

## Boundary rules

The last seven rules above replaced bash/awk gates (`scripts/check-*.sh`,
`apps/api/scripts/check-*.sh`) that matched text. They read the same scope
through options instead of the working directory: `files` and `ignore` are
repository-relative globs matched as a path suffix, test files are always
skipped, and each `allow` entry names the files (or, for the feature floors,
the `<path>:<function>` sites) it exempts together with its reason.
`scripts/__tests__/owlat-boundary-allowances.test.ts` fails an entry whose file
is gone or no longer needs it. Until the old scripts are retired, both run and
`bun run lint:ast-gate-parity` (`scripts/ast-gate-parity.ts`) diffs their
findings per rule.

The Convex rules need to know which names are public builders and the floor
each enforces. `src/lib/convexBuilders.ts` derives that table from the inputs
`apps/api/scripts/lib/convex-builders.sh` reads (its `CONVEX_BASE_BUILDERS`
classification and the `featureGated` compositions under `convex/`), once per
lint process, and resolves a call's builder by binding rather than by name.

## Adding a rule

1. Write `src/rules/<name>.ts` and its RuleTester suite in
   `src/rules/__tests__/` (oxlint's own `RuleTester` from `oxlint/plugins-dev`,
   wired to vitest in `src/__tests__/ruleTester.ts`).
2. Register it in `src/index.ts` and turn it on in `oxlintrc.json`.
3. If code still breaks it, configure it as `"warn"` and seed the ratchet
   baseline with `bash scripts/check-owlat-lint.sh --write-baseline`; the
   `lint:owlat` gate then fails on any new finding. Otherwise use `"error"`.

Keep the visitor cheap: the rules run on every linted file, so skip a file by
a plain text check in `create` when it cannot match, before asking for
comments or scope.
