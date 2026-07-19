import {
	loadBundledPlugins,
	type PackageLoadingOptions,
	PluginCodegenError,
} from '@owlat/plugin-codegen';
import { PluginCompositionError, type PluginPackageName } from '@owlat/plugin-host';
import { PluginCliError } from './errors';

/** One bundled plugin's declared capability ceiling, as previewed by the CLI. */
export interface PluginCapabilitySummary {
	readonly packageName: PluginPackageName;
	readonly id: string;
	readonly capabilities: readonly string[];
}

/** The capability delta between the current and a proposed bundled-plugin set. */
export interface CapabilityDiff {
	readonly before: readonly PluginCapabilitySummary[];
	readonly after: readonly PluginCapabilitySummary[];
	readonly addedPlugins: readonly PluginCapabilitySummary[];
	readonly removedPlugins: readonly PluginCapabilitySummary[];
	/** Capabilities newly requestable by the composition (union across all plugins). */
	readonly addedCapabilities: readonly string[];
	/** Capabilities no longer requestable by any bundled plugin. */
	readonly removedCapabilities: readonly string[];
	/**
	 * Set when the CURRENT bundled set could not be loaded (for example when the
	 * package being removed is itself broken). The proposed set is still fully
	 * validated, so the mutation can proceed; only the before/after arithmetic is
	 * unavailable and is reported as such instead of silently misleading.
	 */
	readonly beforeUnavailableReason?: string;
}

/**
 * Compute the capability diff a mutation would produce.
 *
 * Both sets are resolved through the PP-03 verified loader, which imports only
 * the lockfile-pinned, provenance-checked manifest entry of each bundled
 * package (never the config file, never an arbitrary path, and never a
 * contribution or component module). Loading the proposed set is also the
 * validation gate: a package that is missing, mis-pinned, or exports an invalid
 * manifest fails here — before any file is written — as a `PluginCliError`.
 */
export async function computeCapabilityDiff(
	workspaceRoot: string,
	before: readonly PluginPackageName[],
	after: readonly PluginPackageName[],
	options: PackageLoadingOptions = {}
): Promise<CapabilityDiff> {
	// The proposed set is the state we commit to, so it is validated strictly.
	const afterSummaries = await summarize(workspaceRoot, after, options);

	let beforeSummaries: readonly PluginCapabilitySummary[];
	let beforeUnavailableReason: string | undefined;
	try {
		beforeSummaries = await summarize(workspaceRoot, before, options);
	} catch (cause) {
		if (!(cause instanceof PluginCliError)) throw cause;
		beforeSummaries = [];
		beforeUnavailableReason = cause.message;
	}

	if (beforeUnavailableReason !== undefined) {
		return {
			before: [],
			after: afterSummaries,
			addedPlugins: [],
			removedPlugins: [],
			addedCapabilities: [],
			removedCapabilities: [],
			beforeUnavailableReason,
		};
	}

	const beforeIds = new Set(beforeSummaries.map((plugin) => plugin.packageName));
	const afterIds = new Set(afterSummaries.map((plugin) => plugin.packageName));
	const beforeCapabilities = unionCapabilities(beforeSummaries);
	const afterCapabilities = unionCapabilities(afterSummaries);

	return {
		before: beforeSummaries,
		after: afterSummaries,
		addedPlugins: afterSummaries.filter((plugin) => !beforeIds.has(plugin.packageName)),
		removedPlugins: beforeSummaries.filter((plugin) => !afterIds.has(plugin.packageName)),
		addedCapabilities: difference(afterCapabilities, beforeCapabilities),
		removedCapabilities: difference(beforeCapabilities, afterCapabilities),
	};
}

async function summarize(
	workspaceRoot: string,
	packages: readonly PluginPackageName[],
	options: PackageLoadingOptions
): Promise<readonly PluginCapabilitySummary[]> {
	let plugins;
	try {
		plugins = await loadBundledPlugins(workspaceRoot, packages, options);
	} catch (cause) {
		if (cause instanceof PluginCodegenError || cause instanceof PluginCompositionError) {
			throw new PluginCliError(cause.message, [], { cause });
		}
		throw cause;
	}
	return plugins.map((plugin) => ({
		packageName: plugin.packageName,
		id: plugin.manifest.id,
		capabilities: [...plugin.manifest.capabilities].sort(compareStrings),
	}));
}

function unionCapabilities(summaries: readonly PluginCapabilitySummary[]): Set<string> {
	const capabilities = new Set<string>();
	for (const summary of summaries) {
		for (const capability of summary.capabilities) capabilities.add(capability);
	}
	return capabilities;
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): readonly string[] {
	return [...left].filter((value) => !right.has(value)).sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
