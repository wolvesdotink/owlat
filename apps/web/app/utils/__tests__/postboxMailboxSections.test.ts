import { describe, it, expect } from 'vitest';
import {
	derivePostboxSidebarSections,
	isSharedMailbox,
	mailboxLabel,
	type PostboxSidebarMailbox,
} from '../postboxMailboxSections';

const personalA: PostboxSidebarMailbox = { _id: 'm1', address: 'me@x.com' };
const personalUndefinedScope: PostboxSidebarMailbox = {
	_id: 'm2',
	address: 'other@x.com',
	scope: 'personal',
};
const teamSales: PostboxSidebarMailbox = {
	_id: 'm3',
	address: 'sales@x.com',
	displayName: 'Sales',
	scope: 'shared',
};
const teamSupport: PostboxSidebarMailbox = {
	_id: 'm4',
	address: 'support@x.com',
	displayName: 'Support',
	scope: 'shared',
};

describe('isSharedMailbox', () => {
	it('is true only for scope=shared', () => {
		expect(isSharedMailbox(teamSales)).toBe(true);
		expect(isSharedMailbox(personalA)).toBe(false);
		expect(isSharedMailbox(personalUndefinedScope)).toBe(false);
	});
});

describe('mailboxLabel', () => {
	it('prefers the display name, falls back to the address', () => {
		expect(mailboxLabel(teamSales)).toBe('Sales');
		expect(mailboxLabel(personalA)).toBe('me@x.com');
		expect(mailboxLabel({ _id: 'x', address: 'a@x.com', displayName: '  ' })).toBe('a@x.com');
	});
});

describe('derivePostboxSidebarSections', () => {
	it('splits personal (incl. undefined scope) from shared team inboxes', () => {
		const { personal, team } = derivePostboxSidebarSections([
			teamSupport,
			personalA,
			teamSales,
			personalUndefinedScope,
		]);
		expect(personal.map((m) => m._id)).toEqual(['m1', 'm2']);
		// Team sorted by label: Sales before Support.
		expect(team.map((m) => m._id)).toEqual(['m3', 'm4']);
	});

	it('yields an empty team list for a personal-only user', () => {
		const { personal, team } = derivePostboxSidebarSections([personalA]);
		expect(personal).toHaveLength(1);
		expect(team).toEqual([]);
	});

	it('does not mutate the input array', () => {
		const input = [teamSupport, teamSales];
		derivePostboxSidebarSections(input);
		expect(input.map((m) => m._id)).toEqual(['m4', 'm3']);
	});
});
