/**
 * Read on arrival retention: every arrival table that carries
 * `expiresAt` is swept past it, settled delayed actions a month after they
 * ran, and nothing fresher or still pending goes.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import {
	modules,
	seedFolder,
	seedMailbox,
	seedMessage,
} from '../../mail/__tests__/helpers.testlib';
import { seedArrivalRows } from '../../mail/arrival/__tests__/arrival.testlib';

const DAY_MS = 24 * 60 * 60 * 1000;
/** BATCH in maintenance/retention.ts. */
const BATCH = 200;

async function setup() {
	const t = convexTest(schema, modules);
	const mailboxId = await seedMailbox(t);
	const folderId = await seedFolder(t, mailboxId);
	const messageId = await seedMessage(t, mailboxId);
	const threadId = await t.run(async (ctx) => (await ctx.db.get(messageId))!.threadId);
	return { t, refs: { mailboxId, folderId, messageId, threadId } };
}

const EXPIRING = [
	'mailArrivalRecords',
	'mailArrivalOperations',
	'mailArrivalOperationChanges',
	'mailRuleDrafts',
	'mailDigests',
] as const;

describe('sweepArrivalRecords', () => {
	it('deletes rows past expiresAt and keeps fresher ones', async () => {
		const { t, refs } = await setup();
		const now = Date.now();
		await t.run(async (ctx) => {
			await seedArrivalRows(ctx, refs, { now: now - 40 * DAY_MS, expiresAt: now - DAY_MS });
			await seedArrivalRows(ctx, refs, { now, expiresAt: now + DAY_MS });
		});

		await t.mutation(internal.maintenance.retention.sweepArrivalRecords, { now });

		await t.run(async (ctx) => {
			for (const table of EXPIRING) {
				const rows = await ctx.db.query(table).collect();
				expect(
					rows.every((row) => row.expiresAt > now),
					table
				).toBe(true);
				expect(rows.length, table).toBeGreaterThan(0);
			}
			// Sender profiles carry no expiry; both stay.
			expect(await ctx.db.query('mailSenderProfiles').collect()).toHaveLength(2);
		});
	});

	it('deletes settled delayed actions a month after their run, never pending ones', async () => {
		const { t, refs } = await setup();
		const now = Date.now();
		const old = now - 31 * DAY_MS;
		await t.run(async (ctx) => {
			const base = {
				mailboxId: refs.mailboxId,
				threadId: refs.threadId,
				messageId: refs.messageId,
				action: 'archive' as const,
				source: 'rule' as const,
				anchor: { messageReceivedAt: old, folderId: refs.folderId },
				createdAt: old,
				updatedAt: old,
			};
			await ctx.db.insert('mailDelayedActions', {
				...base,
				actionKey: 'done',
				runAt: old,
				state: 'done',
			});
			await ctx.db.insert('mailDelayedActions', {
				...base,
				actionKey: 'cancelled',
				runAt: old,
				state: 'cancelled',
				cancelledBy: 'reply',
			});
			await ctx.db.insert('mailDelayedActions', {
				...base,
				actionKey: 'pending',
				runAt: old,
				state: 'pending',
			});
			await ctx.db.insert('mailDelayedActions', {
				...base,
				actionKey: 'recent',
				runAt: now - DAY_MS,
				state: 'done',
			});
		});

		await t.mutation(internal.maintenance.retention.sweepArrivalRecords, { now });

		await t.run(async (ctx) => {
			const keys = (await ctx.db.query('mailDelayedActions').collect()).map((r) => r.actionKey);
			expect(keys.sort()).toEqual(['pending', 'recent']);
		});
	});

	it('drains a backlog larger than one batch', async () => {
		const { t, refs } = await setup();
		const now = Date.now();
		await t.run(async (ctx) => {
			for (let i = 0; i < BATCH + 5; i++) {
				await ctx.db.insert('mailArrivalRecords', {
					mailboxId: refs.mailboxId,
					threadId: refs.threadId,
					messageId: refs.messageId,
					sourceKey: `mail:${i}`,
					modelCalls: 0,
					reasonKeys: [],
					createdAt: now - 100 * DAY_MS,
					updatedAt: now - 100 * DAY_MS,
					expiresAt: now - DAY_MS,
				});
			}
		});

		await t.mutation(internal.maintenance.retention.sweepArrivalRecords, { now });
		await t.finishAllScheduledFunctions(() => {});

		await t.run(async (ctx) => {
			expect(await ctx.db.query('mailArrivalRecords').collect()).toEqual([]);
		});
	});
});
