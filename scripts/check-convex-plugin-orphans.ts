#!/usr/bin/env bun
/**
 * Dead-code gate for the Convex plugin host.
 *
 * knip cannot see this tree: every file under `apps/api/convex/**` is a Convex
 * runtime entrypoint, so `knip.jsonc` declares the whole directory as `entry`
 * and nothing in it can ever be reported as unused. That blind spot is exactly
 * where an orphaned composition seam hides — a module that is generated,
 * catalogued, authorized and tested, but that no host path ever reaches.
 *
 * This gate closes it for `apps/api/convex/plugins/`, the directory where every
 * plugin composition seam lives. A module counts as REACHED when another
 * production Convex, Nuxt or worker module either imports it directly or
 * addresses it by function reference (`internal.plugins.<module>.…` from Convex,
 * `'plugins/<module>:<fn>'` from the out-of-process worker client). Anything
 * else is an orphan and must be listed in `AWAITING_CALL_SITE` with a reason, so
 * a NEW orphan fails loudly and a LISTED one that gets wired (or deleted) also
 * fails until the list is corrected. The gate can therefore not go quiet in
 * either direction.
 *
 * Run by `bun run lint:convex-orphans`, and from `ci:lint` / `ci:verify`.
 * Exercised against throwaway trees by
 * `examples/conformance/src/__tests__/convexPluginOrphans.test.ts`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_DIR = 'apps/api/convex/plugins';
const SEARCH_ROOTS = ['apps/api/convex', 'apps/web/app', 'apps/code-worker/src'];

/**
 * Orphaned-on-purpose modules: a finished contribution seam whose host call
 * site has not been written. Each key must match a module basename under
 * `apps/api/convex/plugins/`, and the value must say what is missing. These
 * mirror the `dispatch: 'declared'` rows in
 * `packages/plugin-kit/src/contributionRequirements.ts`; the conformance suite
 * `examples/conformance/src/__tests__/dispatchReachability.test.ts` pins the
 * other direction.
 */
export const AWAITING_CALL_SITE: Readonly<Record<string, string>> = Object.freeze({
	webhookEventAuthorization:
		'webhookEvents is dispatch: declared — the persisted event validators are closed core-only unions, so no publish path can authorize a plugin event yet',
	importProviderAuthorization:
		'importProviders is dispatch: declared — the import walker dispatches through a core-only provider registry, so no walk can authorize a plugin provider yet',
	inboundSignature:
		'the plugin inbound-signature verifier gates no HTTP endpoint yet; the docs state this explicitly on the import-provider contract',
});

export interface OrphanCheckOptions {
	/** Repository root to search. Defaults to this repository. */
	readonly root?: string;
	/** Module basenames that are allowed to have no consumer, with the reason. */
	readonly awaitingCallSite?: Readonly<Record<string, string>>;
	/** Directories under `root` that can hold a production consumer. */
	readonly searchRoots?: readonly string[];
}

function isProductionSource(path: string): boolean {
	if (path.includes('/__tests__/')) return false;
	if (path.includes('/_generated/')) return false;
	if (path.endsWith('.test.ts')) return false;
	return path.endsWith('.ts') || path.endsWith('.vue');
}

async function collectSources(root: string, searchRoots: readonly string[]): Promise<string[]> {
	const files: string[] = [];
	async function walk(relativeDir: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(join(root, relativeDir), { withFileTypes: true });
		} catch {
			return; // A search root that does not exist contributes nothing.
		}
		for (const entry of entries) {
			const child = `${relativeDir}/${entry.name}`;
			if (entry.isDirectory()) {
				if (entry.name !== 'node_modules') await walk(child);
			} else if (isProductionSource(child)) {
				files.push(child);
			}
		}
	}
	for (const searchRoot of searchRoots) await walk(searchRoot);
	return files;
}

/** Every relative import specifier in `source`, as a repository-relative path. */
function importedPaths(root: string, file: string, source: string): Set<string> {
	const here = dirname(file);
	const paths = new Set<string>();
	for (const match of source.matchAll(/from\s+'([^']+)'|import\s*\(\s*'([^']+)'/g)) {
		const specifier = match[1] ?? match[2];
		if (specifier === undefined || !specifier.startsWith('.')) continue;
		const resolved = relative(root, resolve(root, here, specifier));
		paths.add(resolved.replace(/\.js$/, ''));
	}
	return paths;
}

/** The gate's verdict: one human-readable line per problem, empty when clean. */
export async function findConvexPluginOrphanFailures(
	options: OrphanCheckOptions = {}
): Promise<readonly string[]> {
	const root = options.root ?? REPOSITORY_ROOT;
	const awaiting = options.awaitingCallSite ?? AWAITING_CALL_SITE;
	const sources = await collectSources(root, options.searchRoots ?? SEARCH_ROOTS);
	const contents = new Map<string, string>(
		await Promise.all(
			sources.map(async (file) => [file, await readFile(join(root, file), 'utf8')] as const)
		)
	);

	const seams = sources
		.filter((file) => file.startsWith(`${PLUGINS_DIR}/`) && !file.endsWith('.generated.ts'))
		.map((file) => ({ file, name: file.slice(`${PLUGINS_DIR}/`.length, -'.ts'.length) }));

	const failures: string[] = [];
	if (seams.length === 0) {
		return [`Found no modules under ${PLUGINS_DIR}/ — the gate is not searching anything.`];
	}

	for (const seam of seams) {
		const modulePath = seam.file.slice(0, -'.ts'.length);
		const references = [`plugins.${seam.name}.`, `plugins/${seam.name}:`];
		const reached = sources.some((file) => {
			if (file === seam.file) return false;
			// A machine-written file is not evidence a hand-written seam is alive:
			// codegen emits data and module registries, never a call into one.
			if (file.endsWith('.generated.ts')) return false;
			const source = contents.get(file)!;
			if (importedPaths(root, file, source).has(modulePath)) return true;
			return references.some((reference) => source.includes(reference));
		});
		const listed = seam.name in awaiting;
		if (reached && listed) {
			failures.push(
				`${seam.file} now has a production consumer but is still listed as awaiting a call site; remove the entry and update the contribution reference.`
			);
		}
		if (!reached && !listed) {
			failures.push(
				`${seam.file} has no production consumer: nothing imports it and nothing addresses plugins.${seam.name}. Wire it, delete it, or list it as awaiting a call site with a reason.`
			);
		}
	}

	for (const [name, reason] of Object.entries(awaiting)) {
		if (!seams.some((seam) => seam.name === name)) {
			failures.push(
				`${name} is listed as awaiting a call site but is not a module under ${PLUGINS_DIR}/; remove the stale entry.`
			);
		}
		if (reason.trim().length < 20) {
			failures.push(`${name} is listed as awaiting a call site without a usable reason.`);
		}
	}

	return failures;
}

if (import.meta.main) {
	const failures = await findConvexPluginOrphanFailures();
	if (failures.length > 0) {
		console.error('Convex plugin-host orphan check failed:\n');
		for (const failure of failures) console.error(`  - ${failure}`);
		process.exit(1);
	}
	console.log(
		`Convex plugin-host seams are reachable (${Object.keys(AWAITING_CALL_SITE).length} awaiting a call site).`
	);
}
