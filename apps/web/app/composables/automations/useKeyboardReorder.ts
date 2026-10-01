import { ref, computed, nextTick, type Ref } from 'vue';

export interface KeyboardReorderMessages {
	pickedUp: (position: number, total: number) => string;
	moved: (position: number, total: number) => string;
	dropped: (position: number, total: number) => string;
	cancelled: (position: number, total: number) => string;
}

export interface KeyboardReorderOptions<T extends { _id: string }> {
	/** The order on screen. Moved in place while an item is lifted. */
	items: Ref<T[]>;
	/** Put the saved order back. */
	restore: () => void;
	/**
	 * Persist a drop, the same way a pointer drag's `@end` does. `onSaved`
	 * runs once the new order is stored, so the drop is announced only then.
	 */
	commit: (move: { oldIndex: number; newIndex: number }, onSaved: () => void) => unknown;
	/** Focus the lifted item's handle again after the list re-renders. */
	focusHandle: (id: string) => void;
	announce: (message: string) => void;
	messages: KeyboardReorderMessages;
}

/**
 * The keyboard half of a drag-sortable list: Space (or Enter) on an item's
 * handle lifts it, ArrowUp/ArrowDown move it, Space drops it and Escape puts
 * it back. Each step is announced as "position of total", so a screen-reader
 * user hears where the item is the way a pointer user sees it.
 *
 * The move happens in `items` only; the drop hands the start and end index to
 * `commit`, which is the pointer drag's own persist path, so both routes save
 * the same way.
 */
export function useKeyboardReorder<T extends { _id: string }>(options: KeyboardReorderOptions<T>) {
	const { items, messages } = options;
	const lifted = ref<{ id: string; from: number } | null>(null);

	const indexOf = (id: string) => items.value.findIndex((item) => item._id === id);

	const refocus = (id: string) => {
		void nextTick(() => options.focusHandle(id));
	};

	const cancel = () => {
		const current = lifted.value;
		if (!current) return;
		lifted.value = null;
		options.restore();
		options.announce(messages.cancelled(current.from + 1, items.value.length));
		refocus(current.id);
	};

	const onKeydown = (event: KeyboardEvent, id: string) => {
		const index = indexOf(id);
		if (index === -1) return;
		const total = items.value.length;
		const isToggle = event.key === ' ' || event.key === 'Enter';

		if (!lifted.value || lifted.value.id !== id) {
			if (!isToggle) return;
			event.preventDefault();
			lifted.value = { id, from: index };
			options.announce(messages.pickedUp(index + 1, total));
			return;
		}

		if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
			event.preventDefault();
			const to = index + (event.key === 'ArrowUp' ? -1 : 1);
			if (to < 0 || to >= total) return;
			const next = [...items.value];
			const [moved] = next.splice(index, 1);
			next.splice(to, 0, moved!);
			items.value = next;
			options.announce(messages.moved(to + 1, total));
			refocus(id);
			return;
		}

		if (isToggle) {
			event.preventDefault();
			const { from } = lifted.value;
			lifted.value = null;
			const announceDrop = () => options.announce(messages.dropped(index + 1, total));
			if (from === index) announceDrop();
			else options.commit({ oldIndex: from, newIndex: index }, announceDrop);
			return;
		}

		if (event.key === 'Escape') {
			// The lifted item claims Escape; nothing behind it closes as well.
			event.preventDefault();
			event.stopPropagation();
			cancel();
			return;
		}

		// Tabbing away puts the item back rather than leaving it lifted.
		if (event.key === 'Tab') cancel();
	};

	return {
		/** The id of the item being moved, or null. */
		liftedId: computed(() => lifted.value?.id ?? null),
		onKeydown,
		/** Abandon a lift, e.g. because the saved order changed underneath it. */
		cancel,
		/** Forget a lift without restoring: the list was replaced anyway. */
		reset: () => {
			lifted.value = null;
		},
	};
}
