/**
 * Submenu navigation: entering keeps the parent's query and highlight, Back
 * puts both back (one level at a time), and an item without an argument is
 * not a submenu.
 */
import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import type { PaletteItem } from '~/lib/commandPalette';
import { useCommandPaletteArgument } from '../useCommandPaletteArgument';

function submenu(id: string): PaletteItem {
	return {
		id,
		label: id,
		icon: 'lucide:dot',
		run: vi.fn(),
		argument: { promptKey: 'p', headingKey: 'h', icon: 'lucide:dot', options: [] },
	};
}

function setup(indexes: Record<string, number> = {}) {
	const query = ref('');
	const activeIndex = ref(0);
	const focus = vi.fn();
	const argument = useCommandPaletteArgument({
		query,
		setQuery: (value) => {
			query.value = value;
		},
		activeIndex,
		focus,
		indexOf: (id) => indexes[id],
	});
	return { query, activeIndex, focus, argument };
}

describe('useCommandPaletteArgument', () => {
	it('opens a submenu with an empty box, and Back restores the query and the row', async () => {
		const { query, activeIndex, focus, argument } = setup({ snooze: 4 });
		query.value = '>sno';
		activeIndex.value = 2;

		expect(argument.enter(submenu('snooze'))).toBe(true);
		expect(argument.pending.value?.item.id).toBe('snooze');
		expect(query.value).toBe('');
		expect(activeIndex.value).toBe(0);

		activeIndex.value = 1;
		expect(argument.back()).toBe(true);
		expect(query.value).toBe('>sno');
		await nextTick();
		// The row that opened the submenu, wherever it sits now.
		expect(activeIndex.value).toBe(4);
		expect(argument.pending.value).toBeNull();
		expect(focus).toHaveBeenCalled();
	});

	it('falls back to the old highlight when the opening row is gone', async () => {
		const { activeIndex, argument } = setup();
		activeIndex.value = 3;
		argument.enter(submenu('move'));
		argument.back();
		await nextTick();
		expect(activeIndex.value).toBe(3);
	});

	it('unwinds one level at a time, and says when there is nothing to unwind', () => {
		const { query, argument } = setup();
		query.value = 'a';
		argument.enter(submenu('one'));
		query.value = 'b';
		argument.enter(submenu('two'));
		argument.back();
		expect(query.value).toBe('b');
		expect(argument.pending.value?.item.id).toBe('one');
		argument.back();
		expect(query.value).toBe('a');
		expect(argument.back()).toBe(false);
	});

	it('is not a submenu without an argument, and reset drops every level', () => {
		const { argument } = setup();
		expect(argument.enter({ id: 'x', label: 'x', icon: 'lucide:dot', run: vi.fn() })).toBe(false);
		argument.enter(submenu('one'));
		argument.reset();
		expect(argument.pending.value).toBeNull();
	});
});
