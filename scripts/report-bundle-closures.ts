/**
 * Route and deferred-feature closures of the built web app, against their
 * budgets.
 *
 * `check-bundle-budget.ts` keeps the entry closure small, and by design it
 * stops at every `import()`. That protects boot but says nothing about what a
 * page or a lazily loaded feature drags in once it is opened: an editor page,
 * the file library or the assistant can pick up a large static dependency and
 * no check notices. This prints, for every page and every lazy chunk, the
 * static closure that loading it adds on top of the entry closure, with the
 * same reading rules as the entry budget (scripts/bundle-closure.ts), and
 * checks it against its line in `scripts/bundle-closure-budgets.txt`.
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
 * cleanly before and after a change. The run fails (status 1) when a closure
 * is over its budget, when a page or lazy chunk has no budget line, or when a
 * budget line names a closure the build no longer has: each of those is a
 * one-line edit to the budgets file, and the failure prints it. `--json` only
 * records (CI keeps it even for a failing build), so it exits 0 for any sizes.
 * Exit status 2 is an unreadable build or budgets file.
 *
 * The JSON also lists the entry closure's own chunks, and names the commit and
 * build toolchain it was taken from (`BUNDLE_REPORT_SHA`,
 * `BUNDLE_REPORT_TOOLCHAIN`; null when unset). CI keeps it as an artifact per
 * commit, and `report-bundle-delta.ts` compares a pull request's report with
 * its base commit's.
 *
 * Usage: bun scripts/report-bundle-closures.ts [path/to/.output] [--json]
 *          [--budgets path/to/budgets.txt]
 *   (defaults to apps/web/.output and scripts/bundle-closure-budgets.txt;
 *   --json prints the full report, chunk lists included, for diffing two builds)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	type ClosureBudgets,
	type ClosureKind,
	type FileSize,
	dynamicImports,
	kb,
	measure,
	parseClosureBudgets,
	readWebBuild,
	staticClosure,
	suggestedBudgetKiB,
} from './bundle-closure';

const TOOL = 'report-bundle-closures';
const args = process.argv.slice(2);
const json = args.includes('--json');
const budgetsFlag = args.indexOf('--budgets');
const budgetsArg = budgetsFlag === -1 ? undefined : args[budgetsFlag + 1];
if (budgetsFlag !== -1 && !budgetsArg) {
	console.error(`${TOOL}: --budgets needs a file.`);
	process.exit(2);
}
const budgetsPath = budgetsArg
	? resolve(budgetsArg)
	: resolve(import.meta.dirname, 'bundle-closure-budgets.txt');
/** How the output names the budgets file: as given, else repo-relative. */
const budgetsLabel = budgetsArg ?? 'scripts/bundle-closure-budgets.txt';
const { outputDir, publicDir, entry } = readWebBuild(
	TOOL,
	args.find(
		(arg, index) => !arg.startsWith('--') && (budgetsFlag === -1 || index !== budgetsFlag + 1)
	)
);

let budgets: ClosureBudgets;
try {
	budgets = parseClosureBudgets(readFileSync(budgetsPath, 'utf8'));
} catch (error) {
	console.error(`${TOOL}: cannot read the budgets in ${budgetsPath}: ${(error as Error).message}`);
	process.exit(2);
}

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
		/** The budgets file the rows were checked against. */
		budget: basename(budgetsPath),
		sha: process.env['BUNDLE_REPORT_SHA'] || null,
		toolchain: process.env['BUNDLE_REPORT_TOOLCHAIN'] || null,
	},
	// Keyed by source path, not file: the entry carries the build id, so its
	// hashed name changes on every build even when nothing else does.
	entry: {
		key: labels.get(entry) ?? 'entry',
		closure: totals([...entryClosure].sort()),
		// Named like the rest of the report; a chunk the manifest does not name
		// goes by its file, whose hash moves only when its content does.
		chunks: [...entryClosure]
			.map((file) => ({ key: labels.get(file) ?? file, gzip: sizeOf(file).gz }))
			.sort((a, b) => b.gzip - a.gzip || compare(a.key, b.key)),
	},
	routes: routeRoots.sort(byKey).map(({ key, root }) => ({
		key,
		budgetKiB: budgets.route.get(key) ?? null,
		...describe(root),
	})),
	deferred: keyed.sort(byKey).map(({ key, root, importers: from }) => ({
		key,
		budgetKiB: budgets.deferred.get(key) ?? null,
		importers: from,
		...describe(root),
	})),
};

if (json) {
	console.info(JSON.stringify(report, null, '\t'));
	process.exit(0);
}

const budgetCell = (budgetKiB: number | null) =>
	(budgetKiB === null ? '-' : String(budgetKiB)).padStart(9);
const row = ({ files, raw, gzip }: Totals, budgetKiB: number | null, key: string) =>
	`  ${String(files).padStart(5)}  ${kb(raw).padStart(8)}  ${kb(gzip).padStart(8)}  ${budgetCell(budgetKiB)}  ${key}`;
const header = `  ${'files'.padStart(5)}  ${'raw KB'.padStart(8)}  ${'gzip KB'.padStart(8)}  ${'budget KB'.padStart(9)}`;

console.info(`Route and deferred-feature closures (budgets: ${budgetsLabel})`);
console.info('Totals count JavaScript chunks only; stylesheets are not included.');
console.info(
	`Entry ${report.entry.key}: ${report.entry.closure.files} JS files, ` +
		`${kb(report.entry.closure.raw)} KB raw, ${kb(report.entry.closure.gzip)} KB gzip`
);
console.info(`\nRoutes (${report.routes.length}), static JS closure beyond the entry closure:`);
console.info(`${header}  page`);
for (const route of report.routes) console.info(row(route.beyondEntry, route.budgetKiB, route.key));
console.info(
	`\nDeferred features (${report.deferred.length}), static JS closure beyond the entry closure:`
);
console.info(`${header}  chunk  [imported by]`);
for (const feature of report.deferred) {
	console.info(
		`${row(feature.beyondEntry, feature.budgetKiB, feature.key)}  [${feature.importers.join(', ')}]`
	);
}

const checked: [ClosureKind, typeof report.routes | typeof report.deferred][] = [
	['route', report.routes],
	['deferred', report.deferred],
];
const over: string[] = [];
const missing: string[] = [];
const stale: string[] = [];
for (const [kind, rows] of checked) {
	for (const { key, budgetKiB, beyondEntry } of rows) {
		if (budgetKiB === null) {
			missing.push(`${kind} ${suggestedBudgetKiB(beyondEntry.gzip)} ${key}`);
		} else if (beyondEntry.gzip > budgetKiB * 1024) {
			over.push(
				`${kind} ${key}: ${kb(beyondEntry.gzip)} KB gzip, over its ${budgetKiB} KB budget ` +
					`by ${kb(beyondEntry.gzip - budgetKiB * 1024)} KB`
			);
		}
	}
	const present = new Set(rows.map((closure) => closure.key));
	for (const [key, budgetKiB] of budgets[kind]) {
		if (!present.has(key)) stale.push(`${kind} ${budgetKiB} ${key}`);
	}
}

if (over.length > 0) {
	console.error(
		`\n${over.length} closure${over.length === 1 ? ' is' : 's are'} over budget:\n` +
			over.map((line) => `  ${line}`).join('\n') +
			'\nSomething the page or lazy chunk imports statically grew or stopped being lazy. Load it ' +
			'with a dynamic import() or defineAsyncComponent, or import a smaller leaf module. Raise a ' +
			`line in ${budgetsLabel} only with the reason in the pull request: what grew ` +
			'and why it has to load with this page or feature.'
	);
}
if (missing.length > 0) {
	console.error(
		`\n${missing.length} closure${missing.length === 1 ? ' has' : 's have'} no budget. ` +
			`Add ${missing.length === 1 ? 'this line' : 'these lines'} to ${budgetsLabel} ` +
			'(this build plus the larger of 10% and 2 KiB):\n' +
			missing.map((line) => `  ${line}`).join('\n')
	);
}
if (stale.length > 0) {
	console.error(
		`\n${stale.length} budget line${stale.length === 1 ? ' names a closure' : 's name closures'} ` +
			`this build does not have. Delete ${stale.length === 1 ? 'it' : 'them'} from ` +
			`${budgetsLabel}:\n` +
			stale.map((line) => `  ${line}`).join('\n')
	);
}
if (over.length + missing.length + stale.length > 0) process.exit(1);
console.info(`\nEvery route and deferred feature is within its budget.`);
