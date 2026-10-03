/**
 * Keeps test tooling out of the built web app.
 *
 * Test helpers live in `__tests__/` folders next to the code they test, and
 * Nuxt and Nitro scan those trees as app code unless told not to. Until #1172
 * a helper under `pages/` was a reachable route whose chunk bundled vitest and
 * `@vue/test-utils`, and a helper under `server/utils/` made Nitro trace vitest
 * and its dependency tree into `.output/server/node_modules`. Nothing failed:
 * the build passed and the image shipped both.
 *
 * This reads a finished `nuxt build` and fails when
 * - `server/package.json` (the dependencies Nitro traced into the server
 *   bundle) lists a test package, or
 * - the client build manifest (`server/chunks/virtual/precomputed.mjs`) or a
 *   client chunk names a `__tests__` path or vitest. The router's route table
 *   lives in a client chunk, so a test route shows up there.
 *
 * Usage: bun scripts/check-web-build-test-code.ts [path/to/.output]
 *   (defaults to apps/web/.output; CI copies the files out of the web image)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Packages only a test run needs. Any of them in the server bundle is a leak. */
const TEST_PACKAGE =
	/^(?:vitest|@vitest\/.+|@vue\/test-utils|@nuxt\/test-utils|@testing-library\/.+|happy-dom|chai)$/;

/** A test folder in a module path or route, or vitest's own module paths. */
const TEST_MARKER = /__tests__|@vitest\/|\/vitest\//;

const workspace = resolve(import.meta.dirname, '..');
const outputDir = resolve(process.argv[2] ?? join(workspace, 'apps/web/.output'));
const serverPackagePath = join(outputDir, 'server/package.json');
const manifestPath = join(outputDir, 'server/chunks/virtual/precomputed.mjs');
const publicDir = join(outputDir, 'public/_nuxt');

const missing = [serverPackagePath, manifestPath, publicDir].filter((path) => !existsSync(path));
if (missing.length > 0) {
	console.error(
		`check-web-build-test-code: no server build at ${outputDir} (missing ${missing.join(', ')}).\n` +
			'Run `nuxt build` in apps/web first.'
	);
	process.exit(2);
}

const problems: string[] = [];

const serverPackage = JSON.parse(readFileSync(serverPackagePath, 'utf8')) as {
	dependencies?: Record<string, string>;
};
for (const name of Object.keys(serverPackage.dependencies ?? {})) {
	if (TEST_PACKAGE.test(name)) problems.push(`server/package.json depends on ${name}`);
}

/** Up to five distinct hits with a little context, so the log names the culprit. */
function markers(source: string): string[] {
	const hits = new Set<string>();
	for (const match of source.matchAll(new RegExp(TEST_MARKER.source, 'g'))) {
		hits.add(source.slice(Math.max(0, match.index - 60), match.index + 60).replaceAll('\n', ' '));
		if (hits.size === 5) break;
	}
	return [...hits];
}

for (const hit of markers(readFileSync(manifestPath, 'utf8'))) {
	problems.push(`server/chunks/virtual/precomputed.mjs: ${hit}`);
}

for (const file of readdirSync(publicDir).filter((name) => name.endsWith('.js'))) {
	for (const hit of markers(readFileSync(join(publicDir, file), 'utf8'))) {
		problems.push(`public/_nuxt/${file}: ${hit}`);
	}
}

if (problems.length > 0) {
	console.error('The web build ships test code:');
	for (const problem of problems) console.error(`  ${problem}`);
	console.error(
		'\nA file under a folder Nuxt or Nitro scans (pages/, components/, server/utils/, ...) ' +
			'imports test tooling, or a test helper is registered as app code. Move test helpers into ' +
			'`__tests__/` (nuxt.config.ts keeps those out of the scans) and keep them out of production imports.'
	);
	process.exit(1);
}

console.info('No test packages, test routes or vitest modules in the web build.');
