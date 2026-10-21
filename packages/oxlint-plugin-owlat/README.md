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
