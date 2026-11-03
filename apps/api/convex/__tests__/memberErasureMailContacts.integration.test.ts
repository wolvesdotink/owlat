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
 * added to it included, and leaves a team inbox's book alone.
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

		await runDeletionCron(t);
		await drainScheduled(t);

		expect((await requestOf(t, requestId))?.status).toBe('completed');
		const left = await t.run(async (ctx) => ctx.db.query('mailContacts').collect());
		expect(left.map((row) => row.email)).toEqual(['customer@example.org']);
	});
});
