/**
 * THE shared convex-test module map.
 *
 * `convexTest(schema, modules)` needs a glob of every backend module. Vite's
 * `import.meta.glob` excludes the directory the calling file lives in, so a map
 * built from a DOMAIN's `__tests__` folder has to merge a second glob to recover
 * that domain's own modules — which is how the same preamble ended up copied
 * into several suites. Rooted here, at `convex/__tests__/`, the single
 * `../**` glob covers the whole backend and excludes only this folder, which
 * holds tests and fixtures rather than modules under test.
 *
 * Live here rather than inside one domain's suite: a suite reaching four
 * directories sideways into another domain's test helper couples them for no
 * reason, and this map is not a property of any one domain.
 */

export const modules = import.meta.glob('../**/*.*s');
