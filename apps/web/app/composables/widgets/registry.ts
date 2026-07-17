import { orderHostedContributions, type HostedContribution } from '@owlat/plugin-host';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import type { WidgetModule, WidgetRegistry, WidgetResolution } from './types';

export type WidgetRegistryErrorCode =
	| 'duplicate_core_kind'
	| 'plugin_kind_collision'
	| 'contribution_id_mismatch'
	| 'source_mismatch';

/** Fail-closed composition error: a contribution violates a registry invariant. */
export class WidgetRegistryError extends Error {
	readonly code: WidgetRegistryErrorCode;
	readonly kind: string;

	constructor(code: WidgetRegistryErrorCode, kind: string, message: string) {
		super(message);
		this.name = 'WidgetRegistryError';
		this.code = code;
		this.kind = kind;
	}
}

/**
 * Compose a widget registry from built-in modules plus host-composed plugin
 * contributions. The ordering contract mirrors the backend registries:
 *
 * - core modules keep their declared order and always come first;
 * - plugin contributions are appended in the deterministic host order
 *   (`orderHostedContributions`: by pluginId, then contribution id);
 * - a plugin may add work but may never shadow a core `kind` (or another
 *   plugin's) — a collision throws, so composition fails closed rather than
 *   silently replacing a built-in.
 *
 * Every plugin contribution is validated for host-mediation integrity before it
 * is admitted, so a stated invariant can never silently drift:
 *
 * - its `contributionId` must equal the widget `kind` it renders (otherwise the
 *   deterministic host order would run on an id unrelated to the rendered kind);
 * - its `source` may not claim `'core'` (provenance can never be laundered into a
 *   built-in); and
 * - its `source.pluginId` must match the contributing plugin (no misattribution).
 *
 * The host primitive additionally rejects duplicate contribution ids within a
 * single plugin.
 */
export function createWidgetRegistry(
	coreModules: readonly WidgetModule[],
	pluginContributions: readonly HostedContribution<WidgetModule>[] = []
): WidgetRegistry {
	const byKind = new Map<string, WidgetModule>();
	const ordered: WidgetModule[] = [];

	for (const module of coreModules) {
		if (byKind.has(module.kind)) {
			throw new WidgetRegistryError(
				'duplicate_core_kind',
				module.kind,
				`Core widget kind "${module.kind}" is declared more than once`
			);
		}
		const frozen = Object.freeze({ ...module });
		byKind.set(frozen.kind, frozen);
		ordered.push(frozen);
	}

	for (const contribution of orderHostedContributions(pluginContributions)) {
		const module = contribution.value;
		if (contribution.contributionId !== module.kind) {
			throw new WidgetRegistryError(
				'contribution_id_mismatch',
				module.kind,
				`Plugin ${contribution.pluginId} contribution id "${contribution.contributionId}" must ` +
					`equal its widget kind "${module.kind}"`
			);
		}
		if (module.source === 'core') {
			throw new WidgetRegistryError(
				'source_mismatch',
				module.kind,
				`Plugin ${contribution.pluginId} widget "${module.kind}" claims source "core" — a plugin ` +
					`contribution must carry its own provenance and can never claim to be a built-in`
			);
		}
		if (module.source.pluginId !== contribution.pluginId) {
			throw new WidgetRegistryError(
				'source_mismatch',
				module.kind,
				`Plugin ${contribution.pluginId} widget "${module.kind}" is attributed to ` +
					`"${module.source.pluginId}" — provenance must match the contributing plugin`
			);
		}
		if (byKind.has(module.kind)) {
			throw new WidgetRegistryError(
				'plugin_kind_collision',
				module.kind,
				`Plugin ${contribution.pluginId} widget kind "${module.kind}" collides with an ` +
					`existing widget — plugins may add widgets but never shadow one`
			);
		}
		const frozen = Object.freeze({ ...module });
		byKind.set(frozen.kind, frozen);
		ordered.push(frozen);
	}

	const list = Object.freeze(ordered);
	const kinds = Object.freeze(list.map((module) => module.kind));

	return Object.freeze({
		has: (kind: string) => byKind.has(kind),
		get: (kind: string) => byKind.get(kind) ?? null,
		list: () => list,
		kinds: () => kinds,
	});
}

/**
 * Resolve a `kind` against a registry given the current flag state. A widget
 * with no `flag` is always available; a flagged widget resolves to `disabled`
 * when its flag is off (feature-off), and `unknown` when no module owns the kind.
 */
export function resolveWidget(
	registry: WidgetRegistry,
	kind: string,
	isFlagEnabled: (flag: FeatureFlagKey) => boolean
): WidgetResolution {
	const module = registry.get(kind);
	if (!module) return { status: 'unknown' };
	if (module.flag && !isFlagEnabled(module.flag)) return { status: 'disabled', module };
	return { status: 'ok', module };
}
