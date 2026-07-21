import { PLUGIN_CONTRIBUTION_KINDS, type PluginContributionKind } from './contributions';
import type { PluginManifest } from './manifest';

/**
 * One executable half a manifest declares: the bucket it came from, the
 * contribution's local id, and the package export path that ships its module.
 */
export interface PluginContributionModuleReference {
	readonly bucket: PluginContributionKind;
	readonly id: string;
	readonly exportPath: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every executable module a manifest declares, found STRUCTURALLY rather than by
 * naming the buckets that happen to have one today.
 *
 * Codegen must provenance-verify every declared export path — resolve it through
 * the installed package's `exports` map, reject a condition-dependent target,
 * and assert the resolved file exists inside the package root — before it emits
 * an import of it into generated Convex code. Enumerating the executable buckets
 * at the call site is how four of them (crons and the three automation
 * registries) shipped without that check: a later piece added a bucket and no
 * one remembered the loop. Anything carrying `module.exportPath` is executable
 * by construction, so a bucket added tomorrow is verified with no edit here.
 *
 * Order is bucket-declaration order, then declaration order within the bucket,
 * so codegen diagnostics are deterministic.
 */
export function pluginContributionModules(
	manifest: PluginManifest
): readonly PluginContributionModuleReference[] {
	const contributes = manifest.contributes;
	if (!isRecord(contributes)) return [];
	const modules: PluginContributionModuleReference[] = [];
	for (const bucket of PLUGIN_CONTRIBUTION_KINDS) {
		const entries = contributes[bucket];
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (!isRecord(entry)) continue;
			const module = entry['module'];
			if (!isRecord(module)) continue;
			const exportPath = module['exportPath'];
			if (typeof exportPath !== 'string') continue;
			const id = entry['id'];
			modules.push({ bucket, id: typeof id === 'string' ? id : '', exportPath });
		}
	}
	return Object.freeze(modules);
}

/** The distinct export paths of {@link pluginContributionModules}, sorted. */
export function pluginContributionExportPaths(manifest: PluginManifest): readonly string[] {
	return Object.freeze(
		[...new Set(pluginContributionModules(manifest).map((module) => module.exportPath))].sort()
	);
}
