import { describe, it, expect } from 'vitest';
import {
	derivePostboxSidebarSections,
	isSharedMailbox,
	type PostboxAccessibleMailbox,
} from '../postboxMailboxSections';

const personalA: PostboxAccessibleMailbox = {
	mailboxId: 'm1',
	label: 'me@x.com',
	scope: 'personal',
	unread: 0,
};
const personalB: PostboxAccessibleMailbox = {
	mailboxId: 'm2',
	label: 'other@x.com',
	scope: 'personal',
	unread: 2,
};
const teamSales: PostboxAccessibleMailbox = {
	mailboxId: 'm3',
	label: 'Sales',
	scope: 'shared',
	unread: 5,
};
const teamSupport: PostboxAccessibleMailbox = {
	mailboxId: 'm4',
	label: 'Support',
	scope: 'shared',
	unread: 0,
};

describe('isSharedMailbox', () => {
	it('is true only for scope=shared', () => {
		expect(isSharedMailbox(teamSales)).toBe(true);
		expect(isSharedMailbox(personalA)).toBe(false);
	});
});

describe('derivePostboxSidebarSections', () => {
	it('splits personal from shared team inboxes, each sorted by label', () => {
		const { personal, team } = derivePostboxSidebarSections([
			teamSupport,
			personalB,
			teamSales,
			personalA,
		]);
		// Personal sorted by label: me@x.com before other@x.com.
		expect(personal.map((m) => m.mailboxId)).toEqual(['m1', 'm2']);
		// Team sorted by label: Sales before Support.
		expect(team.map((m) => m.mailboxId)).toEqual(['m3', 'm4']);
	});

	it('yields an empty team list for a personal-only user', () => {
		const { personal, team } = derivePostboxSidebarSections([personalA]);
		expect(personal).toHaveLength(1);
		expect(team).toEqual([]);
	});

	it('does not mutate the input array', () => {
		const input = [teamSupport, teamSales];
		derivePostboxSidebarSections(input);
		expect(input.map((m) => m.mailboxId)).toEqual(['m4', 'm3']);
	});
});
