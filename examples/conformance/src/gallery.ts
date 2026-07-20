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
import { readRepositoryFile } from './repository';

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
	const keys = [...source.slice(start, end).matchAll(/\n\t\tkey: '([a-z][a-z0-9-]*)',/g)].map(
		(match) => match[1] as string
	);
	if (keys.length === 0) {
		throw new Error(`${DASHBOARD_NAVIGATION_PATH}: found no core section keys`);
	}
	return Object.freeze(keys);
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

/** Look up one reference by tier; throws rather than returning undefined. */
export function galleryEntry(tier: PluginTier): GalleryEntry {
	const entry = REFERENCE_GALLERY.find((candidate) => candidate.tier === tier);
	if (!entry) throw new Error(`No reference plugin is registered for tier ${tier}`);
	return entry;
}

/** Every `module.exportPath` a manifest points at, deduplicated and sorted. */
export function contributionExportPaths(manifest: PluginManifest): readonly string[] {
	const paths = new Set<string>();
	const contributes = manifest.contributes ?? {};
	for (const bucket of Object.values(contributes)) {
		if (!Array.isArray(bucket)) continue;
		for (const contribution of bucket) {
			if (contribution === null || typeof contribution !== 'object') continue;
			const module = (contribution as { readonly module?: { readonly exportPath?: unknown } })
				.module;
			if (module && typeof module.exportPath === 'string') paths.add(module.exportPath);
		}
	}
	return [...paths].sort();
}
