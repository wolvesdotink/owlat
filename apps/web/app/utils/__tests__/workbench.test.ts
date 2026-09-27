/**
 * The Workbench's pure parts: which tab opens (a link wins, then the last
 * tab used, then the first one not hidden), which tabs show, and where each
 * "Filed away" count leads.
 */
import { describe, expect, it } from 'vitest';
import { filedHref, pickWorkbenchScope, workbenchTabs } from '../workbench';

describe('workbench scope', () => {
	const available = ['mb_me', 'mb_support', 'team'];

	it('opens the linked tab, even for an inbox the viewer hid', () => {
		expect(
			pickWorkbenchScope({
				requested: 'mb_support',
				remembered: 'mb_me',
				available,
				shown: ['mb_me', 'team'],
			})
		).toBe('mb_support');
	});

	it('falls back to the last tab used, then the first shown one', () => {
		const shown = ['mb_me', 'team'];
		expect(pickWorkbenchScope({ requested: undefined, remembered: 'team', available, shown })).toBe(
			'team'
		);
		// A remembered tab the viewer hid since is skipped.
		expect(
			pickWorkbenchScope({ requested: 'nope', remembered: 'mb_support', available, shown })
		).toBe('mb_me');
		expect(
			pickWorkbenchScope({ requested: null, remembered: null, available: [], shown: [] })
		).toBe(null);
	});

	it('lists inboxes that are not hidden, keeps the open one, then the team inbox', () => {
		expect(
			workbenchTabs({
				inboxIds: ['mb_me', 'mb_support', 'mb_sales'],
				hidden: ['mb_support', 'mb_sales'],
				teamOn: true,
				current: 'mb_sales',
			})
		).toEqual(['mb_me', 'mb_sales', 'team']);
		expect(
			workbenchTabs({ inboxIds: ['mb_me'], hidden: [], teamOn: false, current: 'mb_me' })
		).toEqual(['mb_me']);
	});

	it('opens each filed count as that exact list in that inbox', () => {
		expect(filedHref('mb_me', 'newsletter')).toBe(
			'/dashboard/inboxes?in=mb_me&category=newsletter'
		);
		expect(filedHref('mb_me', 'spam')).toBe('/dashboard/postbox/spam?mailbox=mb_me');
		expect(filedHref('team', 'promotion')).toBe('/dashboard/inbox/updates?view=promotions');
		expect(filedHref('team', 'notification')).toBe('/dashboard/inbox/updates?view=notifications');
	});
});
