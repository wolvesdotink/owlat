import { parsePluginManifest, type PluginManifest } from '@owlat/plugin-kit';

const MAX_BUNDLED_PLUGINS = 128;

export interface BundledPluginSource {
	readonly packageName: string;
	readonly manifest: unknown;
}

export interface BundledPlugin {
	readonly packageName: string;
	readonly manifest: PluginManifest;
}

export type PluginCompositionErrorCode =
	| 'duplicate_manifest_id'
	| 'duplicate_package'
	| 'too_many_plugins';

export class PluginCompositionError extends Error {
	readonly code: PluginCompositionErrorCode;
	readonly value?: string;

	constructor(code: PluginCompositionErrorCode, message: string, value?: string) {
		super(message);
		this.name = 'PluginCompositionError';
		this.code = code;
		this.value = value;
	}
}

/** Validate and deterministically order the manifests at the one build-time composition point. */
export function composeBundledPlugins(
	sources: readonly BundledPluginSource[]
): readonly BundledPlugin[] {
	if (sources.length > MAX_BUNDLED_PLUGINS) {
		throw new PluginCompositionError(
			'too_many_plugins',
			`A deployment may compose at most ${MAX_BUNDLED_PLUGINS} bundled plugins`
		);
	}

	const packageNames = new Set<string>();
	const manifestIds = new Set<string>();
	const plugins = sources.map(({ packageName, manifest }) => {
		if (packageNames.has(packageName)) {
			throw new PluginCompositionError(
				'duplicate_package',
				`Bundled plugin package ${packageName} is listed more than once`,
				packageName
			);
		}
		packageNames.add(packageName);

		const parsedManifest = parsePluginManifest(manifest);
		if (manifestIds.has(parsedManifest.id)) {
			throw new PluginCompositionError(
				'duplicate_manifest_id',
				`Bundled plugin manifest id ${parsedManifest.id} is declared more than once`,
				parsedManifest.id
			);
		}
		manifestIds.add(parsedManifest.id);

		return Object.freeze({ packageName, manifest: parsedManifest });
	});

	plugins.sort((left, right) => compareCodePoints(left.manifest.id, right.manifest.id));
	return Object.freeze(plugins);
}

function compareCodePoints(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
