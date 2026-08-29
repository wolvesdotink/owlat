/**
 * The list's newest/oldest toggle: it flips optimistically, hands back to the
 * saved value once the mutation lands, and snaps back when the save failed.
 */
import { describe, it, expect, vi } from 'vitest';
import { ref, nextTick } from 'vue';
import type { PostboxSortOrder } from '~/utils/postboxSortOrder';
import { usePostboxSortToggle } from '../usePostboxSortToggle';

describe('usePostboxSortToggle', () => {
	it('reads the saved order while nothing is pending', () => {
		const savedSortOrder = ref<PostboxSortOrder>('oldest');
		const { sortOrder } = usePostboxSortToggle({
			savedSortOrder,
			setSortOrder: vi.fn(async () => true),
		});
		expect(sortOrder.value).toBe('oldest');
	});

	it('flips before the save lands and keeps the flip once it does', async () => {
		const savedSortOrder = ref<PostboxSortOrder>('newest');
		let resolveSave!: (ok: boolean) => void;
		const setSortOrder = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					resolveSave = resolve;
				})
		);
		const { sortOrder, toggleSortOrder } = usePostboxSortToggle({ savedSortOrder, setSortOrder });

		toggleSortOrder();
		expect(sortOrder.value).toBe('oldest');
		expect(setSortOrder).toHaveBeenCalledWith('oldest');

		resolveSave(true);
		savedSortOrder.value = 'oldest';
		await nextTick();
		expect(sortOrder.value).toBe('oldest');
	});

	it('snaps back to the server order when the save failed', async () => {
		const savedSortOrder = ref<PostboxSortOrder>('newest');
		const { sortOrder, toggleSortOrder } = usePostboxSortToggle({
			savedSortOrder,
			setSortOrder: vi.fn(async () => false),
		});

		toggleSortOrder();
		expect(sortOrder.value).toBe('oldest');
		await nextTick();
		expect(sortOrder.value).toBe('newest');
	});

	it('toggles back to newest from oldest', () => {
		const savedSortOrder = ref<PostboxSortOrder>('oldest');
		const setSortOrder = vi.fn(async () => true);
		const { sortOrder, toggleSortOrder } = usePostboxSortToggle({ savedSortOrder, setSortOrder });
		toggleSortOrder();
		expect(sortOrder.value).toBe('newest');
		expect(setSortOrder).toHaveBeenCalledWith('newest');
	});
});
