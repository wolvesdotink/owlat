import { describe, it, expect } from 'vitest';
import { ref, nextTick } from 'vue';
import { usePostboxOptimisticHide } from '../usePostboxOptimisticHide';

describe('usePostboxOptimisticHide', () => {
	it('hides a row immediately and restores it on unhide (failure path)', () => {
		const items = ref([{ _id: 'a' }, { _id: 'b' }]);
		const { visible, hide, unhide } = usePostboxOptimisticHide(items);
		expect(visible.value.map((m) => m._id)).toEqual(['a', 'b']);
		hide('a');
		expect(visible.value.map((m) => m._id)).toEqual(['b']);
		unhide('a'); // mutation failed → row comes back
		expect(visible.value.map((m) => m._id)).toEqual(['a', 'b']);
	});

	it('prunes a hidden id once the row leaves the source list', async () => {
		const items = ref([{ _id: 'a' }, { _id: 'b' }]);
		const { visible, hide } = usePostboxOptimisticHide(items);
		hide('a');
		expect(visible.value.map((m) => m._id)).toEqual(['b']);

		// Server confirms the archive: 'a' drops out of the list.
		items.value = [{ _id: 'b' }];
		await nextTick();
		// If 'a' reappears later it must NOT be stuck hidden (the id was pruned).
		items.value = [{ _id: 'a' }, { _id: 'b' }];
		await nextTick();
		expect(visible.value.map((m) => m._id)).toEqual(['a', 'b']);
	});
});
