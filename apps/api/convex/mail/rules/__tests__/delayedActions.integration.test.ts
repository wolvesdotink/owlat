/**
 * Delayed actions (SPEC §6.4): creation anchored on the message, the 5-minute
 * cron, the transactional re-checks at execution (owner reply after the
 * anchor, flag, moved, a newer needs-reply verdict, an undone operation),
 * `archiveSingleMessage` keeping the thread's reply state, the
 * `delayed_archive` log, and the opt-in code detector.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../../schema';
import type { Id } from '../../../_generated/dataModel';
import { internal } from '../../../_generated/api';
import { modules } from '../../__tests__/helpers.testlib';
import { HOUR_MS } from '../../../lib/constants';
import { archiveSingleMessage } from '../../archiveSingleMessage';
import {
	cancelDelayedActionsOf,
	executeDelayedAction,
	createDelayedArchive,
} from '../delayedActions';
import {
	OWNER,
	deliverHosted,
	delayedOf,
	messageOf,
	operationsOf,
	roleOf,
	seedFilter,
	seedPersonalMailbox,
	turnCodeDetectorOn,
	type T,
} from './rules.testlib';

async function archiveAfterSetup(hours = 24) {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	const { mailboxId, folders } = await seedPersonalMailbox(t);
	await seedFilter(t, mailboxId, { actions: [{ type: 'archiveAfter', hours }] });
	const id = (await deliverHosted(t))!;
	const [row] = await delayedOf(t, id);
	return { t, mailboxId, folders, id, row: row! };
}

async function run(t: T, actionId: Id<'mailDelayedActions'>, now: number) {
	return await t.run(async (ctx) => await executeDelayedAction(ctx, actionId, now));
}

/** A copy of `messageId` in its thread, from the owner, `offsetMs` after it. */
async function ownerReply(
	t: T,
	messageId: Id<'mailMessages'>,
	folderId: Id<'mailFolders'>,
	offsetMs: number
): Promise<void> {
	await t.run(async (ctx) => {
		const { _id, _creationTime, ...row } = (await ctx.db.get(messageId))!;
		await ctx.db.insert('mailMessages', {
			...row,
			folderId,
			fromAddress: OWNER,
			rfc822MessageId: `<reply-${offsetMs}@owlat.test>`,
			receivedAt: row.receivedAt + offsetMs,
		});
	});
}

describe('creation', () => {
	it('anchors one row on the message, cancelled by undo of the rule operation', async () => {
		const { t, mailboxId, folders, id, row } = await archiveAfterSetup();
		const message = await messageOf(t, id);
		expect(row).toMatchObject({
			state: 'pending',
			source: 'rule',
			actionKey: `${id}:archive:rule`,
			anchor: { messageReceivedAt: message.receivedAt, folderId: folders.inbox },
		});
		expect(row.runAt - row.createdAt).toBe(24 * HOUR_MS);
		const [operation] = await operationsOf(t, mailboxId);
		expect(row.createdByOperationId).toBe(operation!._id);
		await t.run(async (ctx) => {
			expect(await cancelDelayedActionsOf(ctx, operation!)).toBe(1);
		});
		expect((await delayedOf(t, id))[0]).toMatchObject({ state: 'cancelled', cancelledBy: 'undo' });
	});

	it('deduplicates by actionKey and skips mail already flagged', async () => {
		const { t, id } = await archiveAfterSetup();
		await t.run(async (ctx) => {
			const message = (await ctx.db.get(id))!;
			const again = await createDelayedArchive(ctx, {
				message,
				hours: 2,
				source: 'rule',
				now: Date.now(),
			});
			expect(again).toBeNull();
			await ctx.db.patch(id, { flagFlagged: true });
			const flagged = await createDelayedArchive(ctx, {
				message: { ...message, flagFlagged: true },
				hours: 2,
				source: 'code_detector',
				now: Date.now(),
			});
			expect(flagged).toBeNull();
		});
	});
});

describe('execution', () => {
	it('archives only that message when due, logged as delayed_archive', async () => {
		const { t, mailboxId, folders, id, row } = await archiveAfterSetup();
		expect(await run(t, row._id, row.runAt - 1)).toBe('skipped');
		expect(await run(t, row._id, row.runAt)).toBe('done');
		expect(await roleOf(t, id)).toBe('archive');
		const operations = await operationsOf(t, mailboxId);
		const executed = operations.find((operation) => operation.kind === 'delayed_archive')!;
		expect(executed.changes[0]!.change).toEqual({
			kind: 'messageFolder',
			messageId: id,
			before: folders.inbox,
			after: folders.archive,
		});
		expect((await delayedOf(t, id))[0]).toMatchObject({
			state: 'done',
			operationId: executed._id,
		});
		// A second run of the same row does nothing.
		expect(await run(t, row._id, row.runAt)).toBe('skipped');
	});

	it('cancels on an owner reply after the anchor, not before it', async () => {
		const { t, folders, id, row } = await archiveAfterSetup();
		await ownerReply(t, id, folders.sent, -60_000);
		await t.run(async (ctx) => {
			expect(await executeDelayedAction(ctx, row._id, row.runAt)).toBe('done');
		});

		const second = await archiveAfterSetup();
		await ownerReply(second.t, second.id, second.folders.sent, 60_000);
		expect(await run(second.t, second.row._id, second.row.runAt)).toBe('cancelled');
		expect((await delayedOf(second.t, second.id))[0]!.cancelledBy).toBe('reply');
		expect(await roleOf(second.t, second.id)).toBe('inbox');
	});

	it('cancels when the message is flagged or moved', async () => {
		const flagged = await archiveAfterSetup();
		await flagged.t.run(async (ctx) => await ctx.db.patch(flagged.id, { flagFlagged: true }));
		expect(await run(flagged.t, flagged.row._id, flagged.row.runAt)).toBe('cancelled');
		expect((await delayedOf(flagged.t, flagged.id))[0]!.cancelledBy).toBe('flag');

		const moved = await archiveAfterSetup();
		await moved.t.run(
			async (ctx) => await ctx.db.patch(moved.id, { folderId: moved.folders.trash })
		);
		expect(await run(moved.t, moved.row._id, moved.row.runAt)).toBe('cancelled');
		expect((await delayedOf(moved.t, moved.id))[0]!.cancelledBy).toBe('moved');
	});

	it('cancels on a needs-reply verdict newer than the anchor, and after an undo', async () => {
		const verdict = await archiveAfterSetup();
		const { threadId, receivedAt } = await messageOf(verdict.t, verdict.id);
		await verdict.t.run(
			async (ctx) =>
				await ctx.db.patch(threadId, {
					needsReply: {
						messageId: verdict.id,
						source: 'llm',
						urgency: 'normal',
						detectedAt: receivedAt + 1,
					},
				})
		);
		expect(await run(verdict.t, verdict.row._id, verdict.row.runAt)).toBe('cancelled');
		expect((await delayedOf(verdict.t, verdict.id))[0]!.cancelledBy).toBe('reply');

		const undone = await archiveAfterSetup();
		await undone.t.run(
			async (ctx) => await ctx.db.patch(undone.row.createdByOperationId!, { status: 'undone' })
		);
		expect(await run(undone.t, undone.row._id, undone.row.runAt)).toBe('cancelled');
		expect((await delayedOf(undone.t, undone.id))[0]!.cancelledBy).toBe('undo');
	});

	it('the cron schedules only due rows', async () => {
		const { t, row } = await archiveAfterSetup();
		expect(
			await t.mutation(internal.mail.rules.delayedActions.runDue, { now: row.runAt - 1 })
		).toBe(0);
		expect(await t.mutation(internal.mail.rules.delayedActions.runDue, { now: row.runAt })).toBe(1);
	});
});

describe('archiveSingleMessage', () => {
	it('keeps the thread’s reply state while it has other Inbox mail', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await seedPersonalMailbox(t);
		const first = (await deliverHosted(t, { subject: 'Plans' }))!;
		const second = await t.run(async (ctx) => {
			const { _id, _creationTime, ...row } = (await ctx.db.get(first))!;
			return await ctx.db.insert('mailMessages', { ...row, rfc822MessageId: '<second@x>' });
		});
		const { threadId } = await messageOf(t, second);
		const needsReply = {
			messageId: first,
			source: 'llm' as const,
			urgency: 'normal' as const,
			detectedAt: 1,
		};
		await t.run(async (ctx) => await ctx.db.patch(threadId, { needsReply }));
		const kept = await t.run(async (ctx) => await archiveSingleMessage(ctx, second));
		expect(kept?.isNeedsReplyCleared).toBe(false);
		expect(await roleOf(t, first)).toBe('inbox');
		const lastOut = await t.run(async (ctx) => await archiveSingleMessage(ctx, first));
		expect(lastOut?.isNeedsReplyCleared).toBe(true);
	});
});

describe('the code detector', () => {
	it('archives one-time codes after a day, only when turned on', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await seedPersonalMailbox(t);
		const before = (await deliverHosted(t, { subject: 'Your verification code' }))!;
		expect(await delayedOf(t, before)).toHaveLength(0);

		await turnCodeDetectorOn(t);
		const code = (await deliverHosted(t, { subject: 'Your verification code' }))!;
		const [row] = await delayedOf(t, code);
		expect(row).toMatchObject({ source: 'code_detector', state: 'pending' });
		expect(row!.runAt - row!.createdAt).toBe(24 * HOUR_MS);
		const plain = (await deliverHosted(t, { subject: 'Lunch on Friday?' }))!;
		expect(await delayedOf(t, plain)).toHaveLength(0);
	});
});
