/**
 * Read on arrival erasure (SPEC §0, §2.9): a message purge takes its arrival
 * rows and unsent digest lines along, and a mailbox that becomes a team inbox
 * keeps no personal arrival state.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../../schema';
import { modules, seedFolder, seedMailbox, seedMessage } from '../../__tests__/helpers.testlib';
import { deleteMessageRowAndBlobs } from '../../messagePurge';
import { startScopeChange } from '../../interpret/scopeChange';
import { seedArrivalRows } from './arrival.testlib';

async function setup() {
	const t = convexTest(schema, modules);
	const mailboxId = await seedMailbox(t);
	const folderId = await seedFolder(t, mailboxId);
	const messageId = await seedMessage(t, mailboxId, { subject: 'news' });
	const otherId = await seedMessage(t, mailboxId, { subject: 'other' });
	const [threadId, otherThreadId] = await t.run(async (ctx) => [
		(await ctx.db.get(messageId))!.threadId,
		(await ctx.db.get(otherId))!.threadId,
	]);
	return { t, mailboxId, folderId, messageId, otherId, threadId, otherThreadId };
}

describe('message purge', () => {
	it('deletes the message’s arrival rows and drops its unsent digest lines', async () => {
		const { t, mailboxId, folderId, messageId, otherId, threadId, otherThreadId } = await setup();
		const ids = await t.run(async (ctx) => {
			const seeded = await seedArrivalRows(ctx, { mailboxId, threadId, messageId, folderId });
			// A second line in the unsent digest, and a sent digest naming the message.
			const digest = (await ctx.db.get(seeded.digestId))!;
			await ctx.db.patch(seeded.digestId, {
				items: [...digest.items, { threadId: otherThreadId, messageId: otherId, kind: 'updates' }],
			});
			const sentId = await ctx.db.insert('mailDigests', {
				mailboxId,
				periodKey: '2026-10-16',
				state: 'sent',
				claimToken: 'sent',
				claimUntil: 0,
				generationAttempts: 1,
				items: digest.items,
				visited: digest.visited,
				overflowByKind: digest.overflowByKind,
				overflowLabel: 'exact',
				sentAt: Date.now(),
				createdAt: Date.now(),
				expiresAt: digest.expiresAt,
			});
			await ctx.db.patch(threadId, {
				arrival: { placement: 'digest', messageId, decidedAt: Date.now() },
				digestPendingSince: Date.now(),
			});
			return { ...seeded, sentId };
		});

		await t.run(async (ctx) => deleteMessageRowAndBlobs(ctx, (await ctx.db.get(messageId))!));

		await t.run(async (ctx) => {
			expect(await ctx.db.get(ids.recordId)).toBeNull();
			expect(await ctx.db.get(ids.delayedActionId)).toBeNull();
			// Change rows naming the message go; the thread-override row names no message.
			const left = await ctx.db.query('mailArrivalOperationChanges').collect();
			expect(left.map((row) => row.change.kind)).toEqual(['threadPlacementOverride']);
			const unsent = (await ctx.db.get(ids.digestId))!;
			expect(unsent.items.map((item) => item.messageId)).toEqual([otherId]);
			// Sent digests are what was sent; the spec drops lines from unsent ones only.
			expect((await ctx.db.get(ids.sentId))!.items).toHaveLength(1);
			const thread = (await ctx.db.get(threadId))!;
			expect(thread.arrival).toBeUndefined();
			expect(thread.digestPendingSince).toBeUndefined();
			// Not message-scoped: the profile, operation and rule draft stay.
			expect(await ctx.db.get(ids.profileId)).not.toBeNull();
			expect(await ctx.db.get(ids.operationId)).not.toBeNull();
			expect(await ctx.db.get(ids.ruleDraftId)).not.toBeNull();
		});
	});
});

describe('scope conversion to a team inbox', () => {
	it('clears the thread projection, override, gist and arrival records', async () => {
		const { t, mailboxId, folderId, messageId, threadId } = await setup();
		const ids = await t.run(async (ctx) => {
			const seeded = await seedArrivalRows(ctx, { mailboxId, threadId, messageId, folderId });
			const now = Date.now();
			await ctx.db.patch(threadId, {
				arrival: { placement: 'digest', messageId, decidedAt: now },
				digestPendingSince: now,
				placementOverride: { placement: 'digest', setAt: now, operationId: seeded.operationId },
				lastArrivalOperationId: seeded.operationId,
			});
			const briefId = await ctx.db.insert('threadBriefs', {
				threadKind: 'mail',
				mailThreadId: threadId,
				mode: 'brief',
				sourceRevision: 1,
				interpretationRevision: 1,
				lastActivitySeq: 0,
				completeness: 'complete',
				deletionEpoch: 0,
				gist: {
					spans: [{ segmentId: 's0', quote: 'sealed:quote' }],
					sourceKey: `mail:${messageId}`,
					gistVersion: 1,
					generatedAt: now,
				},
				updatedAt: now,
			});
			return { ...seeded, briefId };
		});

		await t.run(async (ctx) => {
			expect(await startScopeChange(ctx, threadId, 'actions')).toBe(true);
		});

		await t.run(async (ctx) => {
			const thread = (await ctx.db.get(threadId))!;
			expect(thread.arrival).toBeUndefined();
			expect(thread.placementOverride).toBeUndefined();
			expect(thread.digestPendingSince).toBeUndefined();
			expect(thread.lastArrivalOperationId).toBeUndefined();
			expect((await ctx.db.get(ids.briefId))!.gist).toBeUndefined();
			expect(await ctx.db.get(ids.recordId)).toBeNull();
		});
	});

	it('drains a long thread’s records page by page', async () => {
		const { t, mailboxId, messageId, threadId } = await setup();
		await t.run(async (ctx) => {
			const now = Date.now();
			for (let i = 0; i < 150; i++) {
				await ctx.db.insert('mailArrivalRecords', {
					mailboxId,
					threadId,
					messageId,
					sourceKey: `mail:${messageId}:${i}`,
					modelCalls: 0,
					reasonKeys: [],
					createdAt: now + i,
					updatedAt: now + i,
					expiresAt: now + 1_000_000,
				});
			}
		});
		await t.run(async (ctx) => {
			// No brief row: the thread fields and records still go.
			expect(await startScopeChange(ctx, threadId, 'actions')).toBe(false);
		});
		await t.finishAllScheduledFunctions(() => {});
		await t.run(async (ctx) => {
			expect(await ctx.db.query('mailArrivalRecords').collect()).toEqual([]);
		});
	});

	it('leaves arrival state alone when a team inbox becomes personal', async () => {
		const { t, mailboxId, messageId, threadId } = await setup();
		await t.run(async (ctx) => {
			await ctx.db.patch(threadId, {
				arrival: { placement: 'today', messageId, decidedAt: Date.now() },
			});
			await startScopeChange(ctx, threadId, 'brief');
			expect((await ctx.db.get(threadId))!.arrival?.placement).toBe('today');
			expect(mailboxId).toBeDefined();
		});
	});
});
