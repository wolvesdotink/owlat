/**
 * All mail filtered to one Priority placement (read on arrival §3): the
 * Priority view's digest link sets `?placement=digest`.
 */
import { describe, expect, it, vi } from 'vitest';
import { reactive, ref } from 'vue';
import type { Placement } from '@owlat/shared/arrival';
import { parsePlacementQuery, usePostboxPlacementFilter } from '../usePostboxPlacementFilter';

describe('usePostboxPlacementFilter', () => {
	it('narrows the rows to the placement in the URL, and passes them through otherwise', () => {
		const route = reactive({ query: {} as Record<string, unknown> });
		vi.stubGlobal('useRoute', () => route);
		const rows = ref<{ _id: string; placement?: Placement }[]>([
			{ _id: 'news', placement: 'digest' },
			{ _id: 'bahn', placement: 'updates' },
			{ _id: 'legacy' },
		]);
		const { rows: shown, placement } = usePostboxPlacementFilter(rows);
		expect(shown.value.map((r) => r._id)).toEqual(['news', 'bahn', 'legacy']);
		expect(placement.value).toBeNull();
		route.query = { placement: 'digest' };
		expect(shown.value.map((r) => r._id)).toEqual(['news']);
		expect(placement.value).toBe('digest');
	});

	it('only knows the contract placements', () => {
		expect(parsePlacementQuery('digest')).toBe('digest');
		expect(parsePlacementQuery('needs_me')).toBe('needs_me');
		expect(parsePlacementQuery('everything')).toBeNull();
		expect(parsePlacementQuery(['digest'])).toBeNull();
	});
});
