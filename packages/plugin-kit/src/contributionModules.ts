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
	/**
	 * The contribution field the module hangs off, when it is not the
	 * contribution's own `module` — today only `'webhook'`, the send transport's
	 * feedback half. Absent for the contribution's primary module.
	 */
	readonly role?: string;
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
 * The same reasoning applies one level DOWN. A contribution can carry a second
 * executable half on a named field — the send transport's `webhook` (D6) is the
 * first — and that half is imported into generated Convex code exactly like the
 * primary one, so it must be provenance-verified exactly like the primary one.
 * Nested fields are therefore walked structurally too, in sorted field order for
 * determinism, rather than by naming `webhook` here.
 *
 * Order is bucket-declaration order, then declaration order within the bucket,
 * then the entry's own module before its nested ones, so codegen diagnostics are
 * deterministic.
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
			const id = typeof entry['id'] === 'string' ? (entry['id'] as string) : '';
			const own = exportPathOf(entry);
			if (own !== undefined) modules.push({ bucket, id, exportPath: own });
			for (const field of Object.keys(entry).sort()) {
				if (field === 'module') continue;
				const nested = entry[field];
				if (!isRecord(nested)) continue;
				const exportPath = exportPathOf(nested);
				if (exportPath !== undefined) modules.push({ bucket, id, exportPath, role: field });
			}
		}
	}
	return Object.freeze(modules);
}

/** The `module.exportPath` a descriptor declares, when it declares one. */
function exportPathOf(descriptor: Readonly<Record<string, unknown>>): string | undefined {
	const module = descriptor['module'];
	if (!isRecord(module)) return undefined;
	const exportPath = module['exportPath'];
	return typeof exportPath === 'string' ? exportPath : undefined;
}

/** The distinct export paths of {@link pluginContributionModules}, sorted. */
export function pluginContributionExportPaths(manifest: PluginManifest): readonly string[] {
	return Object.freeze(
		[...new Set(pluginContributionModules(manifest).map((module) => module.exportPath))].sort()
	);
}
