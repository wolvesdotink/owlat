/**
 * Nuxt and Vite must share one rolldown copy.
 *
 * nuxt declares rolldown as a required peer and imports it directly
 * (`rolldown/utils`, and `replacePlugin` from `rolldown/plugins` in
 * @nuxt/vite-builder). Vite bundles with its own `rolldown` dependency and
 * recognises native plugins by `instanceof BuiltinPlugin` against its own
 * class. With two copies, Nuxt's `nuxt:replace` builtin fails that check and
 * runs as a JS-wrapped plugin, and Nuxt runs on a rolldown older than its peer
 * range (#1271). bun.lock does not warn about an unmet peer, so these tests do.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

type LockEntry = [
	string,
	string,
	{ dependencies?: Record<string, string>; peerDependencies?: Record<string, string> },
];

function readLockPackages(): Record<string, LockEntry> {
	const text = readFileSync(`${REPOSITORY_ROOT}bun.lock`, 'utf8');
	// bun.lock is JSON with trailing commas.
	return (JSON.parse(text.replace(/,(\s*[}\]])/g, '$1')) as { packages: Record<string, LockEntry> })
		.packages;
}

function versionOf(entry: LockEntry): string {
	return entry[0].slice(entry[0].lastIndexOf('@') + 1);
}

/** `~x.y.z` and `^x.y.z` (x >= 1), the only forms nuxt and vite use for rolldown. */
function satisfies(version: string, range: string): boolean {
	const match = /^([~^])(\d+)\.(\d+)\.(\d+)$/.exec(range);
	if (!match) throw new Error(`unsupported range ${range}`);
	const [major, minor, patch] = version.split('.').map(Number);
	const [wantMajor, wantMinor, wantPatch] = match.slice(2).map(Number);
	if (major !== wantMajor) return false;
	if (minor !== wantMinor) return match[1] === '^' && minor! > wantMinor!;
	return patch! >= wantPatch!;
}

describe('rolldown in bun.lock', () => {
	const packages = readLockPackages();
	const entry = (key: string): LockEntry => {
		const found = packages[key];
		if (!found) throw new Error(`${key} is missing from bun.lock`);
		return found;
	};

	it('resolves a single copy', () => {
		const copies = Object.entries(packages).filter(([, value]) => value[0].startsWith('rolldown@'));
		expect(copies.map(([key, value]) => `${key} -> ${value[0]}`)).toEqual([
			`rolldown -> ${entry('rolldown')[0]}`,
		]);
	});

	it("satisfies nuxt's peer range and vite's dependency range", () => {
		const version = versionOf(entry('rolldown'));
		const nuxtRange = entry('nuxt')[2].peerDependencies?.['rolldown'] ?? '';
		const viteRange = entry('vite')[2].dependencies?.['rolldown'] ?? '';
		expect(satisfies(version, nuxtRange), `rolldown ${version} vs nuxt ${nuxtRange}`).toBe(true);
		expect(satisfies(version, viteRange), `rolldown ${version} vs vite ${viteRange}`).toBe(true);
	});
});

describe('rolldown as installed', () => {
	const nuxtRequire = createRequire(
		realpathSync(`${REPOSITORY_ROOT}node_modules/nuxt/package.json`)
	);
	const viteBuilderRequire = createRequire(
		realpathSync(nuxtRequire.resolve('@nuxt/vite-builder/package.json'))
	);
	const viteRequire = createRequire(realpathSync(viteBuilderRequire.resolve('vite/package.json')));

	it('is the same copy for nuxt, @nuxt/vite-builder and vite', () => {
		const copies = [nuxtRequire, viteBuilderRequire, viteRequire].map((require) =>
			realpathSync(require.resolve('rolldown/package.json'))
		);
		expect(new Set(copies).size, copies.join('\n')).toBe(1);
	});

	it("gives vite a native builtin for nuxt's replace plugin", async () => {
		const load = (require: NodeJS.Require, id: string) =>
			import(pathToFileURL(realpathSync(require.resolve(id))).href);
		const { replacePlugin } = (await load(viteBuilderRequire, 'rolldown/plugins')) as {
			replacePlugin: (values: Record<string, string>) => object;
		};
		const { viteAliasPlugin } = (await load(viteRequire, 'rolldown/experimental')) as {
			viteAliasPlugin: (config: { entries: [] }) => object;
		};
		// rolldown does not export BuiltinPlugin; take the class from a builtin of vite's copy.
		const ViteBuiltinPlugin = Object.getPrototypeOf(viteAliasPlugin({ entries: [] }))
			.constructor as new () => object;
		expect(replacePlugin({ 'import.meta.test': 'true' })).toBeInstanceOf(ViteBuiltinPlugin);
	});
});
