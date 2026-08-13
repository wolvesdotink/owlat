#!/usr/bin/env bun
/**
 * Closure gate for the convex-deploy image's workspace COPY list.
 *
 * `docker/convex-deploy.Dockerfile` copies each `@owlat/*` workspace package
 * the Convex bundle needs into the deploy stage by hand. That list has rotted
 * before: `@owlat/shared` grew an import of `@owlat/mail-message`, nothing
 * failed until `convex deploy` inside the released image died with
 * "Could not resolve @owlat/mail-message/parse/headers" (issue #551).
 *
 * This gate recomputes the closure from source on every run:
 *
 *  1. Every production `.ts` file under `apps/api/convex/` is scanned for
 *     `@owlat/*` import specifiers (static, dynamic and re-exports; subpath
 *     imports collapse to their package).
 *  2. The set expands transitively through each workspace package's
 *     `dependencies` — `workspace:*` entries of other `@owlat/*` packages only.
 *  3. The Dockerfile must provide every package in the closure, either as a
 *     full `COPY packages/<dir>/ …` or as the provider-kit/plugin-kit style
 *     package.json + dist pair.
 *
 * A needed-but-missing package fails the run; a copied-but-unneeded package is
 * only a warning (a package can be staged ahead of its first import).
 *
 * Usage: bun scripts/check-deploy-image-closure.ts [--dockerfile <path>]
 * (the flag exists so tests can point the gate at a doctored Dockerfile).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONVEX_ROOT = join(REPOSITORY_ROOT, 'apps', 'api', 'convex');
const PACKAGES_ROOT = join(REPOSITORY_ROOT, 'packages');
const DEFAULT_DOCKERFILE = join(REPOSITORY_ROOT, 'docker', 'convex-deploy.Dockerfile');
const SCOPE = '@owlat/';

function isProductionSource(path: string): boolean {
	if (path.includes('/__tests__/')) return false;
	if (path.includes('/_generated/')) return false;
	if (/\.(?:test|spec)\.ts$/.test(path)) return false;
	return path.endsWith('.ts');
}

function sourceFiles(directory: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const full = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules') continue;
			found.push(...sourceFiles(full));
		} else if (isProductionSource(full)) {
			found.push(full);
		}
	}
	return found;
}

/** Every `@owlat/<name>` package referenced by an import in `source`. */
function importedPackages(source: string): Set<string> {
	const packages = new Set<string>();
	const specifiers = source.matchAll(/(?:from\s*|import\s*\(\s*)['"](@owlat\/[^'"]+)['"]/g);
	for (const match of specifiers) {
		// Collapse subpath imports ('@owlat/mail-message/parse/headers') to the package.
		const name = match[1]!.split('/').slice(0, 2).join('/');
		packages.add(name.slice(SCOPE.length));
	}
	return packages;
}

/** name → `workspace:*` @owlat dependency names, for every packages/ workspace. */
function workspaceDependencyGraph(): Map<string, string[]> {
	const graph = new Map<string, string[]>();
	for (const entry of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		let manifest;
		try {
			manifest = JSON.parse(readFileSync(join(PACKAGES_ROOT, entry.name, 'package.json'), 'utf8'));
		} catch {
			continue; // Not a workspace package.
		}
		const dependencies = Object.entries(manifest.dependencies ?? {})
			.filter(([name, range]) => name.startsWith(SCOPE) && String(range).startsWith('workspace:'))
			.map(([name]) => name.slice(SCOPE.length));
		graph.set(String(manifest.name).replace(SCOPE, ''), dependencies);
	}
	return graph;
}

/** The @owlat packages the deploy image needs: convex imports plus workspace deps. */
export function neededPackages(): { closure: Set<string>; unknown: Set<string> } {
	const graph = workspaceDependencyGraph();
	const closure = new Set<string>();
	const unknown = new Set<string>();
	const queue: string[] = [];
	for (const file of sourceFiles(CONVEX_ROOT)) {
		for (const name of importedPackages(readFileSync(file, 'utf8'))) queue.push(name);
	}
	while (queue.length > 0) {
		const name = queue.pop()!;
		if (closure.has(name)) continue;
		if (!graph.has(name)) {
			unknown.add(name);
			continue;
		}
		closure.add(name);
		queue.push(...graph.get(name)!);
	}
	return { closure, unknown };
}

/** The packages/<dir> workspaces the Dockerfile stages into the deploy image. */
export function providedPackages(dockerfile: string): Set<string> {
	const provided = new Set<string>();
	const manifestOnly = new Set<string>();
	const distOnly = new Set<string>();
	for (const line of dockerfile.split('\n')) {
		const copy = line.match(/^\s*COPY\s+(?:--\S+\s+)*(\S+)\s/);
		if (!copy) continue;
		const source = copy[1]!.replace(/^\/app\//, '');
		const full = source.match(/^packages\/([^/]+)\/$/);
		if (full) provided.add(full[1]!);
		const manifest = source.match(/^packages\/([^/]+)\/package\.json$/);
		if (manifest) manifestOnly.add(manifest[1]!);
		const dist = source.match(/^packages\/([^/]+)\/dist\/$/);
		if (dist) distOnly.add(dist[1]!);
	}
	// provider-kit/plugin-kit style: package.json plus a built dist directory.
	for (const name of manifestOnly) {
		if (distOnly.has(name)) provided.add(name);
	}
	return provided;
}

if (import.meta.main) {
	const flagIndex = process.argv.indexOf('--dockerfile');
	const dockerfilePath = flagIndex === -1 ? DEFAULT_DOCKERFILE : process.argv[flagIndex + 1];
	if (dockerfilePath === undefined) {
		console.error('Usage: bun scripts/check-deploy-image-closure.ts [--dockerfile <path>]');
		process.exit(2);
	}

	const { closure, unknown } = neededPackages();
	const provided = providedPackages(readFileSync(dockerfilePath, 'utf8'));
	const missing = [...closure].filter((name) => !provided.has(name)).sort();
	const unneeded = [...provided].filter((name) => !closure.has(name)).sort();

	for (const name of unknown) {
		console.error(
			`  - @owlat/${name} is imported under apps/api/convex but is not a workspace under packages/; the gate cannot follow it.`
		);
	}
	for (const name of missing) {
		console.error(
			`  - @owlat/${name} is in the Convex deploy closure but ${dockerfilePath} never copies packages/${name}/ (or its package.json + dist pair).`
		);
	}
	if (unknown.size > 0 || missing.length > 0) {
		console.error('\nConvex deploy image closure check failed.');
		process.exit(1);
	}

	for (const name of unneeded) {
		console.warn(
			`  ! packages/${name}/ is copied into the deploy image but nothing in the Convex closure needs it.`
		);
	}
	console.log(
		`Convex deploy image provides all ${closure.size} workspace packages in the closure: ${[...closure].sort().join(', ')}.`
	);
}
