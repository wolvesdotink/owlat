/**
 * Sender-status changes as operations (SPEC §2.9, §4.4, §5): each change
 * writes its operation header and change rows in the same mutation, stamps the
 * profile's `lastOperationId`, archives the sender's newest Inbox mail for
 * archiving statuses (logged per message), and unsubscribing records local
 * suppression separately from the external request's result.
 *
 * Undo itself is lane learn's (`operations.undo`); these tests pin the rows it
 * will read.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import type { Id } from '../../../_generated/dataModel';
import { api, internal } from '../../../_generated/api';
import { modules } from '../../__tests__/helpers.testlib';
import { performOneClickRequest } from '../unsubscribeActions';
import { addSenderDelivery, emptySenderWeeks } from '../counters';
import {
	deliverHosted,
	profileOf,
	roleOf,
	SENDER,
	seedPersonalMailbox,
	seedProfile,
	type T,
} from './senders.testlib';

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

async function changesOf(t: T, operationId: Id<'mailArrivalOperations'>) {
	return await t.run(async (ctx) => ({
		operation: (await ctx.db.get(operationId))!,
		changes: await ctx.db
			.query('mailArrivalOperationChanges')
			.withIndex('by_operation', (q) => q.eq('operationId', operationId))
			.collect(),
	}));
}

async function scheduled(t: T) {
	return await t.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect());
}

const ONE_CLICK = { oneClick: true, httpUrl: 'https://shop.example/unsub?u=1' };

describe('setStatus', () => {
	it('logs the status change and archives the newest Inbox mail, one row per message', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		const first = (await deliverHosted(t))!;
		const second = (await deliverHosted(t))!;
		await t.run(async (ctx) => {
			const message = (await ctx.db.get(first))!;
			// A pending reply verdict the archive will clear (undo cannot restore it).
			await ctx.db.patch(message.threadId, {
				needsReply: { messageId: first, source: 'llm', urgency: 'normal', detectedAt: Date.now() },
			});
		});
		const digest = (await profileOf(t, mailboxId))!.senderDigest;

		const result = await t.mutation(api.mail.senders.status.setStatus, {
			target: { mailboxId, senderDigest: digest },
			status: 'auto_archive',
		});
		expect(result.archived).toBe(2);
		expect(await roleOf(t, first)).toBe('archive');
		expect(await roleOf(t, second)).toBe('archive');

		const { operation, changes } = await changesOf(t, result.operationId!);
		expect(operation).toMatchObject({ kind: 'sender_status', actor: 'user', changeCount: 3 });
		expect(operation.senderDigest).toBe(digest);
		const status = changes.find((row) => row.change.kind === 'senderStatus')!;
		expect(status.change).toMatchObject({
			before: { status: 'keep', statusSource: 'default' },
			after: { status: 'auto_archive', statusSource: 'user' },
		});
		const moves = changes.filter((row) => row.change.kind === 'messageFolder');
		expect(moves.map((row) => row.messageId).sort()).toEqual([first, second].sort());
		expect(moves.find((row) => row.messageId === first)!.isNeedsReplyCleared).toBe(true);
		expect(moves.find((row) => row.messageId === second)!.isNeedsReplyCleared).toBeUndefined();

		const profile = (await profileOf(t, mailboxId))!;
		expect(profile.lastOperationId).toBe(result.operationId);
		expect(profile.statusOperationId).toBe(result.operationId);
	});

	it('writes nothing when the status is already set', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		const profile = await seedProfile(t, mailboxId, { status: 'digest', statusSource: 'user' });
		const result = await t.mutation(api.mail.senders.status.setStatus, {
			target: { mailboxId, senderDigest: profile.senderDigest },
			status: 'digest',
		});
		expect(result.operationId).toBeNull();
		const operations = await t.run(
			async (ctx) => await ctx.db.query('mailArrivalOperations').collect()
		);
		expect(operations).toHaveLength(0);
	});

	it('creates a profile from a message (⇧E from the reader)', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		const id = (await deliverHosted(t))!;
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query('mailSenderProfiles').collect())
				await ctx.db.delete(row._id);
		});
		const result = await t.mutation(api.mail.senders.status.setStatus, {
			target: { messageId: id },
			status: 'auto_archive',
		});
		expect(result.address).toBe(SENDER);
		expect((await profileOf(t, mailboxId))!.status).toBe('auto_archive');
	});
});

describe('unsubscribe', () => {
	it('suppresses locally and schedules the one-click request', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		const id = (await deliverHosted(t, { unsubscribe: ONE_CLICK }))!;
		const result = await t.mutation(api.mail.senders.status.unsubscribe, {
			target: { messageId: id },
		});
		expect(result.method).toBe('one_click');
		expect(result.archived).toBe(1);
		const profile = (await profileOf(t, mailboxId))!;
		expect(profile).toMatchObject({ status: 'unsubscribed', statusSource: 'user' });
		expect(profile.unsubscribe).toBeUndefined();
		const jobs = await scheduled(t);
		expect(jobs.some((job) => job.name.includes('unsubscribeActions'))).toBe(true);
		const { operation } = await changesOf(t, result.operationId!);
		expect(operation.kind).toBe('unsubscribe');
	});

	it('records "opened" for a mailto or https sender and hands the target to the client', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		await deliverHosted(t, { unsubscribe: { oneClick: false, httpUrl: 'https://shop.example/u' } });
		const profile = (await profileOf(t, mailboxId))!;
		const result = await t.mutation(api.mail.senders.status.unsubscribe, {
			target: { mailboxId, senderDigest: profile.senderDigest },
		});
		expect(result).toMatchObject({ method: 'https', httpUrl: 'https://shop.example/u' });
		expect((await profileOf(t, mailboxId))!.unsubscribe).toMatchObject({
			method: 'https',
			result: 'opened',
		});
	});

	it('still suppresses locally when the sender offers no unsubscribe at all', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		const id = (await deliverHosted(t))!;
		const result = await t.mutation(api.mail.senders.status.unsubscribe, {
			target: { messageId: id },
		});
		expect(result.method).toBeNull();
		expect((await profileOf(t, mailboxId))!.status).toBe('unsubscribed');
		expect((await profileOf(t, mailboxId))!.unsubscribe).toBeUndefined();
	});

	it('records the one-click result, never over a newer request', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		const profile = await seedProfile(t, mailboxId, {
			status: 'unsubscribed',
			statusSource: 'user',
		});
		const record = (requestedAt: number, isConfirmed: boolean) =>
			t.mutation(internal.mail.senders.unsubscribe.recordOneClickResult, {
				profileId: profile._id,
				requestedAt,
				isConfirmed,
			});
		await record(100, false);
		expect((await profileOf(t, mailboxId))!.unsubscribe).toEqual({
			method: 'one_click',
			requestedAt: 100,
			result: 'failed',
		});
		await record(200, true);
		await record(150, false);
		expect((await profileOf(t, mailboxId))!.unsubscribe?.result).toBe('confirmed');
	});

	it('runs the guarded POST only for a one-click target', async () => {
		const post = vi.fn().mockResolvedValue({ ok: true });
		expect(await performOneClickRequest({ httpUrl: 'https://x.example/u' }, post)).toEqual({
			ok: true,
		});
		expect(post).toHaveBeenCalledWith('https://x.example/u');
		post.mockClear();
		expect(await performOneClickRequest(null, post)).toEqual({ ok: false, error: 'not_one_click' });
		expect(post).not.toHaveBeenCalled();
	});
});

describe('resumeDrafts', () => {
	it('clears the draft pause as one operation', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		const profile = await seedProfile(t, mailboxId, { autoDraftPausedAt: 5, unusedDraftStreak: 5 });
		const result = await t.mutation(api.mail.senders.status.resumeDrafts, {
			target: { mailboxId, senderDigest: profile.senderDigest },
		});
		const { operation, changes } = await changesOf(t, result.operationId!);
		expect(operation).toMatchObject({ kind: 'draft_resume', changeCount: 1 });
		expect(changes[0]!.change).toEqual({
			kind: 'senderDraftPause',
			senderDigest: profile.senderDigest,
			before: { autoDraftPausedAt: 5, unusedDraftStreak: 5 },
			after: { unusedDraftStreak: 0 },
		});
		const after = (await profileOf(t, mailboxId))!;
		expect(after.autoDraftPausedAt).toBeUndefined();
		expect(after.unusedDraftStreak).toBe(0);
		expect(after.lastOperationId).toBe(result.operationId);
	});
});

describe('suggestions', () => {
	it('lists rarely read senders and applies them as one operation', async () => {
		vi.useFakeTimers();
		try {
			const t = convexTest(schema, modules);
			const { mailboxId } = await seedPersonalMailbox(t);
			let weeks = emptySenderWeeks(Date.now());
			for (let i = 0; i < 6; i++) weeks = addSenderDelivery(weeks, Date.now());
			const quiet = await seedProfile(t, mailboxId, {
				...weeks,
				kind: 'newsletter',
				lastDeliveredAt: Date.now(),
			});
			await seedProfile(t, mailboxId, {
				...weeks,
				address: 'chosen@example.com',
				statusSource: 'user',
				lastDeliveredAt: Date.now(),
			});
			const review = await t.query(api.mail.senders.page.review, { mailboxId });
			expect(review.total).toBe(1);
			expect(review.rows[0]).toMatchObject({
				senderDigest: quiet.senderDigest,
				suggestion: 'digest',
			});

			const result = await t.mutation(api.mail.senders.suggestions.applySuggestions, {
				mailboxId,
				senderDigests: [quiet.senderDigest, 'not-a-sender'],
			});
			expect(result.applied).toBe(1);
			const { operation, changes } = await changesOf(t, result.operationId!);
			expect(operation).toMatchObject({ kind: 'suggestions', changeCount: 1 });
			expect(changes[0]!.change).toMatchObject({
				kind: 'senderStatus',
				after: { status: 'digest', statusSource: 'suggestion' },
			});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			expect((await profileOf(t, mailboxId))!.status).toBe('digest');
			const page = await t.query(api.mail.senders.page.list, {
				mailboxId,
				tab: 'digest',
				paginationOpts: { numItems: 10, cursor: null },
			});
			expect(page.page.map((row) => row.address)).toEqual([SENDER]);
		} finally {
			vi.useRealTimers();
		}
	});
});
