/**
 * The member-group helpers: the name rules the server enforces, checked in the
 * browser first so the refusal reads in the viewer's language, the join/leave
 * diff an edit is saved as, and the roster lookups the cards and the picker use.
 */
import { describe, expect, it } from 'vitest';
import {
	GROUP_NAME_MAX_LENGTH,
	filterRoster,
	groupMembersFromRoster,
	groupNameProblem,
	memberDiff,
	normalizeGroupName,
} from '../memberGroups';

const member = (userId: string, name: string, email: string) => ({
	userId,
	user: { name, email },
});

const roster = [
	member('u_ana', 'Ana Ruiz', 'ana@owlat.example'),
	member('u_ben', 'Ben Ott', 'ben@owlat.example'),
	member('u_cem', '', 'cem@owlat.example'),
];

const groups = [
	{ _id: 'g_mgmt', name: 'Management' },
	{ _id: 'g_prod', name: 'Product' },
];

describe('normalizeGroupName', () => {
	it('collapses runs of whitespace and trims, like the server', () => {
		expect(normalizeGroupName('  Customer \n  success\t')).toBe('Customer success');
	});
});

describe('groupNameProblem', () => {
	it('accepts a new name', () => {
		expect(groupNameProblem('Support', groups)).toBeNull();
	});

	it('refuses an empty or blank name', () => {
		expect(groupNameProblem('', groups)).toBe('empty');
		expect(groupNameProblem('   ', groups)).toBe('empty');
	});

	it('refuses a name over the limit, counted after cleanup', () => {
		expect(groupNameProblem('a'.repeat(GROUP_NAME_MAX_LENGTH), groups)).toBeNull();
		expect(groupNameProblem('a'.repeat(GROUP_NAME_MAX_LENGTH + 1), groups)).toBe('tooLong');
		expect(groupNameProblem(`  ${'a'.repeat(GROUP_NAME_MAX_LENGTH)}  `, groups)).toBeNull();
	});

	it('refuses a name another group has, ignoring case and spacing', () => {
		expect(groupNameProblem('management', groups)).toBe('taken');
		expect(groupNameProblem('  PRODUCT ', groups)).toBe('taken');
	});

	it('lets the group being renamed keep its own name', () => {
		expect(groupNameProblem('management', groups, 'g_mgmt')).toBeNull();
		expect(groupNameProblem('Product', groups, 'g_mgmt')).toBe('taken');
	});
});

describe('memberDiff', () => {
	it('lists who joins and who leaves', () => {
		expect(memberDiff(['u_ana', 'u_ben'], ['u_ben', 'u_cem'])).toEqual({
			added: ['u_cem'],
			removed: ['u_ana'],
		});
	});

	it('is empty when nothing changed, whatever the order', () => {
		expect(memberDiff(['u_ana', 'u_ben'], ['u_ben', 'u_ana'])).toEqual({ added: [], removed: [] });
	});
});

describe('groupMembersFromRoster', () => {
	it('returns roster entries in roster order and counts ids the roster lacks', () => {
		const { members, unknown } = groupMembersFromRoster(['u_cem', 'u_gone', 'u_ana'], roster);
		expect(members.map((m) => m.userId)).toEqual(['u_ana', 'u_cem']);
		expect(unknown).toBe(1);
	});
});

describe('filterRoster', () => {
	it('matches name or email, case-insensitively', () => {
		expect(filterRoster(roster, 'RUIZ').map((m) => m.userId)).toEqual(['u_ana']);
		expect(filterRoster(roster, 'cem@').map((m) => m.userId)).toEqual(['u_cem']);
	});

	it('returns everyone for a blank query', () => {
		expect(filterRoster(roster, '  ')).toHaveLength(3);
	});
});
