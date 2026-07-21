/**
 * One shared per-test time budget for suites whose fixed setup cost is large.
 *
 * Vitest defaults `testTimeout`/`hookTimeout` to 5000ms, which is sized for a
 * suite running on its own. The root release gate (`bun run ci:test`, and
 * therefore `ci:verify` and the release workflow) runs all turbo test tasks at
 * once, and a suite that pays an irreducible fixed cost per test — a module
 * graph reload, a workspace materialised on disk, a real subprocess — inflates
 * by roughly an order of magnitude under that contention. The result is a
 * release gate that fails on machine load rather than on code, which is worse
 * than useless.
 *
 * The number is measured, not guessed. Under a full `bun run ci:verify` on a
 * 16-core machine, one codegen generate-and-check round trip costing ~450ms in
 * isolation was observed at ~5.2s, and an email-block host case costing ~40ms in
 * isolation was observed at ~9.9s. A twelvefold margin over vitest's default
 * leaves real headroom above both while still failing a genuine hang well inside
 * the gate's own runtime.
 *
 * Packages with that shape import this budget instead of inventing their own
 * number, so raising it once raises it everywhere it is warranted. It is
 * deliberately NOT applied to every package: a suite with no fixed cost should
 * keep a tight budget so a genuine hang still fails fast.
 */
export const PARALLEL_GATE_TIMEOUT_MS = 60_000;

/** Vitest's built-in default, which the budget above deliberately replaces. */
export const VITEST_DEFAULT_TIMEOUT_MS = 5_000;
