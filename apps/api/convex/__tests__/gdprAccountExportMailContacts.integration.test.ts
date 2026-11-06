/**
 * "Export my data" includes the member's Postbox address book: every row of
 * each personal mailbox, with what a vCard import added to it. Nothing from a
 * team inbox's book or another member's.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TestConvex } from 'convex-test';
import { api } from '../_generated/api';
import type schema from '../schema';
import type { Id } from '../_generated/dataModel';
import { resetSessionMock } from './gdprSessionMock';
import {
	EXPORT_TEST_SECRET,
	EXPORT_TEST_SITE,
	newHarness,
	seedProfile,
	seedOrg,
	seedMember,
	exportAllUserData,
} from './gdprAccountFixtures';
import { seedMailbox } from '../mail/__tests__/helpers.testlib';

vi.mock('../lib/sessionOrganization', async () => {
	const { gdprSessionOrganizationMock } = await import('./gdprSessionMock');
	return await gdprSessionOrganizationMock();
});

beforeEach(resetSessionMock);
afterEach(() => {
	vi.unstubAllEnvs();
});

async function seedContacts(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	emails: readonly string[]
): Promise<void> {
	await t.run(async (ctx) => {
		for (const email of emails) {
			await ctx.db.insert('mailContacts', {
				mailboxId,
				email,
				displayName: `Name of ${email}`,
				phones: [{ value: '+1 555 0100', type: 'cell' }],
				postalAddresses: [{ type: 'home', street: '1 Main St', locality: 'Springfield' }],
				useCount: 0,
				lastUsedAt: 1,
				importedAt: 1,
				createdAt: 1,
			});
		}
	});
}

describe('accountManagement.exportUserData — Postbox address book', () => {
	it("exports the member's own address books, imported details included, and no one else's", async () => {
		vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
		vi.stubEnv('CONVEX_SITE_URL', EXPORT_TEST_SITE);
		const t = newHarness();
		await seedProfile(t, 'auth-user-1', 'me@example.com');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'editor');
		const base = { organizationId: 'org-x', domain: 'example.com' };
		const mine = await seedMailbox(t, {
			...base,
			userId: 'auth-user-1',
			address: 'me@example.com',
		});
		const team = await seedMailbox(t, {
			...base,
			userId: 'auth-user-1',
			address: 'team@example.com',
			scope: 'shared',
		});
		const theirs = await seedMailbox(t, {
			...base,
			userId: 'auth-user-2',
			address: 'other@example.com',
		});
		// Past one export page, so the cursor is followed.
		const myEmails = Array.from({ length: 101 }, (_, n) => `friend${n}@example.org`);
		await seedContacts(t, mine, myEmails);
		await seedContacts(t, team, ['customer@example.org']);
		await seedContacts(t, theirs, ['stranger@example.org']);

		const exported = await exportAllUserData(t, 'auth-user-1');
		const rows = exported.personalData.mailContacts as Array<Record<string, unknown>>;
		expect(rows.map((row) => row['email']).sort()).toEqual([...myEmails].sort());
		expect(rows[0]).toEqual(
			expect.objectContaining({
				mailboxId: mine,
				displayName: expect.stringMatching(/^Name of /),
				phones: [{ value: '+1 555 0100', type: 'cell' }],
				postalAddresses: [{ type: 'home', street: '1 Main St', locality: 'Springfield' }],
				importedAt: 1,
			})
		);
	});

	it('exports the CardDAV account of a personal book without its sealed password', async () => {
		vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
		vi.stubEnv('CONVEX_SITE_URL', EXPORT_TEST_SITE);
		const t = newHarness();
		await seedProfile(t, 'auth-user-1', 'me@example.com');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'editor');
		const base = { organizationId: 'org-x', domain: 'example.com', userId: 'auth-user-1' };
		const mine = await seedMailbox(t, { ...base, address: 'me@example.com' });
		const team = await seedMailbox(t, { ...base, address: 'team@example.com', scope: 'shared' });
		const seedAccount = (mailboxId: Id<'mailboxes'>, username: string) =>
			t.run((ctx) =>
				ctx.db.insert('mailCardDavAccounts', {
					mailboxId,
					serverUrl: 'https://dav.example.com/',
					addressBookUrl: 'https://dav.example.com/books/me/contacts/',
					username,
					secretCiphertext: 'sealed-ciphertext',
					secretIv: 'sealed-iv',
					secretAuthTag: 'sealed-tag',
					secretEnvelopeVersion: 1,
					status: 'ok',
					lastSyncedAt: 5,
					nextSyncAt: 10,
					createdAt: 1,
					updatedAt: 5,
				})
			);
		await seedAccount(mine, 'me');
		await seedAccount(team, 'team');

		const exported = await exportAllUserData(t, 'auth-user-1');
		const accounts = exported.personalData.mailCardDavAccounts as Array<Record<string, unknown>>;
		expect(accounts).toEqual([
			expect.objectContaining({
				mailboxId: mine,
				serverUrl: 'https://dav.example.com/',
				username: 'me',
				lastSyncedAt: 5,
			}),
		]);
		expect(JSON.stringify(accounts)).not.toContain('sealed-');
	});

	it('exports a contact picture with its bytes, through the staged artifact', async () => {
		vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
		vi.stubEnv('CONVEX_SITE_URL', EXPORT_TEST_SITE);
		const t = newHarness();
		await seedProfile(t, 'auth-user-1', 'me@example.com');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'editor');
		const mine = await seedMailbox(t, {
			organizationId: 'org-x',
			domain: 'example.com',
			userId: 'auth-user-1',
			address: 'me@example.com',
		});
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		await t.run(async (ctx) => {
			const photoStorageId = await ctx.storage.store(new Blob([png], { type: 'image/png' }));
			await ctx.db.insert('mailContacts', {
				mailboxId: mine,
				email: 'ada@example.org',
				photoStorageId,
				useCount: 0,
				lastUsedAt: 1,
				createdAt: 1,
			});
			await ctx.db.insert('mailContacts', {
				mailboxId: mine,
				email: 'grace@example.org',
				useCount: 0,
				lastUsedAt: 2,
				createdAt: 2,
			});
		});

		const staged: string[] = [];
		const exported = await exportAllUserData(t, 'auth-user-1', (url) => staged.push(url));
		const rows = exported.personalData.mailContacts as Array<Record<string, unknown>>;
		const byEmail = new Map(rows.map((row) => [row['email'], row]));
		expect(byEmail.get('ada@example.org')!['photo']).toEqual({
			mediaType: 'image/png',
			contentBase64: Buffer.from(png).toString('base64'),
			contentAvailability: 'available',
		});
		expect(byEmail.get('grace@example.org')!['photo']).toBeUndefined();
		expect(staged).toHaveLength(1);
	});

	it('counts the address book in the pre-run manifest', async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1', 'me@example.com');
		const mine = await seedMailbox(t, {
			userId: 'auth-user-1',
			organizationId: 'org-x',
			address: 'me@example.com',
			domain: 'example.com',
		});
		await seedContacts(t, mine, ['a@example.org', 'b@example.org']);

		const plan = await t.action(api.auth.accountExport.getExportPlan, { userId: 'auth-user-1' });
		expect(plan.personal).toContainEqual({ resource: 'mailContacts', count: 2, isCapped: false });
	});
});
