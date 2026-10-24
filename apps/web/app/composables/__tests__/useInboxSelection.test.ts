/**
 * useInboxSelection — the Team Inbox list's one owner of the selection and its
 * anchor. The rendered list suite drives it through the keyboard; this pins the
 * rules the keys rely on.
 */
import { describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import { useInboxSelection } from '../useInboxSelection';

function setup(ids = ['a', 'b', 'c', 'd', 'e']) {
	const rows = ref(ids.map((_id) => ({ _id })));
	const resetKey = ref('open');
	const selection = useInboxSelection({ rows, resetKey });
	const picked = () => [...selection.selected.value].sort();
	return { rows, resetKey, selection, picked };
}

describe('useInboxSelection', () => {
	it('extends from the anchor the last toggle set, which stays put', () => {
		const { selection, picked } = setup();
		selection.toggle('b');
		selection.extendTo('d');
		expect(picked()).toEqual(['b', 'c', 'd']);
		// Growing the other way still starts from b.
		selection.extendTo('a');
		expect(picked()).toEqual(['a', 'b', 'c', 'd']);
	});

	it('starts a first extension from the row the focus left', () => {
		const { selection, picked } = setup();
		selection.extendTo('c', 'b');
		expect(picked()).toEqual(['b', 'c']);
	});

	it('degrades to the target alone when the anchor has left the list', async () => {
		const { rows, selection, picked } = setup();
		selection.toggle('a');
		rows.value = rows.value.filter((row) => row._id !== 'a');
		await nextTick();
		expect(picked()).toEqual([]);
		selection.extendTo('d');
		expect(picked()).toEqual(['d']);
	});

	it('clears when the view changes', async () => {
		const { resetKey, selection, picked } = setup();
		selection.toggle('a');
		resetKey.value = 'waiting';
		await nextTick();
		expect(picked()).toEqual([]);
	});

	it('targets the selection from a selected row, the row alone otherwise', () => {
		const { rows, selection } = setup();
		selection.toggle('b');
		selection.toggle('d');
		const [a, b] = rows.value;
		expect(selection.targetsFor(b!).map((row) => row._id)).toEqual(['b', 'd']);
		expect(selection.targetsFor(a!).map((row) => row._id)).toEqual(['a']);
	});

	it('replaces the selection with what is still on screen', () => {
		const { selection, picked } = setup();
		selection.replace(['c', 'zz']);
		expect(picked()).toEqual(['c']);
	});
});
