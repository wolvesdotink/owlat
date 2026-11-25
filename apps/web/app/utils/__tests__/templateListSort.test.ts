/**
 * One sort table and one status badge for both template lists. Both hand the
 * option's `sortBy`/`sortOrder` to their query, so the menu means the same
 * thing on both pages.
 */
import { describe, expect, it } from 'vitest';
import en from '~~/i18n/locales/en.json';
import { TEMPLATE_SORT_OPTIONS, templateStatusBadge } from '../templateListSort';

function resolves(key: string): boolean {
	let node: unknown = en;
	for (const part of key.split('.')) node = (node as Record<string, unknown>)?.[part];
	return typeof node === 'string';
}

describe('TEMPLATE_SORT_OPTIONS', () => {
	it('opens on last modified, newest first', () => {
		expect(TEMPLATE_SORT_OPTIONS[0]).toMatchObject({ sortBy: 'updatedAt', sortOrder: 'desc' });
	});

	it('has unique values that match their field and order, and labels in the catalog', () => {
		const values = TEMPLATE_SORT_OPTIONS.map((o) => o.value);
		expect(new Set(values).size).toBe(values.length);
		for (const option of TEMPLATE_SORT_OPTIONS) {
			expect(option.value).toBe(`${option.sortBy}-${option.sortOrder}`);
			expect(resolves(option.label), option.label).toBe(true);
		}
	});
});

describe('templateStatusBadge', () => {
	it('gives every status its own tone, icon and catalog label', () => {
		const badges = (['draft', 'published', 'pending_review'] as const).map(templateStatusBadge);
		expect(new Set(badges.map((b) => b.color)).size).toBe(3);
		expect(new Set(badges.map((b) => b.icon)).size).toBe(3);
		for (const badge of badges) expect(resolves(badge.label), badge.label).toBe(true);
		expect(templateStatusBadge('pending_review').label).toBe(
			'shared.templateList.status.pendingReview'
		);
	});

	it('falls back to draft for a status it does not know', () => {
		expect(templateStatusBadge('archived' as never)).toEqual(templateStatusBadge('draft'));
	});
});
