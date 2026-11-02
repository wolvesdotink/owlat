/**
 * Mail scope's empty box and its way out of an empty result: which rows it
 * offers, in which order, and what each one puts in the box.
 */
import { describe, expect, it, vi } from 'vitest';
import {
	MAIL_START_EXAMPLES,
	buildMailFixItems,
	buildMailStartItems,
	frequentCorrespondents,
} from '../commandPaletteMailStart';
import { createTestI18n } from '~/__tests__/i18n';

const { t } = createTestI18n().global;

const contact = (email: string, useCount: number, lastUsedAt: number, displayName?: string) => ({
	email,
	useCount,
	lastUsedAt,
	...(displayName ? { displayName } : {}),
});

describe('frequentCorrespondents', () => {
	it('ranks by how often you mailed them, then by how recently', () => {
		const ranked = frequentCorrespondents([
			contact('once@example.com', 1, 900),
			contact('often@example.com', 12, 100),
			contact('tie-old@example.com', 4, 200),
			contact('tie-new@example.com', 4, 300),
		]);
		expect(ranked.map((c) => c.email)).toEqual([
			'often@example.com',
			'tie-new@example.com',
			'tie-old@example.com',
		]);
	});

	it('leaves out addresses never mailed', () => {
		expect(frequentCorrespondents([contact('cold@example.com', 0, 900)])).toEqual([]);
	});
});

describe('buildMailStartItems', () => {
	function build() {
		const apply = vi.fn();
		const items = buildMailStartItems({
			savedSearches: [{ _id: 's1', name: 'Invoices', rawQuery: 'subject:invoice has:attachment' }],
			contacts: [
				contact('ines@example.com', 3, 10, 'Ines Weber'),
				contact('mei@example.com', 1, 20),
			],
			t,
			apply,
		});
		return { items, apply };
	}

	it('turns each saved search, person and example into a row that fills the box', () => {
		const { items, apply } = build();
		for (const row of [...items.saved, ...items.people, ...items.examples]) {
			expect(row.keepOpen).toBe(true);
			row.run();
		}
		expect(apply.mock.calls.map(([query]) => query)).toEqual([
			'subject:invoice has:attachment',
			'from:ines@example.com',
			'from:mei@example.com',
			'has:attachment',
			'is:unread',
			'older_than:30d',
		]);
	});

	it('names a person when it can, and shows the search a row runs', () => {
		const { items } = build();
		expect(items.saved.map((row) => [row.label, row.subtitle])).toEqual([
			['Invoices', 'subject:invoice has:attachment'],
		]);
		expect(items.people.map((row) => [row.label, row.subtitle])).toEqual([
			['Ines Weber', 'from:ines@example.com'],
			['mei@example.com', 'from:mei@example.com'],
		]);
		expect(items.examples.map((row) => row.subtitle)).toEqual([
			'Messages with attachments',
			'Unread messages',
			'Older than 30 days',
		]);
		expect(MAIL_START_EXAMPLES).toHaveLength(3);
	});
});

describe('buildMailFixItems', () => {
	it('offers the query without its last operator', () => {
		const apply = vi.fn();
		const [row, ...rest] = buildMailFixItems('invoice in:inbox is:unread', t, apply);
		expect(rest).toEqual([]);
		expect(row?.label).toBe('Search without is:unread');
		expect(row?.subtitle).toBe('invoice in:inbox');
		row?.run();
		expect(apply).toHaveBeenCalledWith('invoice in:inbox');
	});

	it('offers nothing when there is no operator to drop', () => {
		expect(buildMailFixItems('quarterly report', t, vi.fn())).toEqual([]);
	});
});
