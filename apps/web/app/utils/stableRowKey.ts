import { toRaw } from 'vue';

const keys = new WeakMap<object, number>();
let lastKey = 0;

/**
 * A `v-for` key for an editable row that has no id of its own.
 *
 * Keying such a list by index hands the DOM of a removed or moved row to its
 * neighbour: the input keeps its focus, its caret and any half-typed IME text
 * while the value under it changes. This key belongs to the row object itself
 * (proxy or not), so it follows the row through inserts, removals and moves,
 * and it never shows up in the data a form saves.
 */
export function stableRowKey(row: object): number {
	const raw = toRaw(row);
	let key = keys.get(raw);
	if (key === undefined) {
		key = ++lastKey;
		keys.set(raw, key);
	}
	return key;
}
