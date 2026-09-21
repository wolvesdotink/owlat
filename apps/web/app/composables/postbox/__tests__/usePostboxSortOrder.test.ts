/**
 * The list's newest/oldest order: it applies optimistically, hands back to the
 * saved value once the mutation lands, snaps back when the save failed, and
 * ignores a re-pick of the order the list is already in (the Display menu shows
 * both options at once, so choosing the active one must not flip it).
 */
import { describe, it, expect, vi } from 'vitest';
import { ref, nextTick } from 'vue';
import type { PostboxSortOrder } from '~/utils/postboxSortOrder';
import { usePostboxSortOrder } from '../usePostboxSortOrder';

describe('usePostboxSortOrder', () => {
	it('reads the saved order while nothing is pending', () => {
		const savedSortOrder = ref<PostboxSortOrder>('oldest');
		const { sortOrder } = usePostboxSortOrder({
			savedSortOrder,
			setSortOrder: vi.fn(async () => true),
		});
		expect(sortOrder.value).toBe('oldest');
	});

	it('applies before the save lands and keeps it once it does', async () => {
		const savedSortOrder = ref<PostboxSortOrder>('newest');
		let resolveSave!: (ok: boolean) => void;
		const setSortOrder = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					resolveSave = resolve;
				})
		);
		const { sortOrder, selectSortOrder } = usePostboxSortOrder({ savedSortOrder, setSortOrder });

		selectSortOrder('oldest');
		expect(sortOrder.value).toBe('oldest');
		expect(setSortOrder).toHaveBeenCalledWith('oldest');

		resolveSave(true);
		savedSortOrder.value = 'oldest';
		await nextTick();
		expect(sortOrder.value).toBe('oldest');
	});

	it('snaps back to the server order when the save failed', async () => {
		const savedSortOrder = ref<PostboxSortOrder>('newest');
		const { sortOrder, selectSortOrder } = usePostboxSortOrder({
			savedSortOrder,
			setSortOrder: vi.fn(async () => false),
		});

		selectSortOrder('oldest');
		expect(sortOrder.value).toBe('oldest');
		await nextTick();
		expect(sortOrder.value).toBe('newest');
	});

	it('goes back to newest from oldest', () => {
		const savedSortOrder = ref<PostboxSortOrder>('oldest');
		const setSortOrder = vi.fn(async () => true);
		const { sortOrder, selectSortOrder } = usePostboxSortOrder({ savedSortOrder, setSortOrder });
		selectSortOrder('newest');
		expect(sortOrder.value).toBe('newest');
		expect(setSortOrder).toHaveBeenCalledWith('newest');
	});

	it('ignores a re-pick of the active order', () => {
		const savedSortOrder = ref<PostboxSortOrder>('newest');
		const setSortOrder = vi.fn(async () => true);
		const { sortOrder, selectSortOrder } = usePostboxSortOrder({ savedSortOrder, setSortOrder });
		selectSortOrder('newest');
		expect(setSortOrder).not.toHaveBeenCalled();
		expect(sortOrder.value).toBe('newest');
	});
});
