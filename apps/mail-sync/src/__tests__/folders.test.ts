import { describe, it, expect } from 'vitest';
import { mapFolderRole } from '../folders.js';

describe('mapFolderRole', () => {
	it.each([
		['\\Inbox', 'inbox'],
		['\\Sent', 'sent'],
		['\\Drafts', 'drafts'],
		['\\Trash', 'trash'],
		['\\Junk', 'spam'],
		['\\Archive', 'archive'],
	] as const)('maps SPECIAL-USE %s → %s regardless of path', (specialUse, role) => {
		// SPECIAL-USE wins even if the path name disagrees.
		expect(mapFolderRole(specialUse, 'Some Localized Name')).toBe(role);
	});

	it.each([
		['INBOX', 'inbox'],
		['Sent Items', 'sent'],
		['My Drafts', 'drafts'],
		['Deleted Items', 'trash'],
		['Trash', 'trash'],
		['Junk E-mail', 'spam'],
		['Bulk Mail', 'spam'],
		['Spam', 'spam'],
		['Archive', 'archive'],
		['[Gmail]/All Mail', 'archive'],
	] as const)('falls back to name heuristics: %s → %s', (path, role) => {
		expect(mapFolderRole(undefined, path)).toBe(role);
	});

	it('is case-insensitive for heuristics', () => {
		expect(mapFolderRole(undefined, 'sent')).toBe('sent');
		expect(mapFolderRole(undefined, 'JUNK')).toBe('spam');
	});

	it('returns null for folders with no system role', () => {
		expect(mapFolderRole(undefined, 'Newsletters')).toBeNull();
		expect(mapFolderRole(undefined, 'Work/Projects')).toBeNull();
	});

	it('ignores unknown SPECIAL-USE flags and falls through to the path', () => {
		expect(mapFolderRole('\\Flagged', 'INBOX')).toBe('inbox');
		expect(mapFolderRole('\\Important', 'Newsletters')).toBeNull();
	});
});
