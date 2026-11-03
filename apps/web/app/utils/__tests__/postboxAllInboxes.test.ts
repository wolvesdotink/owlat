import { describe, expect, it } from 'vitest';
import {
	allInboxesHref,
	allInboxesSources,
	isAllInboxesFolder,
	legacyInboxesRedirect,
} from '../postboxAllInboxes';

describe('All inboxes routes', () => {
	it('is its own folder segment, never a role or a folder id', () => {
		expect(isAllInboxesFolder('all-inboxes')).toBe(true);
		expect(isAllInboxesFolder('inbox')).toBe(false);
		expect(isAllInboxesFolder(undefined)).toBe(false);
	});

	it('keeps the inbox and category filters on the list route', () => {
		expect(allInboxesHref()).toBe('/dashboard/postbox/all-inboxes');
		expect(allInboxesHref({ in: 'mb_1', category: 'newsletter' })).toBe(
			'/dashboard/postbox/all-inboxes?in=mb_1&category=newsletter'
		);
		expect(allInboxesHref({ in: null, category: 'receipt' })).toBe(
			'/dashboard/postbox/all-inboxes?category=receipt'
		);
	});

	it('sends an old /dashboard/inboxes link to the same filters, and ?in=team to the team inbox', () => {
		expect(legacyInboxesRedirect({})).toBe('/dashboard/postbox/all-inboxes');
		expect(legacyInboxesRedirect({ in: 'mb_1', category: 'person', show: 'unread' })).toBe(
			'/dashboard/postbox/all-inboxes?in=mb_1&category=person'
		);
		expect(legacyInboxesRedirect({ in: 'team' })).toBe('/dashboard/inbox');
	});
});

describe('allInboxesSources', () => {
	const rows = [
		{ mailboxId: 'mb_1', inboxFolderId: 'f_1' },
		{ mailboxId: 'mb_2', inboxFolderId: null },
		{ mailboxId: 'mb_3', inboxFolderId: 'f_3' },
	];

	it('reads every inbox whose Inbox folder is known, in list order', () => {
		expect(allInboxesSources(rows, null)).toEqual([
			{ mailboxId: 'mb_1', folderId: 'f_1' },
			{ mailboxId: 'mb_3', folderId: 'f_3' },
		]);
	});

	it('narrows to the one inbox the filter names', () => {
		expect(allInboxesSources(rows, 'mb_3')).toEqual([{ mailboxId: 'mb_3', folderId: 'f_3' }]);
		expect(allInboxesSources(rows, 'mb_2')).toEqual([]);
	});
});
