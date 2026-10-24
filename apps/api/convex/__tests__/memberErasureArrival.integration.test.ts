import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAIL_ARRIVAL_TABLES } from '../schema/mailArrival';
import { seedArrivalRows } from '../mail/arrival/__tests__/arrival.testlib';
import {
	drainScheduled,
	erasureHarness,
	requestOf,
	runDeletionCron,
	seedEditor,
	seedPersonalMailbox,
} from './memberErasureFixtures';

/**
 * Read on arrival: erasing a member takes every arrival row of
 * their personal mailbox along (records, sender profiles, the undo log, rule
 * drafts, delayed actions, digests), and leaves a team inbox's alone.
 */

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('member erasure of read-on-arrival rows', () => {
	it('deletes every arrival table’s rows of the personal mailbox', async () => {
		const t = erasureHarness();
		const { authUserId, requestId } = await seedEditor(t);
		const personal = await seedPersonalMailbox(t, authUserId);
		const team = await seedPersonalMailbox(t, authUserId, {
			scope: 'shared',
			address: 'team@example.com',
		});
		await t.run(async (ctx) => {
			await seedArrivalRows(ctx, personal);
			// A second, message-independent set survives the message phase and must
			// be found by the mailbox phase.
			await seedArrivalRows(ctx, personal, { digestState: 'sent' });
			await seedArrivalRows(ctx, team);
		});

		await runDeletionCron(t);
		await drainScheduled(t);

		expect((await requestOf(t, requestId))?.status).toBe('completed');
		await t.run(async (ctx) => {
			for (const table of MAIL_ARRIVAL_TABLES) {
				const rows = await ctx.db.query(table).collect();
				expect(
					rows.every((row) => row.mailboxId === team.mailboxId),
					table
				).toBe(true);
			}
			expect(await ctx.db.query('mailSenderProfiles').collect()).toHaveLength(1);
		});
	});
});
