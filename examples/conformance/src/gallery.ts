/**
 * The reference gallery: one maintained plugin per trust tier, described once so
 * every conformance suite iterates the SAME set. Adding a fourth reference means
 * adding one entry here; the lifecycle, replay and gallery suites pick it up
 * without edits, which is what keeps the examples from rotting.
 *
 * Each entry carries the plugin's REAL manifest — imported from the example
 * package, not re-declared — so a manifest change is exercised by the whole
 * gallery on the next test run.
 */

import { deliverabilityLabPlugin } from '@owlat/example-deliverability-lab';
import { escalationGuardPlugin } from '@owlat/example-escalation-guard';
import { slackApprovalsPlugin } from '@owlat/example-slack-approvals';
import type { PluginManifest } from '@owlat/plugin-kit';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readRepositoryFile, REPOSITORY_ROOT } from './repository';

/**
 * 1 = bundled, in-process. 2 = connected app over the signed hook protocol.
 * 3 = sandboxed worker job. A plugin is filed under the HIGHEST tier it uses.
 */
export type PluginTier = 1 | 2 | 3;

export interface GalleryEntry {
	readonly tier: PluginTier;
	/** Published package name used when the plugin is bundled into a deployment. */
	readonly packageName: string;
	/** Workspace directory, relative to the repository root. */
	readonly directory: string;
	readonly manifest: PluginManifest;
}

const DASHBOARD_NAVIGATION_PATH = 'apps/web/app/lib/dashboardNavigation.ts';
const CORE_SECTIONS_DECLARATION = 'const CORE_SECTIONS: readonly CoreSection[] = [';

/**
 * The core sidebar section keys a `navItems` contribution may target, READ FROM
 * the app rather than copied here. `buildNavigationSections` drops an item whose
 * section is unknown (fail-closed), so a section key that drifts out of the core
 * set silently deletes the entry instead of failing — exactly the bug the
 * deliverability-lab nav fix in this piece repairs.
 *
 * A local copy would only ever pin the copy: renaming a core section key would
 * leave this suite green. Extracting the keys from the source of truth means a
 * rename turns the gallery red until every reference targets a section that
 * still exists. Throws if the declaration moves, so the derivation can never
 * silently degrade to an empty set.
 */
export async function readCoreNavSectionKeys(): Promise<readonly string[]> {
	const source = await readRepositoryFile(DASHBOARD_NAVIGATION_PATH);
	const start = source.indexOf(CORE_SECTIONS_DECLARATION);
	if (start < 0) {
		throw new Error(
			`${DASHBOARD_NAVIGATION_PATH} no longer declares "${CORE_SECTIONS_DECLARATION}"; update the gallery derivation`
		);
	}
	const end = source.indexOf('\n];', start);
	if (end < 0) {
		throw new Error(`${DASHBOARD_NAVIGATION_PATH}: could not find the end of CORE_SECTIONS`);
	}
	// Top-level section entries only: they are the sole `key:` two tabs deep.
	const keys: string[] = [];
	for (const match of source.slice(start, end).matchAll(/\n\t\tkey: '([a-z][a-z0-9-]*)',/g)) {
		const key = match[1];
		if (key !== undefined) keys.push(key);
	}
	if (keys.length === 0) {
		throw new Error(`${DASHBOARD_NAVIGATION_PATH}: found no core section keys`);
	}
	return Object.freeze(keys);
}

const DASHBOARD_PAGES_DIRECTORY = 'apps/web/app/pages';

/**
 * Every dashboard route the Nuxt build actually produces, as a matcher, READ
 * FROM the pages directory rather than listed here.
 *
 * A plugin cannot ship a page: no arbitrary browser code is loaded at runtime
 * and codegen emits no routes, so a `navItems`/`settingsPanels` `href` that no
 * page backs renders a working-looking link onto a 404. Deriving the route set
 * from disk means deleting or renaming a page turns the gallery red instead of
 * leaving a reference manifest pointing at nothing.
 */
export async function readDashboardRouteMatchers(): Promise<
	readonly { readonly route: string; matches: (href: string) => boolean }[]
> {
	const matchers: { route: string; matches: (href: string) => boolean }[] = [];
	async function walk(relative: string): Promise<void> {
		const entries = await readdir(join(REPOSITORY_ROOT, DASHBOARD_PAGES_DIRECTORY, relative), {
			withFileTypes: true,
		});
		for (const entry of entries) {
			const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
			if (entry.isDirectory()) {
				if (entry.name !== '__tests__') await walk(child);
				continue;
			}
			if (!entry.name.endsWith('.vue')) continue;
			const route = `/${child.replace(/\.vue$/, '').replace(/\/index$/, '')}`;
			// A `[param]` segment matches one non-empty path segment.
			const pattern = new RegExp(
				`^${route
					.split('/')
					.map((segment) =>
						/^\[.+\]$/.test(segment)
							? '[^/]+'
							: segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
					)
					.join('/')}$`
			);
			matchers.push({ route, matches: (href) => pattern.test(href) });
		}
	}
	await walk('');
	if (matchers.length === 0) {
		throw new Error(`${DASHBOARD_PAGES_DIRECTORY}: found no pages; update the gallery derivation`);
	}
	return Object.freeze(matchers);
}

/** Every navigation/settings destination a manifest declares, with its origin. */
export function navigationHrefs(
	manifest: PluginManifest
): readonly { readonly bucket: string; readonly id: string; readonly href: string }[] {
	const contributes = manifest.contributes as
		| Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>
		| undefined;
	if (!contributes) return [];
	return ['navItems', 'settingsPanels'].flatMap((bucket) =>
		(contributes[bucket] ?? [])
			.filter((entry) => typeof entry.href === 'string')
			.map((entry) => ({ bucket, id: String(entry.id), href: String(entry.href) }))
	);
}

export const REFERENCE_GALLERY: readonly GalleryEntry[] = Object.freeze([
	Object.freeze({
		tier: 1,
		packageName: '@owlat/example-escalation-guard',
		directory: 'examples/plugins/escalation-guard',
		manifest: escalationGuardPlugin,
	}),
	Object.freeze({
		tier: 2,
		packageName: '@owlat/example-slack-approvals',
		directory: 'examples/plugins/slack-approvals',
		manifest: slackApprovalsPlugin,
	}),
	Object.freeze({
		tier: 3,
		packageName: '@owlat/example-deliverability-lab',
		directory: 'examples/plugins/deliverability-lab',
		manifest: deliverabilityLabPlugin,
	}),
]);

/**
 * Live contribution buckets (`PLUGIN_LIVE_CONTRIBUTION_KINDS`) that no reference
 * contributes to, with the reason each one cannot have a maintained example.
 *
 * The gallery cannot honestly claim to cover every live bucket, so it names the
 * gap instead of leaving it unstated: `gallery.test.ts` asserts that live minus
 * covered is EXACTLY this set, which means a thirteenth live bucket landing in
 * the kernel — or a reference quietly dropping a contribution — turns the final
 * conformance gate red naming the bucket.
 */
export const UNCOVERED_LIVE_BUCKETS: Readonly<Record<string, string>> = Object.freeze({
	sendTransports:
		'a maintained example would need a real ESP account and credentials to send through',
	importProviders: 'a maintained example would need a real vendor account to import from',
});

/** Look up one reference by tier; throws rather than returning undefined. */
export function galleryEntry(tier: PluginTier): GalleryEntry {
	const entry = REFERENCE_GALLERY.find((candidate) => candidate.tier === tier);
	if (!entry) throw new Error(`No reference plugin is registered for tier ${tier}`);
	return entry;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null;
}

/**
 * Every `module.exportPath` a manifest points at, deduplicated and sorted.
 *
 * Contribution buckets are heterogeneous and only some kinds carry a module, so
 * this walks them structurally. It narrows with a guard rather than asserting a
 * shape: this function is the pin the published-package-shape suite trusts, and
 * an assertion here would be a claim the compiler stops checking.
 */
export function contributionExportPaths(manifest: PluginManifest): readonly string[] {
	const paths = new Set<string>();
	const contributes = manifest.contributes ?? {};
	for (const bucket of Object.values(contributes)) {
		if (!Array.isArray(bucket)) continue;
		for (const contribution of bucket) {
			if (!isRecord(contribution)) continue;
			const module = contribution['module'];
			if (!isRecord(module)) continue;
			const exportPath = module['exportPath'];
			if (typeof exportPath === 'string') paths.add(exportPath);
		}
	}
	return [...paths].sort();
}
