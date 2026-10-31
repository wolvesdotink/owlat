import { describe, expect, it } from 'vitest';
import {
	ALREADY_SEEDED,
	USERS_EXIST,
	adminSeedAnswer,
	organizationSlug,
	planAdminSeed,
} from '../seedAdminDecision';

const BODY = { email: 'Ada.Lovelace@example.com', name: 'Ada', passwordHash: 'salt:hash' };

describe('planAdminSeed', () => {
	it.each([
		['email', { name: 'Ada', passwordHash: 'h' }],
		['name', { email: 'a@example.com', passwordHash: 'h' }],
		['passwordHash', { email: 'a@example.com', name: 'Ada' }],
		['an empty email', { email: '', name: 'Ada', passwordHash: 'h' }],
	])('refuses a body without %s', (_label, body) => {
		expect(planAdminSeed(body)).toEqual({
			ok: false,
			answer: {
				kind: 'refused',
				category: 'invalid_input',
				message: 'Missing required fields: email, name, passwordHash',
			},
		});
	});

	it('names the organization after the admin and slugs it from the email', () => {
		expect(planAdminSeed(BODY)).toEqual({
			ok: true,
			seed: {
				...BODY,
				orgName: "Ada's Team",
				orgSlug: 'ada-lovelace',
				isMigrationMode: false,
			},
		});
	});

	it('carries the migration answer and a non-empty flag map, and drops an empty one', () => {
		const withFlags = planAdminSeed({ ...BODY, isMigrationMode: true, flags: { inbox: true } });
		expect(withFlags).toMatchObject({
			ok: true,
			seed: { isMigrationMode: true, flags: { inbox: true } },
		});
		const emptyFlags = planAdminSeed({ ...BODY, flags: {} });
		expect(emptyFlags.ok && 'flags' in emptyFlags.seed).toBe(false);
	});

	it('gives the same plan for the same body', () => {
		expect(planAdminSeed({ ...BODY, flags: { inbox: true } })).toEqual(
			planAdminSeed({ ...BODY, flags: { inbox: true } })
		);
	});
});

describe('organizationSlug', () => {
	it.each([
		['admin@example.com', 'admin'],
		['First.Last+tag@example.com', 'first-last-tag'],
		['--a--b--@example.com', 'a-b'],
		['+++@example.com', 'org'],
		['@example.com', 'org'],
	])('%s → %s', (email, slug) => {
		expect(organizationSlug(email)).toBe(slug);
	});
});

describe('adminSeedAnswer', () => {
	it('answers each commit outcome', () => {
		expect(adminSeedAnswer({ outcome: 'seeded', userId: 'user-1' })).toEqual({
			kind: 'created',
			userId: 'user-1',
		});
		expect(adminSeedAnswer({ outcome: 'users_exist' })).toBe(USERS_EXIST);
		expect(adminSeedAnswer({ outcome: 'already_seeded' })).toBe(ALREADY_SEEDED);
	});
});
