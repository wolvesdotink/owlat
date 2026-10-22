import { computed, nextTick, shallowRef, type Ref } from 'vue';
import type { PaletteArgumentSpec, PaletteItem } from '~/lib/commandPalette';

/**
 * One open SUBMENU: the item that asked for an argument, and the palette it was
 * opened from — the query that was typed and the row that was highlighted — so
 * going back puts the person exactly where they were.
 */
interface PaletteArgumentFrame {
	item: PaletteItem;
	spec: PaletteArgumentSpec;
	parentQuery: string;
	parentIndex: number;
}

interface CommandPaletteArgumentOptions {
	/** The box's raw text (prefix included): what a submenu clears and Back restores. */
	query: Ref<string>;
	/** Write the box without the debounce, so a restored query searches at once. */
	setQuery: (value: string) => void;
	/** The highlighted row, restored on Back. */
	activeIndex: Ref<number>;
	/** Return focus to the box after the rows changed under it. */
	focus: () => void;
	/** Where a row sits in the rendered list now (undefined when it is not shown). */
	indexOf: (itemId: string) => number | undefined;
}

/**
 * The palette's submenu navigation: "Snooze ›", "Move to ›", "Assign to ›"…
 * open a list of their own instead of running, and Back (Escape, or Backspace in
 * an empty box) returns to the list that opened them with the query and the
 * highlight they had. Kept as a stack, so Back unwinds exactly one level
 * whatever opened it.
 *
 * Owns the parent-query bookkeeping so the overlay component does not: it sits
 * at the file-size cap, and this is the part with rules worth testing.
 */
export function useCommandPaletteArgument(options: CommandPaletteArgumentOptions) {
	const stack = shallowRef<readonly PaletteArgumentFrame[]>([]);

	/** The open submenu, or null in the palette proper. */
	const pending = computed(() => stack.value[stack.value.length - 1] ?? null);

	/** Open `item`'s submenu. Returns false for an item that takes no argument. */
	function enter(item: PaletteItem): boolean {
		if (!item.argument) return false;
		stack.value = [
			...stack.value,
			{
				item,
				spec: item.argument,
				parentQuery: options.query.value,
				parentIndex: options.activeIndex.value,
			},
		];
		options.setQuery('');
		options.activeIndex.value = 0;
		void nextTick(options.focus);
		return true;
	}

	/**
	 * Leave the open submenu for its parent, restoring the parent's query and
	 * highlight. False when no submenu is open (the caller closes instead).
	 */
	function back(): boolean {
		const frame = pending.value;
		if (!frame) return false;
		stack.value = stack.value.slice(0, -1);
		options.setQuery(frame.parentQuery);
		// The rows change with the query, and the overlay re-homes the highlight
		// whenever they do; the highlight goes back on top of that, onto the row
		// that opened the submenu (its index may have moved), else where it was.
		void nextTick(() => {
			options.activeIndex.value = options.indexOf(frame.item.id) ?? frame.parentIndex;
			options.focus();
		});
		return true;
	}

	/** Drop every open submenu (the palette closed or reopened). */
	function reset() {
		stack.value = [];
	}

	return { pending, enter, back, reset };
}
