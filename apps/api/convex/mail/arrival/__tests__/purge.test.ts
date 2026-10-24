/**
 * Read on arrival erasure: a purged message takes its arrival
 * rows, its unsent digest lines and a gist read from it along, through the
 * resumable `sources` purge job; a mailbox that becomes a team inbox keeps no
 * personal arrival state, and a reversed conversion stops the drain.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import { modules, seedFolder, seedMailbox, seedMessage } from '../../__tests__/helpers.testlib';
import { purgeMessageRow, purgeThreadBriefsOf, type PurgedMessages } from '../../messagePurge';
import { rebuildThreadAggregates } from '../../threadAggregates';
import { scheduleScopeInvalidation, startScopeChange } from '../../interpret/scopeChange';
import { MAIL_ARRIVAL_TABLES } from '../../../schema/mailArrival';
import { arrivalChangeRow } from '../changeRows';
import { drivePurgeJob } from '../../interpret/purgeRun';
import { unitBudget, type DrainBudget } from '../../interpret/purgeDrain';
import {
	commitGeneratedDigest,
	markDigestFailed,
	markDigestSent,
	retireGeneratedDigests,
} from '../digestState';
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
			// The generated digest names the message next to another line.
			const digest = (await ctx.db.get(seeded.digestId))!;
			await ctx.db.patch(seeded.digestId, {
				items: [...digest.items, { threadId: otherThreadId, messageId: otherId, kind: 'updates' }],
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
			return { ...seeded, briefId };
		});

		await purge(t, messageId);

		await t.run(async (ctx) => {
			expect(await ctx.db.get(ids.recordId)).toBeNull();
			expect(await ctx.db.get(ids.delayedActionId)).toBeNull();
			// Only the thread-override row names no message.
			const left = await ctx.db.query('mailArrivalOperationChanges').collect();
			expect(left.map((row) => row.change.kind)).toEqual(['threadPlacementOverride']);
			expect((await ctx.db.get(ids.digestId))!.items.map((item) => item.messageId)).toEqual([
				otherId,
			]);
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
	state: Doc<'mailDigests'>['state'],
	periodKey: string,
	items: Array<{ threadId: Id<'mailThreads'>; messageId: Id<'mailMessages'> }>,
	expiresAt = Number.MAX_SAFE_INTEGER
) {
	return {
		mailboxId,
		periodKey,
		state,
		claimToken: 't',
		claimUntil: 0,
		generationAttempts: 1,
		items: items.map((item) => ({ ...item, kind: 'newsletter' as const })),
		visited: items.map((item) => ({
			threadId: item.threadId,
			throughSourceOrderKey: 'k1',
			kind: 'newsletter' as const,
		})),
		overflowByKind: { newsletter: 3, updates: 0, promotion: 0 },
		overflowLabel: 'exact' as const,
		createdAt: 0,
		expiresAt,
	};
}

/** A budget that counts the digest rows a slice fetches. */
function countingBudget() {
	const inner = unitBudget(10_000);
	const counts = { digests: 0 };
	const budget: DrainBudget = {
		isExhausted: inner.isExhausted,
		chunk: inner.chunk,
		range: inner.range,
		progress: inner.progress,
		charge: (doc) => {
			if (doc && typeof doc === 'object' && 'periodKey' in doc && 'claimToken' in doc) {
				counts.digests += 1;
			}
			inner.charge(doc);
		},
	};
	return { budget, counts };
}

describe('the digest a purge reads', () => {
	it('reads only the generated digest, however many failed and sent ones exist', async () => {
		const { t, mailboxId, messageId, otherId, threadId, otherThreadId } = await setup();
		const line = { threadId, messageId };
		const other = { threadId: otherThreadId, messageId: otherId };
		const generatedId = await t.run(async (ctx) => {
			// Failed and sent digests are stripped (digestState.ts); many of them.
			for (let i = 0; i < 40; i++) {
				await ctx.db.insert('mailDigests', digestRow(mailboxId, 'failed', `f${i}`, []));
				await ctx.db.insert('mailDigests', digestRow(mailboxId, 'sent', `s${i}`, []));
			}
			await ctx.db.insert('mailDigests', digestRow(mailboxId, 'claimed', 'c', []));
			return ctx.db.insert('mailDigests', digestRow(mailboxId, 'generated', 'g', [line, other]));
		});

		const { budget, counts } = countingBudget();
		const isDone = await t.run((ctx) =>
			drivePurgeJob(
				ctx,
				'budget',
				{
					ref: { kind: 'mail', id: threadId },
					kind: 'sources',
					sources: mailMessageSources(messageId),
					mailboxId,
				},
				budget
			)
		);

		expect(isDone).toBe(true);
		expect(counts.digests).toBe(1);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(generatedId))!.items.map((item) => item.messageId)).toEqual([
				otherId,
			]);
		});
	});

	it('logs and still handles a broken invariant (two generated digests)', async () => {
		const { t, mailboxId, messageId, threadId } = await setup();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const ids = await t.run(async (ctx) => [
			await ctx.db.insert(
				'mailDigests',
				digestRow(mailboxId, 'generated', 'a', [{ threadId, messageId }])
			),
			await ctx.db.insert(
				'mailDigests',
				digestRow(mailboxId, 'generated', 'b', [{ threadId, messageId }])
			),
		]);

		await purge(t, messageId);

		await t.run(async (ctx) => {
			for (const id of ids) expect((await ctx.db.get(id))!.items).toEqual([]);
		});
		expect(warn).toHaveBeenCalledWith(
			'arrival: more than one generated digest in a mailbox',
			expect.objectContaining({ mailboxId })
		);
		warn.mockRestore();
	});

	it('still finds the mailbox after the thread is gone and retention took the record', async () => {
		const { t, mailboxId, messageId, threadId } = await setup();
		const generatedId = await t.run(async (ctx) => {
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
			// More extraction rows than the inline slice can delete, so the digest
			// range is reached only by a scheduled continuation.
			for (let i = 0; i < 500; i++) {
				await ctx.db.insert('messageInterpretations', {
					threadKind: 'mail',
					mailThreadId: threadId,
					source: { kind: 'mail', id: messageId },
					sourceKey: `mail:${messageId}`,
					contentRevision: `rev-${i}`,
					extractorVersion: 1,
					mode: 'brief',
					status: 'complete',
					deletionEpoch: 0,
					createdAt: now,
					updatedAt: now,
				});
			}
			return ctx.db.insert(
				'mailDigests',
				digestRow(mailboxId, 'generated', 'g', [{ threadId, messageId }])
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
		expect((await t.run(async (ctx) => ctx.db.get(generatedId)))!.items).toHaveLength(1);
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
			expect((await ctx.db.get(generatedId))!.items).toEqual([]);
			expect(await ctx.db.query('threadPurgeJobs').collect()).toEqual([]);
		});
	});
});

describe('digest state invariants', () => {
	it('strips the lines of a failed digest and keeps its counts', async () => {
		const { t, mailboxId, messageId, threadId } = await setup();
		await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'mailDigests',
				digestRow(mailboxId, 'claimed', 'p', [{ threadId, messageId }])
			);
			await markDigestFailed(ctx, { _id: id });
			const row = (await ctx.db.get(id))!;
			expect(row.state).toBe('failed');
			expect(row.items).toEqual([]);
			expect(row.overflowByKind.newsletter).toBe(3);
			expect(row.visited).toHaveLength(1);
		});
	});

	it('strips the lines of a sent digest and keeps visited for consumption', async () => {
		const { t, mailboxId, messageId, threadId } = await setup();
		await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'mailDigests',
				digestRow(mailboxId, 'generated', 'p', [{ threadId, messageId }])
			);
			const sentAt = Date.now();
			expect(
				await markDigestSent(ctx, (await ctx.db.get(id))!, { sentMessageId: messageId, sentAt })
			).toBe(true);
			const row = (await ctx.db.get(id))!;
			expect(row).toMatchObject({ state: 'sent', items: [], sentMessageId: messageId, sentAt });
			expect(row.visited).toEqual([{ threadId, throughSourceOrderKey: 'k1', kind: 'newsletter' }]);
			// A second delivery sees `sent` and writes nothing.
			expect(await markDigestSent(ctx, row, { sentMessageId: messageId, sentAt: sentAt + 1 })).toBe(
				false
			);
			expect((await ctx.db.get(id))!.sentAt).toBe(sentAt);
		});
	});

	it('keeps one generated digest however overlapping claims commit', async () => {
		const orders = [
			['a', 'b', 'c'],
			['c', 'a', 'b'],
			['b', 'c', 'a'],
		] as const;
		for (const order of orders) {
			const { t, mailboxId, messageId, threadId } = await setup();
			const now = Date.now();
			// Three periods claimed before any of them commits: each claim saw no
			// generated digest.
			const claimed = await t.run(async (ctx) => {
				const ids: Record<string, Id<'mailDigests'>> = {};
				for (const period of ['a', 'b', 'c']) {
					ids[period] = await ctx.db.insert('mailDigests', {
						...digestRow(mailboxId, 'claimed', period, []),
						claimToken: `token-${period}`,
						claimUntil: now + 60_000,
					});
				}
				return ids;
			});
			for (const period of order) {
				const result = await t.run((ctx) =>
					commitGeneratedDigest(ctx, {
						digestId: claimed[period]!,
						claimToken: `token-${period}`,
						items: [{ threadId, messageId, kind: 'newsletter', spans: [{ quote: 'sealed:q' }] }],
						now,
					})
				);
				expect(result).toEqual({ ok: true });
			}
			await t.run(async (ctx) => {
				const generated = await ctx.db
					.query('mailDigests')
					.withIndex('by_mailbox_state', (q) =>
						q.eq('mailboxId', mailboxId).eq('state', 'generated')
					)
					.collect();
				expect(generated.map((digest) => digest.periodKey)).toEqual([order[2]]);
				for (const period of order.slice(0, 2)) {
					expect(await ctx.db.get(claimed[period]!)).toMatchObject({ state: 'failed', items: [] });
				}
			});
		}
	});

	it('refuses a commit without the live claim, writing nothing', async () => {
		const { t, mailboxId, messageId, threadId } = await setup();
		const now = Date.now();
		const items = [{ threadId, messageId, kind: 'newsletter' as const }];
		await t.run(async (ctx) => {
			const claimedId = await ctx.db.insert('mailDigests', {
				...digestRow(mailboxId, 'claimed', 'p', []),
				claimToken: 'mine',
				claimUntil: now + 1000,
			});
			const failedId = await ctx.db.insert('mailDigests', digestRow(mailboxId, 'failed', 'f', []));
			const otherGenerated = await ctx.db.insert(
				'mailDigests',
				digestRow(mailboxId, 'generated', 'g', [{ threadId, messageId }])
			);
			const commit = (digestId: Id<'mailDigests'>, claimToken: string, at: number) =>
				commitGeneratedDigest(ctx, { digestId, claimToken, items, now: at });
			expect(await commit(claimedId, 'theirs', now)).toEqual({
				ok: false,
				reason: 'claim_mismatch',
			});
			expect(await commit(claimedId, 'mine', now + 5000)).toEqual({
				ok: false,
				reason: 'lease_expired',
			});
			expect(await commit(failedId, 't', now)).toEqual({ ok: false, reason: 'not_claimed' });
			expect((await ctx.db.get(claimedId))!).toMatchObject({ state: 'claimed', items: [] });
			// A refused commit retires nothing either.
			expect((await ctx.db.get(otherGenerated))!.state).toBe('generated');
		});
	});

	it('retires older generated digests when a new period is claimed', async () => {
		const { t, mailboxId, messageId, threadId } = await setup();
		await t.run(async (ctx) => {
			const older = await ctx.db.insert(
				'mailDigests',
				digestRow(mailboxId, 'generated', '2026-10-16', [{ threadId, messageId }])
			);
			const current = await ctx.db.insert(
				'mailDigests',
				digestRow(mailboxId, 'generated', '2026-10-17', [{ threadId, messageId }])
			);
			expect(await retireGeneratedDigests(ctx, mailboxId, '2026-10-17')).toBe(1);
			expect(await ctx.db.get(older)).toMatchObject({ state: 'failed', items: [] });
			expect((await ctx.db.get(current))!.state).toBe('generated');
			expect((await ctx.db.get(current))!.items).toHaveLength(1);
			const generated = await ctx.db
				.query('mailDigests')
				.withIndex('by_mailbox_state', (q) => q.eq('mailboxId', mailboxId).eq('state', 'generated'))
				.collect();
			expect(generated).toHaveLength(1);
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
