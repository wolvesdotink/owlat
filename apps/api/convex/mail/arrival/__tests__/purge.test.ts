/**
 * Read on arrival erasure (SPEC §0, §2.9): a purged message takes its arrival
 * rows, its unsent digest lines and a gist read from it along, through the
 * resumable `sources` purge job; a mailbox that becomes a team inbox keeps no
 * personal arrival state, and a reversed conversion stops the drain.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { modules, seedFolder, seedMailbox, seedMessage } from '../../__tests__/helpers.testlib';
import { purgeMessageRow, purgeThreadBriefsOf, type PurgedMessages } from '../../messagePurge';
import { rebuildThreadAggregates } from '../../threadAggregates';
import { scheduleScopeInvalidation, startScopeChange } from '../../interpret/scopeChange';
import { MAIL_ARRIVAL_TABLES } from '../../../schema/mailArrival';
import { arrivalChangeRow } from '../changeRows';
import { drivePurgeJob } from '../../interpret/purgeRun';
import { unitBudget } from '../../interpret/purgeDrain';
import { mailMessageSources } from '../../interpret/purge';
import { seedArrivalRows } from './arrival.testlib';

afterEach(() => {
	vi.useRealTimers();
});

async function drain(t: TestConvex<typeof schema>) {
	vi.useFakeTimers();
	await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1));
	vi.useRealTimers();
}

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

/** A second message in `threadId`, so purging the first leaves the thread standing. */
async function addSibling(t: TestConvex<typeof schema>, messageId: Id<'mailMessages'>) {
	return t.run(async (ctx) => {
		const { _id, _creationTime, ...row } = (await ctx.db.get(messageId))!;
		return ctx.db.insert('mailMessages', {
			...row,
			uid: row.uid + 1,
			rfc822MessageId: `<sibling-${_creationTime}@example.com>`,
			receivedAt: row.receivedAt + 1,
		});
	});
}

/** Purge `messageId` the way "Delete forever" does. */
async function purge(t: TestConvex<typeof schema>, messageId: Id<'mailMessages'>) {
	await t.run(async (ctx) => {
		const purged: PurgedMessages = new Map();
		const threadId = await purgeMessageRow(ctx, (await ctx.db.get(messageId))!, purged);
		await purgeThreadBriefsOf(ctx, purged);
		await rebuildThreadAggregates(ctx, threadId);
	});
	await drain(t);
}

describe('message purge', () => {
	it('takes the message’s arrival rows, digest lines, projection and gist along', async () => {
		const { t, mailboxId, folderId, messageId, otherId, threadId, otherThreadId } = await setup();
		await addSibling(t, messageId);
		const now = Date.now();
		const ids = await t.run(async (ctx) => {
			const seeded = await seedArrivalRows(ctx, { mailboxId, threadId, messageId, folderId });
			// A long undo history for the message: more than the job's inline slice
			// (INLINE_PURGE_UNITS), so the rest runs in scheduled continuations.
			for (let i = 0; i < 600; i++) {
				await ctx.db.insert(
					'mailArrivalOperationChanges',
					arrivalChangeRow({
						operationId: seeded.operationId,
						mailboxId,
						change: { kind: 'messageRead', messageId, before: false, after: true },
						now,
					})
				);
			}
			// Twelve unsent digests (more than any fixed page) naming the message
			// next to another line, and a sent one, which keeps what was sent.
			const digest = (await ctx.db.get(seeded.digestId))!;
			const unsent: Id<'mailDigests'>[] = [seeded.digestId];
			await ctx.db.patch(seeded.digestId, {
				items: [...digest.items, { threadId: otherThreadId, messageId: otherId, kind: 'updates' }],
			});
			for (let i = 0; i < 11; i++) {
				unsent.push(
					await ctx.db.insert('mailDigests', {
						mailboxId,
						periodKey: `failed-${i}`,
						state: 'failed',
						claimToken: 't',
						claimUntil: 0,
						generationAttempts: 2,
						items: [
							...digest.items,
							{ threadId: otherThreadId, messageId: otherId, kind: 'updates' },
						],
						visited: digest.visited,
						overflowByKind: digest.overflowByKind,
						overflowLabel: 'exact',
						createdAt: now,
						expiresAt: digest.expiresAt,
					})
				);
			}
			const sentId = await ctx.db.insert('mailDigests', {
				mailboxId,
				periodKey: 'sent',
				state: 'sent',
				claimToken: 's',
				claimUntil: 0,
				generationAttempts: 1,
				items: digest.items,
				visited: digest.visited,
				overflowByKind: digest.overflowByKind,
				overflowLabel: 'exact',
				sentAt: now,
				createdAt: now,
				expiresAt: digest.expiresAt,
			});
			await ctx.db.insert('interpretSources', {
				threadKind: 'mail',
				mailThreadId: threadId,
				source: { kind: 'mail', id: messageId },
				sourceKey: `mail:${messageId}`,
				eligibility: {
					isLive: true,
					isThreadMuted: false,
					isBulkHeaderPresent: true,
					isSenderKnown: false,
				},
				readOutcome: 'gist',
				createdAt: now,
				updatedAt: now,
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
				gistSources: 1,
				skippedSources: 1,
				updatedAt: now,
			});
			await ctx.db.patch(threadId, {
				arrival: { placement: 'digest', messageId, decidedAt: now },
				digestPendingSince: now,
			});
			return { ...seeded, unsent, sentId, briefId };
		});

		await purge(t, messageId);

		await t.run(async (ctx) => {
			expect(await ctx.db.get(ids.recordId)).toBeNull();
			expect(await ctx.db.get(ids.delayedActionId)).toBeNull();
			// Only the thread-override row names no message.
			const left = await ctx.db.query('mailArrivalOperationChanges').collect();
			expect(left.map((row) => row.change.kind)).toEqual(['threadPlacementOverride']);
			for (const digestId of ids.unsent) {
				expect((await ctx.db.get(digestId))!.items.map((item) => item.messageId)).toEqual([
					otherId,
				]);
			}
			expect((await ctx.db.get(ids.sentId))!.items).toHaveLength(1);
			const thread = (await ctx.db.get(threadId))!;
			expect(thread.arrival).toBeUndefined();
			expect(thread.digestPendingSince).toBeUndefined();
			const brief = (await ctx.db.get(ids.briefId))!;
			expect(brief.gist).toBeUndefined();
			expect(brief.gistSources).toBe(0);
			expect(brief.skippedSources).toBe(1);
			// Not message-scoped: the profile, operation and rule draft stay.
			expect(await ctx.db.get(ids.profileId)).not.toBeNull();
			expect(await ctx.db.get(ids.operationId)).not.toBeNull();
			expect(await ctx.db.get(ids.ruleDraftId)).not.toBeNull();
			expect(await ctx.db.query('threadPurgeJobs').collect()).toEqual([]);
		});
	});

	it('finds the mailbox’s digests when the purge emptied and deleted the thread', async () => {
		const { t, mailboxId, folderId, messageId, threadId } = await setup();
		const ids = await t.run((ctx) =>
			seedArrivalRows(ctx, { mailboxId, threadId, messageId, folderId })
		);

		await purge(t, messageId);

		await t.run(async (ctx) => {
			expect(await ctx.db.get(threadId)).toBeNull();
			expect((await ctx.db.get(ids.digestId))!.items).toEqual([]);
			expect(await ctx.db.get(ids.recordId)).toBeNull();
		});
	});
});

/** One digest of `state` for `mailboxId` naming the given lines. */
function digestRow(
	mailboxId: Id<'mailboxes'>,
	state: 'claimed' | 'failed',
	periodKey: string,
	items: Array<{ threadId: Id<'mailThreads'>; messageId: Id<'mailMessages'> }>,
	expiresAt: number
) {
	return {
		mailboxId,
		periodKey,
		state,
		claimToken: 't',
		claimUntil: 0,
		generationAttempts: 1,
		items: items.map((item) => ({ ...item, kind: 'newsletter' as const })),
		visited: [],
		overflowByKind: { newsletter: 0, updates: 0, promotion: 0 },
		overflowLabel: 'exact' as const,
		createdAt: 0,
		expiresAt,
	};
}

describe('the digest walk across purge slices', () => {
	it('handles digests that share a creation time, a slice boundary between them', async () => {
		const { t, mailboxId, messageId, otherId, threadId, otherThreadId } = await setup();
		// Far enough out that convex-test's +0.001 ms bump no longer moves the
		// float: every row inserted now shares one `_creationTime`.
		vi.useFakeTimers();
		vi.setSystemTime(8_000_000_000_000_000);
		const digestIds = await t.run(async (ctx) => {
			const ids: Id<'mailDigests'>[] = [];
			for (let i = 0; i < 12; i++) {
				ids.push(
					await ctx.db.insert(
						'mailDigests',
						digestRow(
							mailboxId,
							'failed',
							`p${i}`,
							[
								{ threadId, messageId },
								{ threadId: otherThreadId, messageId: otherId },
							],
							Number.MAX_SAFE_INTEGER
						)
					)
				);
			}
			return ids;
		});
		vi.useRealTimers();
		const times = await t.run(async (ctx) =>
			Promise.all(digestIds.map(async (id) => (await ctx.db.get(id))!._creationTime))
		);
		expect(new Set(times).size).toBe(1);

		// A few rows per slice, so the cursor lands inside the tie.
		let slices = 0;
		for (; slices < 200; slices++) {
			const isDone = await t.run((ctx) =>
				drivePurgeJob(
					ctx,
					'ties',
					{
						ref: { kind: 'mail', id: threadId },
						kind: 'sources',
						sources: mailMessageSources(messageId),
						mailboxId,
					},
					unitBudget(5)
				)
			);
			if (isDone) break;
		}
		expect(slices).toBeGreaterThan(1);
		await t.run(async (ctx) => {
			for (const id of digestIds) {
				expect((await ctx.db.get(id))!.items.map((item) => item.messageId)).toEqual([otherId]);
			}
		});
	});

	it('still finds the mailbox after the thread is gone and retention took the record', async () => {
		const { t, mailboxId, messageId, threadId, otherId, otherThreadId } = await setup();
		const far = Date.now() + 365 * 24 * 60 * 60 * 1000;
		const failedId = await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('mailArrivalRecords', {
				mailboxId,
				threadId,
				messageId,
				sourceKey: `mail:${messageId}`,
				modelCalls: 0,
				reasonKeys: [],
				createdAt: now,
				updatedAt: now,
				expiresAt: now + 1000,
			});
			// More claimed digests than the inline slice can read, so the failed
			// one is reached only by a scheduled continuation.
			for (let i = 0; i < 500; i++) {
				await ctx.db.insert(
					'mailDigests',
					digestRow(
						mailboxId,
						'claimed',
						`c${i}`,
						[{ threadId: otherThreadId, messageId: otherId }],
						far
					)
				);
			}
			return ctx.db.insert(
				'mailDigests',
				digestRow(mailboxId, 'failed', 'f', [{ threadId, messageId }], far)
			);
		});

		// The purge empties and deletes the thread in its own transaction.
		await t.run(async (ctx) => {
			const purged: PurgedMessages = new Map();
			const id = await purgeMessageRow(ctx, (await ctx.db.get(messageId))!, purged);
			await purgeThreadBriefsOf(ctx, purged);
			await rebuildThreadAggregates(ctx, id);
		});
		const job = await t.run(async (ctx) => ctx.db.query('threadPurgeJobs').first());
		expect(job?.mailboxId).toBe(mailboxId);
		// Retention runs between the slices and takes the arrival record.
		await t.mutation(internal.maintenance.retention.sweepArrivalRecords, {
			now: Date.now() + 60_000,
		});
		await t.run(async (ctx) => {
			expect(await ctx.db.get(threadId)).toBeNull();
			expect(await ctx.db.query('mailArrivalRecords').collect()).toEqual([]);
		});

		await drain(t);

		await t.run(async (ctx) => {
			expect((await ctx.db.get(failedId))!.items).toEqual([]);
			expect(await ctx.db.query('threadPurgeJobs').collect()).toEqual([]);
		});
	});
});

describe('scope conversion to a team inbox', () => {
	it('clears the thread’s arrival fields and gist', async () => {
		const { t, mailboxId, folderId, messageId, threadId } = await setup();
		const ids = await t.run(async (ctx) => {
			const seeded = await seedArrivalRows(ctx, { mailboxId, threadId, messageId, folderId });
			const now = Date.now();
			await ctx.db.patch(threadId, {
				arrival: { placement: 'digest', messageId, decidedAt: now },
				digestPendingSince: now,
				digestConsumedThrough: 'k0',
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
			expect(thread.digestConsumedThrough).toBeUndefined();
			expect(thread.lastArrivalOperationId).toBeUndefined();
			expect((await ctx.db.get(ids.briefId))!.gist).toBeUndefined();
		});
	});

	it('drains every arrival table of the mailbox, page by page', async () => {
		const { t, mailboxId, folderId, messageId, threadId } = await setup();
		await t.run(async (ctx) => {
			for (let i = 0; i < 80; i++) {
				await seedArrivalRows(ctx, { mailboxId, threadId, messageId, folderId });
			}
			await ctx.db.patch(mailboxId, { scope: 'shared' });
			await scheduleScopeInvalidation(ctx, mailboxId, 'actions');
		});
		await drain(t);
		await t.run(async (ctx) => {
			for (const table of MAIL_ARRIVAL_TABLES) {
				expect(await ctx.db.query(table).collect(), table).toEqual([]);
			}
		});
	});

	it('stops a queued drain once the conversion is reversed', async () => {
		const { t, mailboxId, folderId, messageId, threadId } = await setup();
		await t.run(async (ctx) => {
			await ctx.db.patch(mailboxId, { scope: 'shared' });
			await scheduleScopeInvalidation(ctx, mailboxId, 'actions');
			// Reversed before the drain runs, and a fresh personal record written.
			await ctx.db.patch(mailboxId, { scope: 'personal' });
			await seedArrivalRows(ctx, { mailboxId, threadId, messageId, folderId });
		});
		await drain(t);
		await t.run(async (ctx) => {
			expect(await ctx.db.query('mailArrivalRecords').collect()).toHaveLength(1);
			expect(await ctx.db.query('mailSenderProfiles').collect()).toHaveLength(1);
		});
	});

	it('runs no drain for a conversion back to personal', async () => {
		const { t, mailboxId, folderId, messageId, threadId } = await setup();
		await t.run(async (ctx) => {
			await seedArrivalRows(ctx, { mailboxId, threadId, messageId, folderId });
			await scheduleScopeInvalidation(ctx, mailboxId, 'brief');
		});
		await drain(t);
		await t.run(async (ctx) => {
			expect(await ctx.db.query('mailArrivalRecords').collect()).toHaveLength(1);
			// The drain itself refuses a personal mailbox too.
			await expect(
				ctx.runMutation(internal.mail.arrival.sharedConversion.drainSharedMailbox, { mailboxId })
			).resolves.toBeNull();
		});
	});
});
