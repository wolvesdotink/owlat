/**
 * Route and deferred-feature closures of the built web app. Report-only.
 *
 * `check-bundle-budget.ts` keeps the entry closure small, and by design it
 * stops at every `import()`. That protects boot but says nothing about what a
 * page or a lazily loaded feature drags in once it is opened: an editor page,
 * the file library or the assistant can pick up a large static dependency and
 * no check notices. This prints, for every page and every lazy chunk, the
 * static closure that loading it adds on top of the entry closure, with the
 * same reading rules as the entry budget (scripts/bundle-closure.ts).
 *
 * - Routes are the `pages/*.vue` modules of the client build manifest
 *   (`server/chunks/virtual/precomputed.mjs`), keyed by their source path.
 * - Deferred features are every chunk some emitted chunk loads with `import()`,
 *   other than the entry and the pages. The manifest names them by source path
 *   (`components/SendTestEmailModal.vue`) or by chunk name; a chunk the
 *   manifest does not name is shown by who imports it.
 *
 * Like the entry budget it counts JavaScript chunks only: the stylesheets a
 * page loads (the manifest lists them per page) are not in these totals.
 *
 * The output is sorted by key and holds no timings, so two reports diff
 * cleanly before and after a change. There is no budget: the plan (OW-076)
 * keeps route closures report-only until a few releases show how much they
 * move on their own. Exit status is 0 for any sizes, 2 for an unreadable build.
 *
 * Usage: bun scripts/report-bundle-closures.ts [path/to/.output] [--json]
 *   (defaults to apps/web/.output; --json prints the full report, chunk lists
 *   included, for diffing two builds)
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	type FileSize,
	dynamicImports,
	kb,
	measure,
	readWebBuild,
	staticClosure,
} from './bundle-closure';

const TOOL = 'report-bundle-closures';
const args = process.argv.slice(2);
const json = args.includes('--json');
const { outputDir, publicDir, entry } = readWebBuild(
	TOOL,
	args.find((arg) => arg !== '--json')
);

interface ManifestResource {
	file?: string;
	src?: string;
	name?: string;
}
interface PrecomputedManifest {
	modules?: Record<string, ManifestResource>;
	dependencies?: Record<string, { preload?: Record<string, ManifestResource> }>;
}

const manifestPath = join(outputDir, 'server/chunks/virtual/precomputed.mjs');
if (!existsSync(manifestPath)) {
	console.error(`${TOOL}: no client build manifest at ${manifestPath}.`);
	process.exit(2);
}
const manifest = ((await import(pathToFileURL(manifestPath).href)) as { default?: unknown })
	.default as PrecomputedManifest | undefined;
if (!manifest?.modules || !manifest.dependencies) {
	console.error(`${TOOL}: ${manifestPath} has no modules/dependencies table.`);
	process.exit(2);
}

/**
 * Chunk file → the source path the manifest built it from, else its chunk name.
 * Both tables also key shared chunks by an `_<hash>.js` id, which is no name.
 */
const labels = new Map<string, string>();
for (const [id, resource] of Object.entries(manifest.modules)) {
	if (resource.file && !id.startsWith('_')) labels.set(resource.file, id);
}
for (const dependency of Object.values(manifest.dependencies)) {
	for (const resource of Object.values(dependency.preload ?? {})) {
		const label = resource.src ?? resource.name;
		if (resource.file && label && !labels.has(resource.file)) labels.set(resource.file, label);
	}
}

const sizes = new Map<string, FileSize>();
const sizeOf = (file: string) => {
	let size = sizes.get(file);
	if (!size) sizes.set(file, (size = measure(publicDir, file)));
	return size;
};

const entryClosure = new Set(staticClosure(publicDir, entry));

const routeRoots = Object.entries(manifest.modules)
	.filter(([src, resource]) => src.startsWith('pages/') && resource.file)
	.map(([src, resource]) => ({ key: src, root: resource.file as string }))
	.filter(({ root }) => existsSync(join(publicDir, root)));
const routeFiles = new Set(routeRoots.map(({ root }) => root));

const importers = new Map<string, Set<string>>();
for (const file of readdirSync(publicDir)
	.filter((name) => name.endsWith('.js'))
	.sort()) {
	for (const target of dynamicImports(publicDir, file)) {
		if (target === entry || routeFiles.has(target) || !existsSync(join(publicDir, target))) {
			continue;
		}
		const from = importers.get(target) ?? new Set<string>();
		from.add(labels.get(file) ?? (file === entry ? 'entry' : file));
		importers.set(target, from);
	}
}

/** Unnamed or same-named chunks are told apart by their importers, then by order. */
const deferredRoots = [...importers.keys()].map((root) => ({
	root,
	label: labels.get(root),
	importers: [...(importers.get(root) as Set<string>)].sort(),
}));
const byLabel = new Map<string, number>();
for (const { label } of deferredRoots) {
	if (label) byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
}
const keyed = deferredRoots.map((root) => ({
	...root,
	key:
		root.label && byLabel.get(root.label) === 1
			? root.label
			: `${root.label ?? '(unnamed)'} <- ${root.importers.join(', ')}`,
}));
/** Code-point order, so the report sorts the same under every locale. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const seen = new Map<string, number>();
for (const root of keyed.sort((a, b) => compare(a.key, b.key) || compare(a.root, b.root))) {
	const count = (seen.get(root.key) ?? 0) + 1;
	seen.set(root.key, count);
	if (count > 1) root.key = `${root.key} #${count}`;
}

interface Totals {
	files: number;
	raw: number;
	gzip: number;
}
const totals = (files: string[]): Totals => ({
	files: files.length,
	raw: files.reduce((sum, file) => sum + sizeOf(file).raw, 0),
	gzip: files.reduce((sum, file) => sum + sizeOf(file).gz, 0),
});

function describe(root: string) {
	const closure = staticClosure(publicDir, root).sort();
	const added = closure.filter((file) => !entryClosure.has(file));
	return {
		root,
		closure: totals(closure),
		beyondEntry: {
			...totals(added),
			chunks: added.map((file) => ({
				file,
				label: labels.get(file) ?? null,
				gzip: sizeOf(file).gz,
			})),
		},
	};
}

const byKey = <T extends { key: string }>(a: T, b: T) => compare(a.key, b.key);
const report = {
	meta: {
		/** What the totals count: `.js` chunks reached by static imports, no CSS. */
		assets: 'javascript-only',
		budget: null,
	},
	// Keyed by source path, not file: the entry carries the build id, so its
	// hashed name changes on every build even when nothing else does.
	entry: { key: labels.get(entry) ?? 'entry', closure: totals([...entryClosure].sort()) },
	routes: routeRoots.sort(byKey).map(({ key, root }) => ({ key, ...describe(root) })),
	deferred: keyed
		.sort(byKey)
		.map(({ key, root, importers: from }) => ({ key, importers: from, ...describe(root) })),
};

if (json) {
	console.info(JSON.stringify(report, null, '\t'));
	process.exit(0);
}

const row = ({ files, raw, gzip }: Totals, key: string) =>
	`  ${String(files).padStart(5)}  ${kb(raw).padStart(8)}  ${kb(gzip).padStart(8)}  ${key}`;
const header = `  ${'files'.padStart(5)}  ${'raw KB'.padStart(8)}  ${'gzip KB'.padStart(8)}`;

console.info('Route and deferred-feature closures (report-only, no budget)');
console.info('Totals count JavaScript chunks only; stylesheets are not included.');
console.info(
	`Entry ${report.entry.key}: ${report.entry.closure.files} JS files, ` +
		`${kb(report.entry.closure.raw)} KB raw, ${kb(report.entry.closure.gzip)} KB gzip`
);
console.info(`\nRoutes (${report.routes.length}), static JS closure beyond the entry closure:`);
console.info(`${header}  page`);
for (const route of report.routes) console.info(row(route.beyondEntry, route.key));
console.info(
	`\nDeferred features (${report.deferred.length}), static JS closure beyond the entry closure:`
);
console.info(`${header}  chunk  [imported by]`);
for (const feature of report.deferred) {
	console.info(`${row(feature.beyondEntry, feature.key)}  [${feature.importers.join(', ')}]`);
}
