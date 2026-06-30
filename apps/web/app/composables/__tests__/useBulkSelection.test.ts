import { describe, it, expect, vi } from 'vitest';
import { useBulkSelection } from '../useBulkSelection';

describe('useBulkSelection', () => {
	describe('initial state', () => {
		it('starts with no selections', () => {
			const { selectedIds, hasSelected } = useBulkSelection();
			expect(selectedIds.value.size).toBe(0);
			expect(hasSelected.value).toBe(false);
		});

		it('isSelectAllMatching is false initially', () => {
			const { isSelectAllMatching } = useBulkSelection();
			expect(isSelectAllMatching.value).toBe(false);
		});
	});

	describe('toggleSelection', () => {
		it('adds an item to selection', () => {
			const { toggleSelection, selectedIds, hasSelected } = useBulkSelection();
			toggleSelection('id-1');
			expect(selectedIds.value.has('id-1')).toBe(true);
			expect(hasSelected.value).toBe(true);
		});

		it('removes an already selected item', () => {
			const { toggleSelection, selectedIds } = useBulkSelection();
			toggleSelection('id-1');
			toggleSelection('id-1');
			expect(selectedIds.value.has('id-1')).toBe(false);
		});

		it('clears isSelectAllMatching when deselecting', () => {
			const { toggleSelection, setAllMatching, isSelectAllMatching } = useBulkSelection();
			setAllMatching(['id-1', 'id-2']);
			expect(isSelectAllMatching.value).toBe(true);
			toggleSelection('id-1'); // deselect
			expect(isSelectAllMatching.value).toBe(false);
		});

		it('calls onSelectionChange callback', () => {
			const callback = vi.fn();
			const { toggleSelection } = useBulkSelection({ onSelectionChange: callback });
			toggleSelection('id-1');
			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(expect.any(Set));
		});
	});

	describe('select / deselect', () => {
		it('select adds an item', () => {
			const { select, selectedIds } = useBulkSelection();
			select('id-1');
			expect(selectedIds.value.has('id-1')).toBe(true);
		});

		it('deselect removes an item', () => {
			const { select, deselect, selectedIds } = useBulkSelection();
			select('id-1');
			deselect('id-1');
			expect(selectedIds.value.has('id-1')).toBe(false);
		});

		it('deselect clears isSelectAllMatching', () => {
			const { setAllMatching, deselect, isSelectAllMatching } = useBulkSelection();
			setAllMatching(['id-1', 'id-2']);
			deselect('id-1');
			expect(isSelectAllMatching.value).toBe(false);
		});
	});

	describe('toggleSelectAll', () => {
		it('selects all page items when none are selected', () => {
			const { toggleSelectAll, selectedIds } = useBulkSelection();
			toggleSelectAll(['id-1', 'id-2', 'id-3']);
			expect(selectedIds.value.size).toBe(3);
		});

		it('deselects all page items when all are selected', () => {
			const { toggleSelectAll, selectedIds } = useBulkSelection();
			toggleSelectAll(['id-1', 'id-2']);
			expect(selectedIds.value.size).toBe(2);
			toggleSelectAll(['id-1', 'id-2']);
			expect(selectedIds.value.size).toBe(0);
		});

		it('selects remaining items when some are selected', () => {
			const { select, toggleSelectAll, selectedIds } = useBulkSelection();
			select('id-1');
			toggleSelectAll(['id-1', 'id-2', 'id-3']);
			expect(selectedIds.value.size).toBe(3);
		});
	});

	describe('isAllPageSelected', () => {
		it('returns false for empty page', () => {
			const { isAllPageSelected } = useBulkSelection();
			expect(isAllPageSelected([])).toBe(false);
		});

		it('returns false when not all items selected', () => {
			const { select, isAllPageSelected } = useBulkSelection();
			select('id-1');
			expect(isAllPageSelected(['id-1', 'id-2'])).toBe(false);
		});

		it('returns true when all page items are selected', () => {
			const { select, isAllPageSelected } = useBulkSelection();
			select('id-1');
			select('id-2');
			expect(isAllPageSelected(['id-1', 'id-2'])).toBe(true);
		});
	});

	describe('setAllMatching', () => {
		it('sets all matching ids and enables selectAllMatching', () => {
			const { setAllMatching, selectedIds, isSelectAllMatching, allMatchingIds } = useBulkSelection();
			setAllMatching(['id-1', 'id-2', 'id-3']);
			expect(selectedIds.value.size).toBe(3);
			expect(isSelectAllMatching.value).toBe(true);
			expect(allMatchingIds.value).toEqual(['id-1', 'id-2', 'id-3']);
		});
	});

	describe('clearSelection', () => {
		it('clears all state', () => {
			const { select, setAllMatching, clearSelection, selectedIds, isSelectAllMatching, allMatchingIds, hasSelected } = useBulkSelection();
			select('id-1');
			setAllMatching(['id-1', 'id-2']);

			clearSelection();

			expect(selectedIds.value.size).toBe(0);
			expect(isSelectAllMatching.value).toBe(false);
			expect(allMatchingIds.value).toEqual([]);
			expect(hasSelected.value).toBe(false);
		});
	});

	describe('selectedCountText', () => {
		it('shows count when not all matching', () => {
			const { select, selectedCountText } = useBulkSelection();
			select('id-1');
			select('id-2');
			expect(selectedCountText.value).toBe('2 selected');
		});

		it('shows all matching text when selectAllMatching', () => {
			const { setAllMatching, selectedCountText } = useBulkSelection();
			setAllMatching(['id-1', 'id-2', 'id-3']);
			expect(selectedCountText.value).toBe('3 selected (all matching)');
		});
	});

	describe('getSelectedArray', () => {
		it('returns selected ids as array', () => {
			const { select, getSelectedArray } = useBulkSelection();
			select('id-1');
			select('id-2');
			const arr = getSelectedArray();
			expect(arr).toHaveLength(2);
			expect(arr).toContain('id-1');
			expect(arr).toContain('id-2');
		});
	});
});
