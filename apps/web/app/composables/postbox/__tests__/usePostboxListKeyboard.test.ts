import { describe, it, expect } from 'vitest';
import { ref, nextTick } from 'vue';
import { usePostboxListKeyboard } from '../usePostboxListKeyboard';

function key(k: string) {
	return new KeyboardEvent('keydown', { key: k });
}

describe('usePostboxListKeyboard', () => {
	it('navigates with j/k and activates with Enter', () => {
		const items = ref([{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }]);
		const activated: string[] = [];
		const { focusedIndex, onKeydown } = usePostboxListKeyboard({
			items,
			resetKey: ref('inbox'),
			rowDomId: (m) => `row-${m._id}`,
			onActivate: (m) => activated.push(m._id),
		});
		onKeydown(key('j'));
		expect(focusedIndex.value).toBe(0);
		onKeydown(key('j'));
		expect(focusedIndex.value).toBe(1);
		onKeydown(key('k'));
		expect(focusedIndex.value).toBe(0);
		onKeydown(key('Enter'));
		expect(activated).toEqual(['a']);
	});

	it('keeps focus on the same row across a live update (archive)', async () => {
		const items = ref([{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }]);
		const { focusedIndex, onKeydown } = usePostboxListKeyboard({
			items,
			resetKey: ref('inbox'),
			rowDomId: (m) => `row-${m._id}`,
			onActivate: () => {},
		});
		onKeydown(key('j'));
		onKeydown(key('j')); // focused on 'b' (index 1)
		expect(focusedIndex.value).toBe(1);

		// 'b' is archived and the subscription re-emits without it.
		items.value = [{ _id: 'a' }, { _id: 'c' }];
		await nextTick();
		// Focus holds the slot — now on 'c' (not reset to -1).
		expect(focusedIndex.value).toBe(1);
	});

	it('resets focus on a folder switch (resetKey change)', async () => {
		const items = ref([{ _id: 'a' }, { _id: 'b' }]);
		const resetKey = ref('inbox');
		const { focusedIndex, onKeydown } = usePostboxListKeyboard({
			items,
			resetKey,
			rowDomId: (m) => `row-${m._id}`,
			onActivate: () => {},
		});
		onKeydown(key('j'));
		expect(focusedIndex.value).toBe(0);
		resetKey.value = 'sent';
		await nextTick();
		expect(focusedIndex.value).toBe(-1);
	});

	it('delegates other keys to onAction with the focused item', () => {
		const items = ref([{ _id: 'a' }, { _id: 'b' }]);
		const actions: Array<[string, string]> = [];
		const { onKeydown } = usePostboxListKeyboard({
			items,
			resetKey: ref('inbox'),
			rowDomId: (m) => `row-${m._id}`,
			onActivate: () => {},
			onAction: (k, m) => actions.push([k, m._id]),
		});
		onKeydown(key('j')); // focus 'a'
		onKeydown(key('e'));
		expect(actions).toEqual([['e', 'a']]);
	});

	it('delegates the extended vocabulary keys, including Shift+U as "U"', () => {
		const items = ref([{ _id: 'a' }]);
		const actions: string[] = [];
		const { onKeydown } = usePostboxListKeyboard({
			items,
			resetKey: ref('inbox'),
			rowDomId: (m) => `row-${m._id}`,
			onActivate: () => {},
			onAction: (k) => actions.push(k),
		});
		onKeydown(key('j')); // focus 'a'
		for (const k of ['r', 'a', 'f', 'h', 'l', 'v', 'x']) onKeydown(key(k));
		onKeydown(new KeyboardEvent('keydown', { key: 'U', shiftKey: true }));
		expect(actions).toEqual(['r', 'a', 'f', 'h', 'l', 'v', 'x', 'U']);
	});

	it('does not delegate Alt chords (Windows menu accelerators) to onAction', () => {
		const items = ref([{ _id: 'a' }]);
		const actions: string[] = [];
		const { onKeydown } = usePostboxListKeyboard({
			items,
			resetKey: ref('inbox'),
			rowDomId: (m) => `row-${m._id}`,
			onActivate: () => {},
			onAction: (k) => actions.push(k),
		});
		onKeydown(key('j')); // focus 'a'
		onKeydown(new KeyboardEvent('keydown', { key: 'e', altKey: true }));
		onKeydown(new KeyboardEvent('keydown', { key: 'f', altKey: true }));
		expect(actions).toEqual([]);
	});

	it('does not delegate Cmd/Ctrl chords to onAction', () => {
		const items = ref([{ _id: 'a' }]);
		const actions: string[] = [];
		const { onKeydown } = usePostboxListKeyboard({
			items,
			resetKey: ref('inbox'),
			rowDomId: (m) => `row-${m._id}`,
			onActivate: () => {},
			onAction: (k) => actions.push(k),
		});
		onKeydown(key('j')); // focus 'a'
		onKeydown(new KeyboardEvent('keydown', { key: 'r', metaKey: true }));
		onKeydown(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true }));
		expect(actions).toEqual([]);
	});
	it('Shift+J/K moves the focus and drags the selection with it', () => {
		const items = ref([{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }]);
		const extended: Array<[string, string | undefined]> = [];
		const { focusedIndex, onKeydown } = usePostboxListKeyboard({
			items,
			resetKey: ref('inbox'),
			rowDomId: (m) => `row-${m._id}`,
			onActivate: () => {},
			onExtendSelection: (to, from) => extended.push([to._id, from?._id]),
		});
		onKeydown(key('j')); // focus 'a'
		onKeydown(key('J'));
		expect(focusedIndex.value).toBe(1);
		// The row the focus LEFT comes along, so the first press selects both ends.
		expect(extended).toEqual([['b', 'a']]);

		onKeydown(key('K'));
		expect(focusedIndex.value).toBe(0);
		expect(extended[1]).toEqual(['a', 'b']);
	});

	it('Shift+J from nothing focused starts at the first row', () => {
		const items = ref([{ _id: 'a' }, { _id: 'b' }]);
		const extended: string[] = [];
		const { focusedIndex, onKeydown } = usePostboxListKeyboard({
			items,
			resetKey: ref('inbox'),
			rowDomId: (m) => `row-${m._id}`,
			onActivate: () => {},
			onExtendSelection: (to) => extended.push(to._id),
		});
		onKeydown(key('J'));
		expect(focusedIndex.value).toBe(0);
		expect(extended).toEqual(['a']);
	});

	it('Shift+J/K falls through to onAction on a surface without a selection model', () => {
		const items = ref([{ _id: 'a' }, { _id: 'b' }]);
		const actions: string[] = [];
		const { focusedIndex, onKeydown } = usePostboxListKeyboard({
			items,
			resetKey: ref('inbox'),
			rowDomId: (m) => `row-${m._id}`,
			onActivate: () => {},
			onAction: (k) => actions.push(k),
		});
		onKeydown(key('j')); // focus 'a'
		onKeydown(key('J'));
		// No selection model: the key is delegated and the focus stays put.
		expect(actions).toEqual(['J']);
		expect(focusedIndex.value).toBe(0);
	});
});
