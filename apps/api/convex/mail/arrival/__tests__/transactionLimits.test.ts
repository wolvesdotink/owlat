/**
 * Sender-wide re-sorts within Convex transaction limits, measured
 * with `transactionLimits: true` at 200 distinct threads per sender: the
 * mutation that changes the sender recomputes a first batch of projections,
 * a bounded chain does the rest of the same set, and an undo reports
 * `isDone: false` until its chains finished.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../_generated/dataModel';
import { api } from '../../../_generated/api';
import { RESORT_INLINE_THREADS } from '../../senders/resortBatch';
import {
	learnTest,
	roleOf,
	seedPersonalMailbox,
	seedProfile,
	seedSenderThreads,
	type T,
} from './learn.testlib';

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

afterEach(() => {
	vi.useRealTimers();
});

const THREADS = 200;

async function placements(t: T, threadIds: Id<'mailThreads'>[]): Promise<Record<string, number>> {
	return await t.run(async (ctx) => {
		const counts: Record<string, number> = {};
		for (const id of threadIds) {
			const placement = (await ctx.db.get(id))?.arrival?.placement ?? 'none';
			counts[placement] = (counts[placement] ?? 0) + 1;
		}
		return counts;
	});
}

describe('sender-wide re-sorts at 200 threads, under production limits', () => {
	it('a status change recomputes a first batch now and the rest by its chain', async () => {
		vi.useFakeTimers();
		const t = learnTest({ transactionLimits: true });
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		const profile = await seedProfile(t, mailboxId);
		const { threadIds } = await seedSenderThreads(t, mailboxId, folders.inbox, THREADS);
		await t.mutation(api.mail.senders.status.setStatus, {
			target: { mailboxId, senderDigest: profile.senderDigest },
			status: 'digest',
		});
		expect((await placements(t, threadIds))['digest']).toBe(RESORT_INLINE_THREADS);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await placements(t, threadIds)).toEqual({ digest: THREADS });
	});

	it('a Resume while the chain runs neither stops it nor is undone by it', async () => {
		vi.useFakeTimers();
		const t = learnTest({ transactionLimits: true });
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		const profile = await seedProfile(t, mailboxId, {
			autoDraftPausedAt: 5,
			unusedDraftStreak: 5,
		});
		const { threadIds } = await seedSenderThreads(t, mailboxId, folders.inbox, THREADS);
		await t.mutation(api.mail.senders.status.setStatus, {
			target: { mailboxId, senderDigest: profile.senderDigest },
			status: 'digest',
		});
		const resumed = await t.mutation(api.mail.senders.status.resumeDrafts, {
			target: { mailboxId, senderDigest: profile.senderDigest },
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await placements(t, threadIds)).toEqual({ digest: THREADS });
		const after = await t.run(async (ctx) => ctx.db.get(profile._id));
		expect(after).toMatchObject({ status: 'digest', unusedDraftStreak: 0 });
		expect(after!.lastOperationId).toBe(resumed.operationId);
	});

	it('auto-archive moves 200 messages of 200 conversations and re-sorts them', async () => {
		vi.useFakeTimers();
		const t = learnTest({ transactionLimits: true });
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		const profile = await seedProfile(t, mailboxId);
		const { messageIds, threadIds } = await seedSenderThreads(t, mailboxId, folders.inbox, THREADS);
		const result = await t.mutation(api.mail.senders.status.setStatus, {
			target: { mailboxId, senderDigest: profile.senderDigest },
			status: 'auto_archive',
		});
		expect(result.archived).toBe(THREADS);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await placements(t, threadIds)).toEqual({ archived: THREADS });
		expect(await roleOf(t, messageIds[0]!)).toBe('archive');
	});

	it('a sender Fix stays within limits and re-sorts the whole newest set', async () => {
		vi.useFakeTimers();
		const t = learnTest({ transactionLimits: true });
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		const { messageIds, threadIds } = await seedSenderThreads(t, mailboxId, folders.inbox, THREADS);
		const result = await t.mutation(api.mail.arrival.fix.apply, {
			messageId: messageIds[0]!,
			destination: 'digest',
			scope: 'sender',
		});
		expect(result.resorted).toBe(THREADS);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await placements(t, threadIds)).toEqual({ digest: THREADS });
	});

	it('undoing ten senders of 200 threads each stays within limits and is done only after its chains', async () => {
		vi.useFakeTimers();
		const t = learnTest({ transactionLimits: true });
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		const operationId = await t.run(async (ctx) =>
			ctx.db.insert('mailArrivalOperations', {
				mailboxId,
				kind: 'suggestions',
				actor: 'user',
				changeCount: 10,
				status: 'applied',
				createdAt: Date.now(),
				expiresAt: Date.now() + 1_000_000,
			})
		);
		const all: Id<'mailThreads'>[] = [];
		for (let s = 0; s < 10; s++) {
			const address = `sender${s}@shop.example`;
			const profile = await seedProfile(t, mailboxId, {
				address,
				status: 'digest',
				statusSource: 'suggestion',
				lastOperationId: operationId,
			});
			const { threadIds } = await seedSenderThreads(t, mailboxId, folders.inbox, THREADS, address);
			all.push(...threadIds);
			await t.run(async (ctx) => {
				await ctx.db.insert('mailArrivalOperationChanges', {
					operationId,
					mailboxId,
					change: {
						kind: 'senderStatus',
						senderDigest: profile.senderDigest,
						before: { status: 'keep', statusSource: 'default' },
						after: { status: 'digest', statusSource: 'suggestion' },
					},
					createdAt: Date.now(),
					expiresAt: Date.now() + 1_000_000,
				});
			});
		}
		const result = await t.mutation(api.mail.arrival.operations.undo, { operationId });
		expect(result).toMatchObject({ status: 'undone', restored: 10, hasMore: true });
		expect(await t.query(api.mail.arrival.operations.undoStatus, { operationId })).toMatchObject({
			isPagingDone: true,
			pendingResorts: 10,
			isDone: false,
		});

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await t.query(api.mail.arrival.operations.undoStatus, { operationId })).toMatchObject({
			restored: 10,
			pendingResorts: 0,
			isDone: true,
		});
		expect(await placements(t, all)).toEqual({ today: 10 * THREADS });
	}, 120_000);
});
