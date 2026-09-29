/**
 * The app catalog cut into a boot catalog and one chunk per route area.
 *
 * `en.json` is ~600 KB of messages and a visitor used to download all of it
 * before the first screen, sign-in page included. A build now splits it (the
 * source files stay whole: translators keep editing `en.json` / `de.json`):
 *
 * - the BOOT catalog, registered with @nuxtjs/i18n and loaded at start, keeps
 *   the `common`, `shell`, `auth`, `shared` and `sharedPkg` namespaces, every
 *   message a layout, plugin, middleware or auth page can reach, every message
 *   under a key prefix some file assembles at runtime (a template literal such
 *   as `dashboard.inbox.detail.${x}`), every message the backend or another
 *   package names, and every message no scanned file names at all;
 * - each AREA chunk (`/dashboard/admin/**`, `/dashboard/postbox/**`, `/setup/**`,
 *   ...) carries the remaining messages that the area's pages can reach. A
 *   message two areas reach is in both chunks.
 *
 * "Reach" is ./sourceGraph.ts: imports, auto-imported components and
 * composables. The runtime half (./areaRuntime.ts) loads an area's chunk before
 * the route renders.
 */
import { join, relative } from 'node:path';
import type { AreaRouteEntry as AreaRoute } from './areaRuntime';
import type { MessageCatalog } from './completeCatalogs';
import { reachableFrom, type SourceGraph } from './sourceGraph';

export interface CatalogPlan {
	/** Leaf key → the areas whose chunk carries it. A key not listed is in the boot catalog. */
	readonly areasByKey: ReadonlyMap<string, ReadonlySet<string>>;
	/** The areas that have a chunk, with the route each loads on. */
	readonly routes: readonly AreaRoute[];
}

/** Namespaces every screen shares; the plan keeps them in the boot catalog whole. */
export const BOOT_NAMESPACES = [
	'common',
	'shell',
	'auth',
	'shared',
	'sharedPkg',
	'components.shell',
];

/** Files that run on every route, in the app and in each layer. */
const ALWAYS_ON_DIRS = ['layouts', 'plugins', 'middleware'];
const ALWAYS_ON_FILES = ['app.vue', 'error.vue'];

/**
 * The area a page file (relative to `pages/`) belongs to, or `null` for a page
 * whose messages ship in the boot catalog: the auth pages, the root page, and
 * any page whose area segment is dynamic.
 */
export function pageArea(relativePath: string): AreaRoute | null {
	const segments = relativePath.replace(/\.vue$/, '').split('/');
	const [first, second] = segments;
	if (!first || first === 'auth' || first === 'index' || first.startsWith('[')) return null;
	if (first === 'dashboard') {
		// `pages/dashboard.vue` would wrap every dashboard route.
		if (segments.length === 1) return null;
		if (second === 'index' && segments.length === 2) {
			return { path: '/dashboard', exact: true, area: 'dashboard' };
		}
		if (!second || /[[(]/.test(second)) return null;
		return { path: `/dashboard/${second}`, exact: false, area: `dashboard-${second}` };
	}
	if (/[[(]/.test(first)) return null;
	return { path: `/${first}`, exact: false, area: first };
}

/** A dotted token that could be a message key: `dashboard.admin.title`. */
const KEY_TOKEN = /(?<![\w$.\-/])([A-Za-z_][\w-]*(?:\.[\w-]+)+)/g;

type Node = string | MessageCatalog | undefined;

function nodeAt(catalog: MessageCatalog, path: string): Node {
	let node: Node = catalog;
	for (const segment of path.split('.')) {
		if (typeof node !== 'object' || !Object.hasOwn(node, segment)) return undefined;
		node = node[segment];
	}
	return node;
}

export function leafKeys(catalog: MessageCatalog, prefix = ''): string[] {
	return Object.entries(catalog).flatMap(([key, value]) => {
		const path = prefix ? `${prefix}.${key}` : key;
		return typeof value === 'string' ? [path] : leafKeys(value, path);
	});
}

interface KeyReferences {
	/** Full keys named literally. */
	readonly leaves: Set<string>;
	/** Namespaces named as the stem of a key built at runtime. */
	readonly prefixes: Set<string>;
}

export function keyReferences(catalog: MessageCatalog, source: string): KeyReferences {
	const refs: KeyReferences = { leaves: new Set(), prefixes: new Set() };
	for (const match of source.matchAll(KEY_TOKEN)) {
		const node = nodeAt(catalog, match[1]!);
		if (typeof node === 'string') refs.leaves.add(match[1]!);
		else if (node !== undefined) refs.prefixes.add(match[1]!);
	}
	return refs;
}

const isUnder = (key: string, prefix: string) => key === prefix || key.startsWith(`${prefix}.`);

export interface PlanInput {
	readonly catalog: MessageCatalog;
	readonly graph: SourceGraph;
	/** The app's `srcDir` and each layer root, to find pages and always-on files. */
	readonly appDir: string;
	readonly layerDirs: readonly string[];
	/** Source text outside the graph (the Convex backend, Nitro routes, packages). */
	readonly externalSources: Iterable<string>;
}

export function planCatalogAreas(input: PlanInput): CatalogPlan {
	const { catalog, graph } = input;
	const files = [...graph.sources.keys()];
	const inDir = (file: string, dir: string) => !relative(dir, file).startsWith('..');

	const pagesDir = join(input.appDir, 'pages');
	const routeByArea = new Map<string, AreaRoute>();
	const pagesByArea = new Map<string, string[]>();
	const alwaysOn: string[] = [];
	for (const file of files) {
		if (inDir(file, pagesDir) && file.endsWith('.vue')) {
			const route = pageArea(relative(pagesDir, file));
			if (!route) {
				alwaysOn.push(file);
				continue;
			}
			routeByArea.set(route.area, route);
			pagesByArea.set(route.area, [...(pagesByArea.get(route.area) ?? []), file]);
		}
	}
	for (const root of [input.appDir, ...input.layerDirs]) {
		for (const file of files) {
			const rel = relative(root, file);
			if (
				ALWAYS_ON_FILES.includes(rel) ||
				ALWAYS_ON_DIRS.some((dir) => inDir(file, join(root, dir)))
			) {
				alwaysOn.push(file);
			}
		}
	}

	const boot = reachableFrom(graph, alwaysOn);
	const areasOfFile = new Map<string, Set<string>>();
	for (const [area, pages] of pagesByArea) {
		for (const file of reachableFrom(graph, pages)) {
			if (boot.has(file)) continue;
			areasOfFile.set(file, (areasOfFile.get(file) ?? new Set()).add(area));
		}
	}

	const bootPrefixes = new Set(BOOT_NAMESPACES);
	const bootKeys = new Set<string>();
	const filesByKey = new Map<string, string[]>();
	for (const [file, source] of graph.sources) {
		const refs = keyReferences(catalog, source);
		for (const prefix of refs.prefixes) bootPrefixes.add(prefix);
		for (const key of refs.leaves) filesByKey.set(key, [...(filesByKey.get(key) ?? []), file]);
	}
	for (const source of input.externalSources) {
		const refs = keyReferences(catalog, source);
		for (const prefix of refs.prefixes) bootPrefixes.add(prefix);
		for (const key of refs.leaves) bootKeys.add(key);
	}

	const areasByKey = new Map<string, Set<string>>();
	for (const key of leafKeys(catalog)) {
		if (bootKeys.has(key) || [...bootPrefixes].some((prefix) => isUnder(key, prefix))) continue;
		const referencing = filesByKey.get(key) ?? [];
		// Named nowhere, or by a file every route or no route can render: boot.
		if (referencing.length === 0 || referencing.some((file) => !areasOfFile.has(file))) continue;
		areasByKey.set(key, new Set(referencing.flatMap((file) => [...areasOfFile.get(file)!])));
	}

	const withChunks = new Set([...areasByKey.values()].flatMap((areas) => [...areas]));
	const routes = [...routeByArea.values()]
		.filter((route) => withChunks.has(route.area))
		.sort((a, b) => a.path.localeCompare(b.path));
	return { areasByKey, routes };
}

function setAt(target: MessageCatalog, key: string, value: string): void {
	const segments = key.split('.');
	let node = target;
	for (const segment of segments.slice(0, -1)) {
		const next = node[segment];
		node = typeof next === 'object' ? next : (node[segment] = {});
	}
	node[segments.at(-1)!] = value;
}

export interface SplitCatalog {
	readonly boot: MessageCatalog;
	readonly areas: Record<string, MessageCatalog>;
}

/** `catalog` cut along `plan`: each message in the boot catalog or in each chunk the plan names. */
export function splitCatalog(catalog: MessageCatalog, plan: CatalogPlan): SplitCatalog {
	const boot: MessageCatalog = {};
	const areas: Record<string, MessageCatalog> = {};
	for (const key of leafKeys(catalog)) {
		const value = nodeAt(catalog, key) as string;
		const keyAreas = plan.areasByKey.get(key);
		if (!keyAreas) {
			setAt(boot, key, value);
			continue;
		}
		for (const area of keyAreas) setAt((areas[area] ??= {}), key, value);
	}
	return { boot, areas };
}

/** @intlify's own HTML-tag test (`detectHtmlTag`). */
const HTML_TAG = /<\/?[\w\s="/.':;#-/]+>/;

/**
 * Keys whose message contains HTML. The boot catalog goes through
 * @nuxtjs/i18n's compiler, which rejects these (`compilation.strictMessage`);
 * the chunks are loaded as plain JSON, so the build applies the same rule to
 * them itself.
 */
export function htmlMessageKeys(catalog: MessageCatalog): string[] {
	return leafKeys(catalog).filter((key) => HTML_TAG.test(nodeAt(catalog, key) as string));
}
