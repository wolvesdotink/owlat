/**
 * Feature flag registry: merging plugin definitions into the core flags,
 * looking definitions up, and toggling a flag with its cascades.
 *
 * Import from `featureFlags.ts`, which re-exports everything here.
 */

import {
	capturePluginDefinitionArray,
	INVALID_PLUGIN_FEATURE_FLAG_DEFINITION,
	MAX_PLUGIN_FEATURE_FLAGS,
	snapshotPluginFeatureFlagDefinition,
} from './pluginFeatureFlagDefinition';
import { resolveFlags, type FeatureFlagKey, type FeatureFlagState } from './featureFlagRuntime';
import {
	FEATURE_FLAGS,
	type FeatureCategory,
	type FeatureFlagDefinition,
	type PluginFeatureFlagDefinition,
} from './featureFlagDefinitions';

export type FeatureFlagRegistry = Readonly<Record<string, FeatureFlagDefinition>>;

/**
 * Merge build-time plugin definitions into the core registry. The generated
 * composition is already validated, but this shared boundary still rejects a
 * malformed, duplicate, or dangling definition before any runtime resolves it.
 */
export function createFeatureFlagRegistry(
	pluginDefinitions: readonly PluginFeatureFlagDefinition[] = []
): FeatureFlagRegistry {
	const definitions = capturePluginDefinitionArray(pluginDefinitions);
	if (definitions.kind !== 'valid') {
		if (definitions.kind === 'too_many') {
			throw new TypeError(
				`At most ${MAX_PLUGIN_FEATURE_FLAGS} plugin feature flags may be registered`
			);
		}
		throw new TypeError(INVALID_PLUGIN_FEATURE_FLAG_DEFINITION);
	}

	const registry = Object.assign(
		Object.create(null) as Record<string, FeatureFlagDefinition>,
		FEATURE_FLAGS
	);
	for (const untrustedDefinition of definitions.value) {
		const definition = snapshotPluginFeatureFlagDefinition(untrustedDefinition);
		if (!definition) {
			throw new TypeError(INVALID_PLUGIN_FEATURE_FLAG_DEFINITION);
		}
		if (hasFeatureFlagDefinition(registry, definition.key)) {
			throw new TypeError(`Duplicate feature flag definition: ${definition.key}`);
		}
		registry[definition.key] = definition;
	}

	for (const definition of Object.values(registry)) {
		for (const dependency of definition.requires ?? []) {
			if (!hasFeatureFlagDefinition(registry, dependency)) {
				throw new TypeError(`${definition.key} requires unknown feature flag ${dependency}`);
			}
		}
		for (const cascadeTarget of definition.cascadesOff ?? []) {
			if (!hasFeatureFlagDefinition(registry, cascadeTarget)) {
				throw new TypeError(`${definition.key} cascades to unknown feature flag ${cascadeTarget}`);
			}
		}
		for (const group of definition.requiresAny ?? []) {
			// An empty group can never be satisfied — the flag would be permanently
			// forced off, which is a declaration bug, not a state.
			if (group.length === 0) {
				throw new TypeError(`${definition.key} declares an empty requiresAny group`);
			}
			for (const member of group) {
				if (!hasFeatureFlagDefinition(registry, member)) {
					throw new TypeError(`${definition.key} requiresAny unknown feature flag ${member}`);
				}
			}
		}
	}

	return Object.freeze(registry);
}

export function hasFeatureFlagDefinition(registry: FeatureFlagRegistry, key: string): boolean {
	return hasOwnKey(registry, key);
}

export function getFeatureFlagDefinition(
	registry: FeatureFlagRegistry,
	key: string
): FeatureFlagDefinition | undefined {
	return hasFeatureFlagDefinition(registry, key) ? registry[key] : undefined;
}

export interface FeatureFlagResolutionOptions {
	readonly hosted?: boolean;
	readonly registry?: FeatureFlagRegistry;
}

/**
 * Returns true if `flag` is enabled given `stored` state, after resolving dependencies.
 */
export function isFlagEnabled(
	stored: FeatureFlagState,
	flag: FeatureFlagKey,
	opts: FeatureFlagResolutionOptions = {}
): boolean {
	return resolveFlags(stored, opts)[flag] === true;
}

/**
 * Compute the new state after toggling `flag` to `value`, applying cascade rules.
 * Returns the keys that changed (besides `flag` itself) so the UI can surface a confirmation.
 */
export function applyToggle(
	stored: FeatureFlagState,
	flag: FeatureFlagKey,
	value: boolean,
	registry: FeatureFlagRegistry
): { next: FeatureFlagState; cascaded: FeatureFlagKey[] } {
	const definition = getFeatureFlagDefinition(registry, flag);
	if (!definition) throw new TypeError(`Unknown feature flag: ${flag}`);
	const next: FeatureFlagState = {
		...registeredFeatureFlagOverrides(stored, registry),
		[flag]: value,
	};
	const cascaded: FeatureFlagKey[] = [];

	if (!value) {
		// Cascade off: any flag whose `requires` includes this flag must also be off.
		// Plus any explicit `cascadesOff` list, plus any flag for which this was the
		// last ON member of a `requiresAny` group. Group satisfaction is checked
		// against the resolved view so defaults and dependency chains count — a
		// member that is stored ON but itself forced off cannot carry a group.
		const def = definition;
		const queue = new Set<FeatureFlagKey>(def.cascadesOff ?? []);
		const resolved = resolveFlags(next, { registry });
		for (const other of Object.values(registry)) {
			if (other.requires?.includes(flag)) {
				queue.add(other.key);
				continue;
			}
			for (const group of other.requiresAny ?? []) {
				if (group.includes(flag) && !group.some((member) => resolved[member])) {
					queue.add(other.key);
					break;
				}
			}
		}
		for (const key of queue) {
			if (next[key]) {
				next[key] = false;
				cascaded.push(key);
				// Recurse: turning this one off may cascade further.
				const more = applyToggle(next, key, false, registry);
				Object.assign(next, more.next);
				for (const c of more.cascaded) if (!cascaded.includes(c)) cascaded.push(c);
			}
		}
	} else {
		// Cascade on: any required flag must also be on. `requiresAny` members are
		// deliberately NOT auto-enabled — there is no principled pick among group
		// members, so the UI disables the toggle with a "needs one of: …" hint and
		// resolveFlags keeps the flag off until a member is on.
		const def = definition;
		for (const dep of def.requires ?? []) {
			if (!next[dep]) {
				next[dep] = true;
				cascaded.push(dep);
				const more = applyToggle(next, dep, true, registry);
				Object.assign(next, more.next);
				for (const c of more.cascaded) if (!cascaded.includes(c)) cascaded.push(c);
			}
		}
	}

	return { next, cascaded };
}

/** Copy only own boolean overrides for definitions present in this registry. */
export function registeredFeatureFlagOverrides(
	stored: FeatureFlagState,
	registry: FeatureFlagRegistry
): FeatureFlagState {
	const registered: FeatureFlagState = {};
	for (const definition of Object.values(registry)) {
		if (hasOwnKey(stored, definition.key)) {
			registered[definition.key] = stored[definition.key] === true;
		}
	}
	return registered;
}

function hasOwnKey(value: object, key: PropertyKey): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Group flag definitions by category for UI rendering.
 * Hosted-only categories are excluded unless `hosted: true`.
 */
export function getFlagsByCategory(
	opts: FeatureFlagResolutionOptions = {}
): Record<FeatureCategory, FeatureFlagDefinition[]> {
	const result: Record<string, FeatureFlagDefinition[]> = {};
	for (const def of Object.values(opts.registry ?? FEATURE_FLAGS)) {
		if (def.hostedOnly && !opts.hosted) continue;
		(result[def.category] ??= []).push(def);
	}
	return result as Record<FeatureCategory, FeatureFlagDefinition[]>;
}
