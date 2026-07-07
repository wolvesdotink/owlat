/**
 * Pure-logic coverage for the shared command-palette model:
 *   - provider merge: ordering, empty-group drop, per-group capping
 *   - query filtering: prefix-first ranking, subtitle fallback, stability
 *   - keyboard flow: clamp-only Arrow navigation over the flattened list
 */
import { describe, it, expect } from 'vitest';
import {
	type PaletteGroup,
	type PaletteItem,
	filterItems,
	flattenGroups,
	mergeGroups,
	moveSelection,
} from '../commandPalette';

function item(id: string, label: string, subtitle?: string): PaletteItem {
	return { id, label, subtitle, icon: 'lucide:dot', run: () => {} };
}

function group(key: string, order: number, items: PaletteItem[], cap?: number): PaletteGroup {
	return { key, heading: key, order, cap, items };
}

describe('mergeGroups', () => {
	it('sorts groups by order and drops empty ones', () => {
		const merged = mergeGroups([
			group('nav', 20, [item('n1', 'Inbox')]),
			group('empty', 5, []),
			group('surface', 0, [item('s1', 'Reply all')]),
		]);
		expect(merged.map((g) => g.key)).toEqual(['surface', 'nav']);
	});

	it('keeps input order for groups with equal order (stable)', () => {
		const merged = mergeGroups([
			group('a', 10, [item('a1', 'A')]),
			group('b', 10, [item('b1', 'B')]),
		]);
		expect(merged.map((g) => g.key)).toEqual(['a', 'b']);
	});

	it('caps each group to its cap, falling back to the default', () => {
		const many = Array.from({ length: 9 }, (_, i) => item(`c${i}`, `Contact ${i}`));
		const merged = mergeGroups([group('contacts', 0, many, 3), group('nav', 1, many)], 6);
		expect(merged[0]?.items).toHaveLength(3);
		expect(merged[1]?.items).toHaveLength(6);
	});
});

describe('filterItems', () => {
	const items = [
		item('1', 'Compose new message'),
		item('2', 'Go to Contacts'),
		item('3', 'New campaign'),
		item('4', 'Acme Corp', 'billing@acme.test'),
	];

	it('returns everything for an empty query', () => {
		expect(filterItems(items, '  ')).toHaveLength(4);
	});

	it('ranks label prefix matches ahead of substring matches', () => {
		const result = filterItems(items, 'co');
		// "Compose…" (prefix) before "Go to Contacts" (substring)
		expect(result[0]?.id).toBe('1');
		expect(result.map((r) => r.id)).toContain('2');
	});

	it('falls back to subtitle matches last', () => {
		const result = filterItems(items, 'acme');
		expect(result.map((r) => r.id)).toEqual(['4']);
	});

	it('excludes non-matches', () => {
		expect(filterItems(items, 'zzz')).toHaveLength(0);
	});
});

describe('flattenGroups', () => {
	it('concatenates items in group render order', () => {
		const flat = flattenGroups([
			group('a', 0, [item('a1', 'A1'), item('a2', 'A2')]),
			group('b', 1, [item('b1', 'B1')]),
		]);
		expect(flat.map((i) => i.id)).toEqual(['a1', 'a2', 'b1']);
	});
});

describe('moveSelection', () => {
	it('clamps at the bottom without wrapping', () => {
		expect(moveSelection(2, 'ArrowDown', 3)).toBe(2);
		expect(moveSelection(1, 'ArrowDown', 3)).toBe(2);
	});

	it('clamps at the top without wrapping', () => {
		expect(moveSelection(0, 'ArrowUp', 3)).toBe(0);
		expect(moveSelection(2, 'ArrowUp', 3)).toBe(1);
	});

	it('stays at 0 for an empty list', () => {
		expect(moveSelection(0, 'ArrowDown', 0)).toBe(0);
	});
});
