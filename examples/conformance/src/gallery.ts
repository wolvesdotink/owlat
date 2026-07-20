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
	/**
	 * Whether the plugin ships in-process contribution modules. A Tier-2
	 * connected app deliberately ships none: its code runs out of process and
	 * re-enters Owlat only as a restrict-only hook verdict.
	 */
	readonly hasBundledContributions: boolean;
}

/**
 * Core sidebar section keys a `navItems` contribution may target. Pinned here
 * because `buildNavigationSections` DROPS an item whose section is unknown
 * (fail-closed), so a typo silently deletes the entry instead of failing. The
 * authoritative list is `CORE_SECTIONS` in
 * `apps/web/app/lib/dashboardNavigation.ts`, itself pinned by the
 * "registers the full core section order" test in that app; if the two ever
 * disagree, that test and this constant fail together.
 */
export const CORE_NAV_SECTION_KEYS: readonly string[] = Object.freeze([
	'inbox',
	'postbox',
	'chat',
	'assistant',
	'send',
	'audience',
	'delivery',
	'knowledge',
	'settings',
]);

export const REFERENCE_GALLERY: readonly GalleryEntry[] = Object.freeze([
	Object.freeze({
		tier: 1,
		packageName: '@owlat/example-escalation-guard',
		directory: 'examples/plugins/escalation-guard',
		manifest: escalationGuardPlugin,
		hasBundledContributions: true,
	}),
	Object.freeze({
		tier: 2,
		packageName: '@owlat/example-slack-approvals',
		directory: 'examples/plugins/slack-approvals',
		manifest: slackApprovalsPlugin,
		hasBundledContributions: false,
	}),
	Object.freeze({
		tier: 3,
		packageName: '@owlat/example-deliverability-lab',
		directory: 'examples/plugins/deliverability-lab',
		manifest: deliverabilityLabPlugin,
		hasBundledContributions: true,
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
