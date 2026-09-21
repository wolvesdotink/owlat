/**
 * Runtime config must use the env names Nitro actually maps.
 *
 * `apps/web/nuxt.config.ts` is evaluated when the IMAGE IS BUILT. At startup
 * Nitro overlays env onto runtime config by name — `NUXT_` + CONSTANT_CASE(key),
 * `NUXT_PUBLIC_` for the public block — and nothing else. So a key that reads
 * any other name is frozen at whatever the build environment happened to have,
 * in every published image, and no operator env will ever move it.
 *
 * That is not hypothetical. `owlatVersion` read `OWLAT_VERSION`, the web image
 * exported `OWLAT_VERSION=<real version>`, and the browser still saw "dev" —
 * which made the admin page's update check short-circuit, so the in-app updater
 * never appeared on a single published release. `setupMode` and `deploymentMode`
 * had the same defect.
 *
 * Checking the config's SHAPE cannot catch this (the shape was always fine) and
 * neither can a unit test of the app (it reads whatever the config says). What
 * is wrong is the NAME, which is exactly what this pins — cheaply, on every PR.
 * The image-level counterpart lives in scripts/check-web-csp-shell.sh.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CONFIG = 'apps/web/nuxt.config.ts';

/**
 * Keys that intentionally read another name, with the reason. These select
 * WHICH BUNDLE was produced, so they must be resolved at build time — a runtime
 * value would claim a different build than the one that is running.
 */
const BUILD_TIME_BY_DESIGN = new Map([['isDesktopBuild', 'OWLAT_DESKTOP']]);

function constantCase(key: string): string {
	return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** The `runtimeConfig: { … }` object, sliced out by brace counting. */
function runtimeConfigBlock(source: string): string {
	const start = source.indexOf('runtimeConfig: {');
	expect(start, `no runtimeConfig block in ${CONFIG}`).toBeGreaterThan(-1);
	let depth = 0;
	for (let i = source.indexOf('{', start); i < source.length; i++) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
	}
	throw new Error(`unbalanced braces in the runtimeConfig block of ${CONFIG}`);
}

describe('nuxt runtime config env names', () => {
	const block = runtimeConfigBlock(readFileSync(join(REPOSITORY_ROOT, CONFIG), 'utf8'));
	const publicStart = block.indexOf('public: {');

	const reads = [...block.matchAll(/(\w+): process\.env\['([A-Z0-9_]+)'\]/g)].map((match) => ({
		key: match[1]!,
		envName: match[2]!,
		isPublic: publicStart > -1 && match.index! > publicStart,
	}));

	it('reads a name Nitro will map at runtime, for every key', () => {
		expect(
			reads.length,
			'no process.env reads found — has the config been restructured?'
		).toBeGreaterThan(5);

		const wrong = reads
			.filter(({ key, envName }) => BUILD_TIME_BY_DESIGN.get(key) !== envName)
			.filter(
				({ key, envName, isPublic }) =>
					envName !== `NUXT_${isPublic ? 'PUBLIC_' : ''}${constantCase(key)}`
			)
			.map(
				({ key, envName, isPublic }) =>
					`${key} reads ${envName}, want NUXT_${isPublic ? 'PUBLIC_' : ''}${constantCase(key)}`
			);

		expect(
			wrong,
			'these are frozen at their build-time value in every published image; see the header of this file'
		).toEqual([]);
	});

	it('keeps the build-time exceptions explicit', () => {
		// So that adding one is a deliberate act with a reason, not a rename that
		// happens to make the test above pass.
		for (const [key, envName] of BUILD_TIME_BY_DESIGN) {
			expect(block, `${key} no longer reads ${envName}; drop it from the exception list`).toContain(
				`${key}: process.env['${envName}']`
			);
		}
	});
});
