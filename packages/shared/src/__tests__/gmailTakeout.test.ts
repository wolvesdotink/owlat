import { describe, expect, it } from 'vitest';
import { parseGmailLabelsHeader, routeGmailLabels } from '../gmailTakeout';

describe('parseGmailLabelsHeader', () => {
	it('splits on commas and trims', () => {
		expect(parseGmailLabelsHeader('Inbox, Unread ,Work')).toEqual(['Inbox', 'Unread', 'Work']);
	});

	it('respects quoting around a label that contains a comma', () => {
		expect(parseGmailLabelsHeader('Inbox,"Clients, EU",Work')).toEqual([
			'Inbox',
			'Clients, EU',
			'Work',
		]);
	});

	it('returns nothing for an absent or empty header', () => {
		expect(parseGmailLabelsHeader(undefined)).toEqual([]);
		expect(parseGmailLabelsHeader('')).toEqual([]);
		expect(parseGmailLabelsHeader(' , ')).toEqual([]);
	});
});

describe('routeGmailLabels', () => {
	it('files an inbox message into the inbox and keeps only user labels', () => {
		const routing = routeGmailLabels([
			'Inbox',
			'Unread',
			'Important',
			'Category Updates',
			'Work/Invoices',
		]);
		expect(routing.folderRole).toBe('inbox');
		expect(routing.labelNames).toEqual(['Work/Invoices']);
		expect(routing.flagSeen).toBe(false);
		expect(routing.isImportant).toBe(true);
	});

	it('treats a missing Unread label as read', () => {
		expect(routeGmailLabels(['Inbox']).flagSeen).toBe(true);
	});

	it('maps Starred to the flagged flag rather than to a label', () => {
		const routing = routeGmailLabels(['Inbox', 'Starred']);
		expect(routing.flagFlagged).toBe(true);
		expect(routing.labelNames).toEqual([]);
	});

	it('prefers the most specific folder when Gmail lists several', () => {
		expect(routeGmailLabels(['Inbox', 'Trash']).folderRole).toBe('trash');
		expect(routeGmailLabels(['Inbox', 'Spam']).folderRole).toBe('spam');
		expect(routeGmailLabels(['Sent', 'Inbox']).folderRole).toBe('inbox');
	});

	it('files an All Mail message (no folder label) into the archive', () => {
		expect(routeGmailLabels(['Work']).folderRole).toBe('archive');
		expect(routeGmailLabels([]).folderRole).toBe('archive');
	});

	it('is case-insensitive about system labels and dedupes user labels', () => {
		const routing = routeGmailLabels(['INBOX', 'unread', 'Work', 'work', 'Work']);
		expect(routing.folderRole).toBe('inbox');
		expect(routing.flagSeen).toBe(false);
		expect(routing.labelNames).toEqual(['Work']);
	});

	it('drops every Category tab', () => {
		expect(
			routeGmailLabels(['Category Personal', 'Category Promotions', 'Category Forums']).labelNames
		).toEqual([]);
	});
});
