// @vitest-environment happy-dom
/**
 * usePostboxTriageFilters — counting, filtering, and the honesty of the badge.
 *
 * The chips filter the LOADED window, not the folder (see the composable's
 * header for why there is no cheap folder-wide count). These pin that the
 * counts describe the unfiltered window, and that `countsArePartial` tracks
 * whether further pages exist — the flag the chips use to render "3+" instead
 * of a precise "3" the window cannot back up.
 */
import { describe, it, expect } from 'vitest';
import { ref } from 'vue';

import { usePostboxTriageFilters } from '../usePostboxTriageFilters';

type Row = { _id: string; flagSeen: boolean; flagFlagged: boolean; hasAttachments: boolean };

const row = (id: string, over: Partial<Row> = {}): Row => ({
	_id: id,
	flagSeen: true,
	flagFlagged: false,
	hasAttachments: false,
	...over,
});

const ROWS: Row[] = [
	row('a', { flagSeen: false }),
	row('b', { flagFlagged: true }),
	row('c', { hasAttachments: true, flagSeen: false }),
	row('d'),
];

describe('usePostboxTriageFilters', () => {
	it('counts the unfiltered window so a chip never hides its own badge', () => {
		const { active, counts, setFilter } = usePostboxTriageFilters({
			scope: ref('mbx:inbox'),
			rows: ref(ROWS),
		});
		expect(counts.value).toEqual({ all: 4, unread: 2, starred: 1, attachments: 1 });

		setFilter('starred');
		expect(active.value).toBe('starred');
		// Counts are unchanged by the active filter.
		expect(counts.value).toEqual({ all: 4, unread: 2, starred: 1, attachments: 1 });
	});

	it('filters to the chip that is active', () => {
		const { setFilter, filtered } = usePostboxTriageFilters({
			scope: ref('mbx:inbox'),
			rows: ref(ROWS),
		});
		expect(filtered.value.map((r) => r._id)).toEqual(['a', 'b', 'c', 'd']);

		setFilter('unread');
		expect(filtered.value.map((r) => r._id)).toEqual(['a', 'c']);

		setFilter('attachments');
		expect(filtered.value.map((r) => r._id)).toEqual(['c']);
	});

	it('marks the counts partial while further pages exist', () => {
		const hasMore = ref(true);
		const { countsArePartial } = usePostboxTriageFilters({
			scope: ref('mbx:inbox'),
			rows: ref(ROWS),
			hasMore,
		});
		// More pages: the counts are a lower bound, and the chips render "N+".
		expect(countsArePartial.value).toBe(true);

		// The window has grown to the whole folder — now the numbers are exact.
		hasMore.value = false;
		expect(countsArePartial.value).toBe(false);
	});

	it('is not partial when the caller passes no pagination signal', () => {
		const { countsArePartial } = usePostboxTriageFilters({
			scope: ref('mbx:inbox'),
			rows: ref(ROWS),
		});
		expect(countsArePartial.value).toBe(false);
	});

	// The localStorage round-trip is not covered here: it is gated on
	// `import.meta.client`, which vitest leaves undefined (there is no `define`
	// for it in vitest.config.ts), so the persistence branch never runs under
	// test. Covering it would mean reshaping production code around the test
	// rather than the Nuxt idiom every sibling composable uses.
});
