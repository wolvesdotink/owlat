/**
 * Pure-logic coverage for the shared command-palette model:
 *   - provider merge: ordering, empty-group drop, per-group capping
 *   - query filtering: fuzzy subsequence ranking, subtitle fallback, stability
 *   - match highlighting: the runs a row bolds
 *   - mode prefixes: `>` commands, `@` people, `#` labels/folders
 *   - argument items: the two-step option list
 *   - keyboard flow: clamp-only Arrow navigation over the flattened list
 */
import { describe, it, expect, vi } from 'vitest';
import {
	type PaletteGroup,
	type PaletteItem,
	buildArgumentGroups,
	filterItems,
	flattenGroups,
	fuzzyMatch,
	groupsForMode,
	highlightSegments,
	mergeGroups,
	moveSelection,
	parsePaletteQuery,
	scoreItems,
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

	it('matches a subsequence, so an abbreviation finds the command', () => {
		const commands = [item('1', 'Postbox settings'), item('2', 'Campaign analytics')];
		// Plain substring filtering matched nothing for this.
		expect(filterItems(commands, 'pbx settings').map((r) => r.id)).toEqual(['1']);
		expect(filterItems(commands, 'canal').map((r) => r.id)).toEqual(['2']);
	});

	it('ranks a contiguous hit above a scattered one', () => {
		const commands = [item('scattered', 'Contacts audit'), item('contiguous', 'Cancel')];
		expect(filterItems(commands, 'ca').map((r) => r.id)).toEqual(['contiguous', 'scattered']);
	});

	it('reports which field matched and where', () => {
		const [first] = scoreItems(items, 'acme');
		expect(first?.field).toBe('label');
		expect(first?.indices).toEqual([0, 1, 2, 3]);

		const [bySubtitle] = scoreItems([item('x', 'Nothing alike', 'billing@acme.test')], 'billing');
		expect(bySubtitle?.field).toBe('subtitle');
	});

	it('keeps input order for equally scored items', () => {
		const twins = [item('a', 'Archive'), item('b', 'Archive')];
		expect(filterItems(twins, 'arch').map((r) => r.id)).toEqual(['a', 'b']);
	});
});

describe('fuzzyMatch', () => {
	it('scores a prefix above a word start above a mid-word hit', () => {
		const prefix = fuzzyMatch('mail settings', 'mail')?.score ?? 0;
		const wordStart = fuzzyMatch('open mail now', 'mail')?.score ?? 0;
		const midWord = fuzzyMatch('airmail', 'mail')?.score ?? 0;
		expect(prefix).toBeGreaterThan(wordStart);
		expect(wordStart).toBeGreaterThan(midWord);
	});

	it('returns null when a character is missing, and matches everything when empty', () => {
		expect(fuzzyMatch('Compose', 'zq')).toBeNull();
		expect(fuzzyMatch('Compose', '  ')).toEqual({ score: 0, indices: [] });
	});
});

describe('highlightSegments', () => {
	it('splits the text into matched and unmatched runs', () => {
		expect(highlightSegments('Compose', 'comp')).toEqual([
			{ text: 'Comp', isMatch: true },
			{ text: 'ose', isMatch: false },
		]);
	});

	it('returns one plain run when the query does not match', () => {
		expect(highlightSegments('Compose', 'zzz')).toEqual([{ text: 'Compose', isMatch: false }]);
	});
});

describe('parsePaletteQuery', () => {
	it('reads the three mode prefixes and strips them from the term', () => {
		expect(parsePaletteQuery('> arch')).toEqual({ mode: 'commands', term: 'arch', prefix: '>' });
		expect(parsePaletteQuery('@ada')).toEqual({ mode: 'people', term: 'ada', prefix: '@' });
		expect(parsePaletteQuery('#work')).toEqual({ mode: 'labels', term: 'work', prefix: '#' });
	});

	it('leaves an unprefixed query untouched', () => {
		expect(parsePaletteQuery('invoice 4471')).toEqual({
			mode: 'all',
			term: 'invoice 4471',
			prefix: '',
		});
	});
});

describe('groupsForMode', () => {
	const groups = [
		{ ...group('verbs', 0, [item('v', 'V')]), mode: 'commands' as const },
		{ ...group('contacts', 1, [item('c', 'C')]), mode: 'people' as const },
		group('recent', 2, [item('r', 'R')]),
	];

	it('admits every group in the unprefixed palette', () => {
		expect(groupsForMode(groups, 'all').map((g) => g.key)).toEqual(['verbs', 'contacts', 'recent']);
	});

	it('admits only the groups that opted into a narrowed mode', () => {
		expect(groupsForMode(groups, 'people').map((g) => g.key)).toEqual(['contacts']);
		// A group without a mode never leaks into a narrowed search.
		expect(groupsForMode(groups, 'labels')).toEqual([]);
	});
});

describe('buildArgumentGroups', () => {
	const spec = {
		promptKey: 'prompt',
		headingKey: 'heading',
		icon: 'lucide:tag',
		options: [
			{ id: 'work', label: 'Work', run: () => {} },
			{ id: 'personal', label: 'Personal', run: () => {} },
		],
	};

	it('turns the options into one filtered group carrying the heading key', () => {
		const [built] = buildArgumentGroups(spec, 'wor');
		expect(built?.heading).toBe('heading');
		expect(built?.items.map((i) => i.id)).toEqual(['argument:work']);
	});

	it('runs the chosen option, not the parent item', () => {
		const run = vi.fn();
		const [built] = buildArgumentGroups({ ...spec, options: [{ id: 'a', label: 'A', run }] }, '');
		built?.items[0]?.run();
		expect(run).toHaveBeenCalledOnce();
	});

	it('does not cap the option list (a mailbox can have many labels)', () => {
		const many = Array.from({ length: 40 }, (_, i) => ({
			id: `l${i}`,
			label: `Label ${i}`,
			run: () => {},
		}));
		const [built] = buildArgumentGroups({ ...spec, options: many }, '');
		expect(mergeGroups(built ? [built] : [])[0]?.items).toHaveLength(40);
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
