/**
 * The selection half of usePostboxBulkActions: the anchor that Shift+click and
 * Shift+J/K extend from, the whole-page select, and the "select all matching"
 * claim that any later hand edit has to drop.
 *
 * The triage mutations are stubbed out — this is about which ids end up
 * selected, not about what is done to them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stateBuckets: Map<string, any>;

beforeEach(() => {
	stateBuckets = new Map();
	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init()));
		return stateBuckets.get(key);
	});
	vi.stubGlobal('useI18n', () => ({ t: (k: string) => k }));
	vi.stubGlobal('useBackendOperation', () => ({
		run: vi.fn(async () => ({ ok: true, result: {} })),
		isLoading: ref(false),
	}));
	vi.stubGlobal('usePostboxTriageUndo', () => ({
		register: vi.fn(),
		registerMoveBack: vi.fn(),
	}));
});

const { usePostboxBulkActions } = await import('../usePostboxBulkActions');

const PAGE = ['a', 'b', 'c', 'd', 'e'] as never[];
const bulkFor = () => usePostboxBulkActions(ref('mbx' as never));

describe('usePostboxBulkActions selection', () => {
	it('toggling a row anchors there, and Shift extends the range from it', () => {
		const bulk = bulkFor();
		bulk.toggle(PAGE[1]!);
		expect(bulk.anchorId.value).toBe('b');

		bulk.extendTo(PAGE, PAGE[3]!);
		expect(bulk.ids.value).toEqual(['b', 'c', 'd']);
		// The anchor stays put so a second Shift+click re-aims the same range.
		expect(bulk.anchorId.value).toBe('b');
		bulk.extendTo(PAGE, PAGE[0]!);
		expect(new Set(bulk.ids.value)).toEqual(new Set(['a', 'b', 'c', 'd']));
	});

	it('extends upwards from the anchor just as well as down', () => {
		const bulk = bulkFor();
		bulk.toggle(PAGE[3]!);
		bulk.extendTo(PAGE, PAGE[1]!);
		expect(bulk.ids.value).toEqual(['d', 'b', 'c']);
		expect(bulk.count.value).toBe(3);
	});

	it('without an anchor, an extend selects only the target and anchors there', () => {
		const bulk = bulkFor();
		bulk.extendTo(PAGE, PAGE[2]!);
		expect(bulk.ids.value).toEqual(['c']);
		expect(bulk.anchorId.value).toBe('c');
	});

	it('uses the fallback anchor Shift+J supplies for the very first press', () => {
		const bulk = bulkFor();
		// Focus was on 'a' and Shift+J landed on 'b': both ends come along.
		bulk.extendTo(PAGE, PAGE[1]!, PAGE[0]!);
		expect(bulk.ids.value).toEqual(['a', 'b']);
		expect(bulk.anchorId.value).toBe('a');
	});

	it('drops an anchor that has left the page instead of spanning the list', () => {
		const bulk = bulkFor();
		bulk.toggle('gone' as never);
		bulk.extendTo(PAGE, PAGE[3]!);
		// 'gone' is not on the page, so the range degrades to the target alone.
		expect(bulk.ids.value).toEqual(['gone', 'd']);
	});

	it('selectPage adds the whole page and anchors at its head', () => {
		const bulk = bulkFor();
		bulk.selectPage(PAGE);
		expect(bulk.count.value).toBe(5);
		expect(bulk.anchorId.value).toBe('a');
	});

	it('select-all-matching is claimed only until the selection is hand-edited', () => {
		const bulk = bulkFor();
		bulk.selectAllMatchingIds(['a', 'b', 'c'] as never[], true);
		expect(bulk.selectAllMatching.value).toEqual({ active: true, capped: true });
		expect(bulk.count.value).toBe(3);

		bulk.toggle(PAGE[0]!);
		// Unchecking one row means the selection is no longer "everything".
		expect(bulk.selectAllMatching.value.active).toBe(false);
	});

	it('an empty select-all-matching answer claims nothing', () => {
		const bulk = bulkFor();
		bulk.selectAllMatchingIds([], false);
		expect(bulk.selectAllMatching.value.active).toBe(false);
		expect(bulk.count.value).toBe(0);
	});

	it('clear drops the picks, the anchor and the all-matching claim together', () => {
		const bulk = bulkFor();
		bulk.selectAllMatchingIds(['a', 'b'] as never[], false);
		bulk.clear();
		expect(bulk.count.value).toBe(0);
		expect(bulk.anchorId.value).toBeNull();
		expect(bulk.selectAllMatching.value).toEqual({ active: false, capped: false });
	});
});
