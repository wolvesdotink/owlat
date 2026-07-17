import { isPluginId, type PluginId } from '@owlat/plugin-kit';
import { compareCodePoints } from './compareCodePoints';
import { PluginHostError } from './errors';

/**
 * One entry offered to a host-mediated navigation registry (a sidebar
 * destination, a section, a settings entry). `id` is the entry's stable
 * deduplication identity — two entries with the same `id` are the same
 * destination, and the first one to reach the registry wins. `enabled` is the
 * already-resolved feature-flag/gate decision for the entry; a disabled entry
 * never appears in the result.
 */
export interface HostedNavEntry<Value> {
	readonly id: string;
	readonly enabled: boolean;
	readonly value: Value;
}

/**
 * A plugin's navigation entry. It is ordered deterministically after every core
 * entry by `(pluginId, order, id)` so composition order never changes what the
 * sidebar renders, and it can never take a slot ahead of a core destination.
 */
export interface HostedPluginNavEntry<Value> extends HostedNavEntry<Value> {
	readonly pluginId: PluginId;
	readonly order: number;
}

export interface MergeHostedNavigationInput<Value> {
	/** Core entries, kept in registration order and always ahead of every plugin entry. */
	readonly core: readonly HostedNavEntry<Value>[];
	/** Plugin entries, ordered deterministically and appended after all core entries. */
	readonly plugins?: readonly HostedPluginNavEntry<Value>[];
}

/**
 * Merge core and plugin navigation entries into the ordered, deduplicated,
 * flag-gated list a frontend surface renders.
 *
 * - Core entries come first, in the exact order they were registered.
 * - Plugin entries follow, ordered by plugin id, then the author's `order`,
 *   then entry id — never interleaved with core and never able to reorder it.
 * - Disabled entries (feature-off) are dropped.
 * - Ids are deduplicated with first-registered-wins, so a plugin can never
 *   shadow a core destination or a plugin registered earlier.
 */
export function mergeHostedNavigation<Value>(
	input: MergeHostedNavigationInput<Value>
): readonly Value[] {
	const seen = new Set<string>();
	const merged: Value[] = [];

	for (const entry of input.core) {
		const id = readEntryId(entry);
		if (!entry.enabled || seen.has(id)) continue;
		seen.add(id);
		merged.push(entry.value);
	}

	const plugins = [...(input.plugins ?? [])];
	for (const entry of plugins) validatePluginEntry(entry);
	plugins.sort(
		(left, right) =>
			compareCodePoints(left.pluginId, right.pluginId) ||
			left.order - right.order ||
			compareCodePoints(left.id, right.id)
	);
	for (const entry of plugins) {
		if (!entry.enabled || seen.has(entry.id)) continue;
		seen.add(entry.id);
		merged.push(entry.value);
	}

	return Object.freeze(merged);
}

function readEntryId(entry: HostedNavEntry<unknown>): string {
	if (typeof entry.id !== 'string' || entry.id.trim().length === 0) {
		throw new PluginHostError(
			'invalid_contribution',
			'A navigation entry must carry a non-empty string id',
			{}
		);
	}
	return entry.id;
}

function validatePluginEntry(entry: HostedPluginNavEntry<unknown>): void {
	readEntryId(entry);
	if (!isPluginId(entry.pluginId)) {
		throw new PluginHostError(
			'invalid_contribution',
			`A plugin navigation entry has an invalid plugin id ${String(entry.pluginId)}`,
			{}
		);
	}
	if (typeof entry.order !== 'number' || !Number.isFinite(entry.order)) {
		throw new PluginHostError(
			'invalid_contribution',
			`Plugin ${entry.pluginId} navigation entry ${entry.id} has a non-finite order`,
			{ pluginId: entry.pluginId }
		);
	}
}
