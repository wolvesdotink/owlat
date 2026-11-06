import { describe, expect, it } from 'vitest';
import {
	allInboxesHref,
	allInboxesSources,
	isAllInboxesFolder,
	isUnifiedFolderPath,
	legacyInboxesRedirect,
	mailboxFolderHref,
	mailboxProviderKey,
	mailboxProviders,
	providerName,
	unifiedChordTarget,
	unifiedFolderHref,
	unifiedFolderRole,
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

describe('unified folder routes', () => {
	it('gives each system role its own segment, and reads the role back from it', () => {
		expect(unifiedFolderRole('all-inboxes')).toBe('inbox');
		expect(unifiedFolderRole('all-sent')).toBe('sent');
		expect(unifiedFolderRole('all-drafts')).toBe('drafts');
		expect(unifiedFolderRole('all-archive')).toBe('archive');
		expect(unifiedFolderRole('all-spam')).toBe('spam');
		expect(unifiedFolderRole('all-trash')).toBe('trash');
		expect(unifiedFolderRole('sent')).toBeNull();
		expect(unifiedFolderRole(['all-sent'])).toBeNull();
		expect(unifiedFolderRole(undefined)).toBeNull();
	});

	it('tells a unified list or open message apart from one mailbox folder', () => {
		expect(isUnifiedFolderPath('/dashboard/postbox/all-trash')).toBe(true);
		expect(isUnifiedFolderPath('/dashboard/postbox/all-sent/m123')).toBe(true);
		expect(isUnifiedFolderPath('/dashboard/postbox/sent')).toBe(false);
		expect(isUnifiedFolderPath('/dashboard/inboxes')).toBe(false);
	});

	it('keeps a mailbox or provider narrow, drops the category outside the Inbox, and never sends both narrows', () => {
		expect(unifiedFolderHref('sent', { provider: 'imap.gmail.com', category: 'receipt' })).toBe(
			'/dashboard/postbox/all-sent?provider=imap.gmail.com'
		);
		expect(unifiedFolderHref('inbox', { provider: 'owlat', category: 'receipt' })).toBe(
			'/dashboard/postbox/all-inboxes?provider=owlat&category=receipt'
		);
		expect(unifiedFolderHref('trash', { in: 'mb_1', provider: 'owlat' })).toBe(
			'/dashboard/postbox/all-trash?in=mb_1'
		);
	});

	it("links one mailbox's own folder of a role", () => {
		expect(mailboxFolderHref('spam', 'mb_1')).toBe('/dashboard/postbox/spam?mailbox=mb_1');
	});

	it('keeps a g chord inside the unified folders, with the same narrow', () => {
		expect(unifiedChordTarget('sent', 'all-inboxes', { in: 'mb_1', category: 'person' })).toBe(
			'/dashboard/postbox/all-sent?in=mb_1'
		);
		expect(unifiedChordTarget('inbox', 'all-trash', { provider: 'owlat' })).toBe(
			'/dashboard/postbox/all-inboxes?provider=owlat'
		);
		expect(unifiedChordTarget('sent', 'inbox', {})).toBeNull();
	});
});

describe('providers', () => {
	it('keys a hosted mailbox as Owlat and a connected one by its IMAP host', () => {
		expect(mailboxProviderKey({})).toBe('owlat');
		expect(mailboxProviderKey({ isConnected: false, providerHost: null })).toBe('owlat');
		expect(mailboxProviderKey({ isConnected: true, providerHost: 'IMAP.Gmail.com ' })).toBe(
			'imap.gmail.com'
		);
		expect(mailboxProviderKey({ isConnected: true, providerHost: null })).toBe('imap');
	});

	it('names the big providers and shows any other host as itself', () => {
		expect(providerName('imap.gmail.com')).toBe('Gmail');
		expect(providerName('mail.owlat.example')).toBe('mail.owlat.example');
		expect(providerName('owlat')).toBeNull();
	});

	it('lists the providers in first-seen order with their mailbox counts', () => {
		expect(
			mailboxProviders([
				{ isConnected: false },
				{ isConnected: true, providerHost: 'imap.gmail.com' },
				{ isConnected: false },
			])
		).toEqual([
			{ key: 'owlat', count: 2 },
			{ key: 'imap.gmail.com', count: 1 },
		]);
	});
});

describe('allInboxesSources', () => {
	const none = { inbox: null, sent: null, drafts: null, archive: null, spam: null, trash: null };
	const rows = [
		{ mailboxId: 'mb_1', folderIds: { ...none, inbox: 'f_1', sent: 's_1' } },
		{ mailboxId: 'mb_2', folderIds: { ...none, sent: 's_2' } },
		{
			mailboxId: 'mb_3',
			isConnected: true,
			providerHost: 'imap.gmail.com',
			folderIds: { ...none, inbox: 'f_3', sent: 's_3', trash: 't_3' },
		},
	];
	const all = { only: null, provider: null };

	it('reads the folder of the role from every mailbox that has one, in list order', () => {
		expect(allInboxesSources(rows, 'inbox', all)).toEqual([
			{ mailboxId: 'mb_1', folderId: 'f_1' },
			{ mailboxId: 'mb_3', folderId: 'f_3' },
		]);
		expect(allInboxesSources(rows, 'sent', all)).toEqual([
			{ mailboxId: 'mb_1', folderId: 's_1' },
			{ mailboxId: 'mb_2', folderId: 's_2' },
			{ mailboxId: 'mb_3', folderId: 's_3' },
		]);
	});

	it('narrows to the one mailbox the filter names', () => {
		expect(allInboxesSources(rows, 'inbox', { only: 'mb_3', provider: null })).toEqual([
			{ mailboxId: 'mb_3', folderId: 'f_3' },
		]);
		expect(allInboxesSources(rows, 'inbox', { only: 'mb_2', provider: null })).toEqual([]);
	});

	it("narrows to one provider's mailboxes, and a mailbox narrow wins over it", () => {
		expect(allInboxesSources(rows, 'sent', { only: null, provider: 'owlat' })).toEqual([
			{ mailboxId: 'mb_1', folderId: 's_1' },
			{ mailboxId: 'mb_2', folderId: 's_2' },
		]);
		expect(allInboxesSources(rows, 'trash', { only: null, provider: 'imap.gmail.com' })).toEqual([
			{ mailboxId: 'mb_3', folderId: 't_3' },
		]);
		expect(allInboxesSources(rows, 'sent', { only: 'mb_3', provider: 'owlat' })).toEqual([
			{ mailboxId: 'mb_3', folderId: 's_3' },
		]);
	});
});
