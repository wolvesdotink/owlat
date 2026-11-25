/**
 * How a developer runs this CLI. It is a private workspace package, so its
 * `owlat-plugins` binary exists only in an Owlat checkout's `node_modules/.bin`,
 * and `bun run` finds it there from any directory of the checkout. The operator
 * wrapper `scripts/owlat` has no plugin command on purpose: plugins are bundled
 * at build time, and an install from published images has nothing to rebuild.
 */
export const CLI_INVOCATION = 'bun run owlat-plugins';
