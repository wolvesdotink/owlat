import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../_generated/dataModel';
import {
	drainScheduled,
	erasureHarness,
	requestOf,
	runDeletionCron,
	seedEditor,
	seedPersonalMailbox,
} from './memberErasureFixtures';

/**
 * Erasing a member deletes their personal address book, what a vCard import
 * added to it included (pictures too), and the CardDAV account syncing into
 * it, and leaves a team inbox's book alone.
 */

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('member erasure of the Postbox address book', () => {
	it('deletes the personal mailbox’s contacts and keeps the team inbox’s', async () => {
		const t = erasureHarness();
		const { authUserId, requestId } = await seedEditor(t);
		const personal = await seedPersonalMailbox(t, authUserId);
		const team = await seedPersonalMailbox(t, authUserId, {
			scope: 'shared',
			address: 'team@example.com',
		});
		const seedContact = (mailboxId: Id<'mailboxes'>, email: string) =>
			t.run(async (ctx) => {
				await ctx.db.insert('mailContacts', {
					mailboxId,
					email,
					displayName: 'Imported Person',
					phones: [{ value: '+1 555 0100', type: 'cell' }],
					postalAddresses: [{ street: '1 Main St', locality: 'Springfield' }],
					useCount: 0,
					lastUsedAt: 1,
					importedAt: 1,
					createdAt: 1,
				});
			});
		await seedContact(personal.mailboxId, 'friend@example.org');
		await seedContact(team.mailboxId, 'customer@example.org');
		const seedAccount = (mailboxId: Id<'mailboxes'>) =>
			t.run((ctx) =>
				ctx.db.insert('mailCardDavAccounts', {
					mailboxId,
					serverUrl: 'https://dav.example.com/',
					addressBookUrl: 'https://dav.example.com/books/contacts/',
					username: 'someone',
					secretCiphertext: 'c',
					secretIv: 'i',
					secretAuthTag: 't',
					secretEnvelopeVersion: 1,
					status: 'ok',
					nextSyncAt: 1,
					createdAt: 1,
					updatedAt: 1,
				})
			);
		const personalAccount = await seedAccount(personal.mailboxId);
		const teamAccount = await seedAccount(team.mailboxId);
		const { photoId, teamPhotoId } = await t.run(async (ctx) => {
			const photo = await ctx.storage.store(new Blob(['jpeg'], { type: 'image/jpeg' }));
			const teamPhoto = await ctx.storage.store(new Blob(['jpeg'], { type: 'image/jpeg' }));
			await ctx.db.insert('mailContacts', {
				mailboxId: personal.mailboxId,
				email: 'synced@example.org',
				photoStorageId: photo,
				cardDavSource: {
					accountId: personalAccount,
					href: 'https://dav.example.com/books/contacts/a.vcf',
					etag: '"1"',
					isRowCreatedBySync: true,
				},
				useCount: 0,
				lastUsedAt: 1,
				createdAt: 1,
			});
			const teamRow = await ctx.db
				.query('mailContacts')
				.withIndex('by_mailbox_and_email', (q) => q.eq('mailboxId', team.mailboxId))
				.first();
			await ctx.db.patch(teamRow!._id, { photoStorageId: teamPhoto });
			return { photoId: photo, teamPhotoId: teamPhoto };
		});

		await runDeletionCron(t);
		await drainScheduled(t);

		expect((await requestOf(t, requestId))?.status).toBe('completed');
		const left = await t.run(async (ctx) => ctx.db.query('mailContacts').collect());
		expect(left.map((row) => row.email)).toEqual(['customer@example.org']);
		const accounts = await t.run(async (ctx) => ctx.db.query('mailCardDavAccounts').collect());
		expect(accounts.map((account) => account._id)).toEqual([teamAccount]);
		expect(await t.run(async (ctx) => (await ctx.storage.get(photoId)) !== null)).toBe(false);
		expect(await t.run(async (ctx) => (await ctx.storage.get(teamPhotoId)) !== null)).toBe(true);
	});
});
