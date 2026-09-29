/**
 * Write the build's catalogs: per locale, the boot catalog @nuxtjs/i18n
 * registers (`i18nBuildLocales`) and one chunk per route area, plus the
 * manifest the runtime loads them by (`#build/owlat-i18n-areas.mjs`, see
 * ./catalogModule.ts).
 *
 * Runs before @nuxtjs/i18n reads its locale files. The dev server writes
 * nothing and registers the plain source files whole.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AreaRouteEntry } from './areaRuntime';
import { htmlMessageKeys, planCatalogAreas, splitCatalog, type CatalogPlan } from './catalogAreas';
import {
	bootCatalogPath,
	completeCatalogs,
	type MessageCatalog,
	OUTPUT_DIR,
	SOURCE_LOCALE,
	USES_COMPLETE_CATALOGS,
} from './completeCatalogs';
import { I18N_LOCALES } from './localeOptions';
import { buildSourceGraph, listSourceFiles, type SourceRoots } from './sourceGraph';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = join(WEB_DIR, '../..');

/** The app and the `packages/ui` layer it extends (nuxt.config `extends`). */
export const SOURCE_ROOTS: SourceRoots = {
	appDir: join(WEB_DIR, 'app'),
	rootDir: WEB_DIR,
	layerDirs: [join(REPO_DIR, 'packages/ui')],
};

/**
 * Code outside the app graph that can hand the app a message key (a Convex
 * error, a Nitro route, a shared registry). A key it names ships at boot. The
 * desktop bridge the app imports (`@owlat/desktop/src/...`) is scanned when the
 * checkout has it.
 */
const EXTERNAL_SOURCE_DIRS = ['apps/api/convex', 'apps/web/server', 'packages'];
const OPTIONAL_EXTERNAL_SOURCE_DIRS = ['apps/desktop/src'];

export interface AreaManifest {
	readonly routes: readonly AreaRouteEntry[];
	/** Area → locale → absolute path of the chunk. */
	readonly chunks: Readonly<Record<string, Readonly<Record<string, string>>>>;
	/** The catalog's top-level namespaces. */
	readonly roots: readonly string[];
}

const EMPTY_MANIFEST: AreaManifest = { routes: [], chunks: {}, roots: [] };

/**
 * The split plan for the source catalog, or `null` when a source tree the scan
 * depends on is missing (a build context that copied only part of the repo):
 * every message then ships at boot rather than risk one missing from a chunk.
 */
export function planSourceCatalog(source: MessageCatalog): CatalogPlan | null {
	const external = EXTERNAL_SOURCE_DIRS.map((dir) => join(REPO_DIR, dir));
	const missing = [...external, SOURCE_ROOTS.appDir, ...SOURCE_ROOTS.layerDirs].filter(
		(dir) => !existsSync(dir)
	);
	if (missing.length > 0) {
		console.warn(
			`[owlat-i18n] ${missing.join(', ')} not found; shipping the whole catalog at boot.`
		);
		return null;
	}
	return planCatalogAreas({
		catalog: source,
		graph: buildSourceGraph(SOURCE_ROOTS),
		appDir: SOURCE_ROOTS.appDir,
		layerDirs: SOURCE_ROOTS.layerDirs,
		externalSources: (function* () {
			const optional = OPTIONAL_EXTERNAL_SOURCE_DIRS.map((dir) => join(REPO_DIR, dir));
			for (const dir of [...external, ...optional]) {
				for (const file of listSourceFiles(dir)) yield readFileSync(file, 'utf8');
			}
		})(),
	});
}

export const areaChunkPath = (area: string, locale: string) =>
	join(OUTPUT_DIR, 'areas', `${area}.${locale}.json`);

const writeJson = (path: string, value: unknown) =>
	writeFileSync(path, `${JSON.stringify(value)}\n`);

export function writeBuildCatalogs(): AreaManifest {
	if (!USES_COMPLETE_CATALOGS) return EMPTY_MANIFEST;
	const catalogs = completeCatalogs();
	const source = catalogs.get(SOURCE_LOCALE)!;
	const plan = planSourceCatalog(source) ?? { areasByKey: new Map(), routes: [] };

	mkdirSync(join(OUTPUT_DIR, 'boot'), { recursive: true });
	// A renamed or emptied area must not leave a stale chunk behind.
	rmSync(join(OUTPUT_DIR, 'areas'), { recursive: true, force: true });
	mkdirSync(join(OUTPUT_DIR, 'areas'), { recursive: true });

	const chunks: Record<string, Record<string, string>> = {};
	for (const { code, file } of I18N_LOCALES) {
		const split = splitCatalog(catalogs.get(code)!, plan);
		writeJson(bootCatalogPath(file), split.boot);
		for (const [area, messages] of Object.entries(split.areas)) {
			const html = htmlMessageKeys(messages);
			if (html.length > 0) {
				throw new Error(`[owlat-i18n] HTML in ${code} messages: ${html.join(', ')}`);
			}
			const path = areaChunkPath(area, code);
			writeJson(path, messages);
			(chunks[area] ??= {})[code] = path;
		}
	}
	return { routes: plan.routes, chunks, roots: Object.keys(source) };
}

/** The `#build/owlat-i18n-areas.mjs` module: routes, namespaces and one lazy import per chunk. */
export function areaManifestModule(manifest: AreaManifest): string {
	const chunks = Object.entries(manifest.chunks).map(([area, locales]) => {
		const imports = Object.entries(locales).map(
			// Forward slashes: a Windows path's backslashes are not an import specifier.
			([locale, path]) =>
				`${JSON.stringify(locale)}: () => import(${JSON.stringify(path.replaceAll('\\', '/'))})`
		);
		return `\t${JSON.stringify(area)}: { ${imports.join(', ')} },`;
	});
	return [
		`export const areaRoutes = ${JSON.stringify(manifest.routes)};`,
		`export const messageRoots = ${JSON.stringify(manifest.roots)};`,
		`export const areaChunks = {\n${chunks.join('\n')}\n};`,
		'',
	].join('\n');
}

export const AREA_MANIFEST_TYPES = `declare module '#build/owlat-i18n-areas.mjs' {
	export const areaRoutes: ReadonlyArray<{ path: string; exact: boolean; area: string }>;
	export const messageRoots: readonly string[];
	export const areaChunks: Readonly<
		Record<string, Readonly<Record<string, () => Promise<{ default: Record<string, unknown> }>>>>
	>;
}
`;
