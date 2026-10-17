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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import type { Id } from '../../../_generated/dataModel';
import { api, internal } from '../../../_generated/api';
import { modules } from '../../__tests__/helpers.testlib';
import { performOneClickRequest } from '../unsubscribeActions';
import { fetchGuarded } from '../../../lib/ssrfGuard';
import { addSenderDelivery, emptySenderWeeks } from '../counters';
import {
	deliverHosted,
	profileOf,
	roleOf,
	SENDER,
	seedPersonalMailbox,
	seedProfile,
	seedSenderMessages,
	type T,
} from './senders.testlib';

// The guarded POST's transport; `mail/__tests__/unsubscribe.test.ts` covers the guard itself.
vi.mock('../../../lib/ssrfGuard', () => ({ fetchGuarded: vi.fn() }));

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

	it('records an explicit Keep on a default profile and drops its suggestion', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		let weeks = emptySenderWeeks(Date.now());
		for (let i = 0; i < 6; i++) weeks = addSenderDelivery(weeks, Date.now());
		const profile = await seedProfile(t, mailboxId, { ...weeks, lastDeliveredAt: Date.now() });
		expect((await t.query(api.mail.senders.page.review, { mailboxId })).total).toBe(1);
		const result = await t.mutation(api.mail.senders.status.setStatus, {
			target: { mailboxId, senderDigest: profile.senderDigest },
			status: 'keep',
		});
		const { changes } = await changesOf(t, result.operationId!);
		expect(changes[0]!.change).toMatchObject({
			before: { status: 'keep', statusSource: 'default' },
			after: { status: 'keep', statusSource: 'user' },
		});
		expect((await t.query(api.mail.senders.page.review, { mailboxId })).total).toBe(0);
	});

	it('archives the newest 200 Inbox messages by arrival, whatever else the sender has', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		const base = Date.UTC(2026, 9, 1);
		// Newest mail first, then an import of 200 older ones (inserted later),
		// then newer mail already sitting in Archive.
		const [newest] = await seedSenderMessages(t, mailboxId, folders.inbox, [base + 10_000]);
		const imported = await seedSenderMessages(
			t,
			mailboxId,
			folders.inbox,
			Array.from({ length: 200 }, (_, i) => base - 1000 - i)
		);
		await seedSenderMessages(t, mailboxId, folders.archive, [base + 20_000, base + 30_000]);
		const profile = await seedProfile(t, mailboxId);

		const result = await t.mutation(api.mail.senders.status.setStatus, {
			target: { mailboxId, senderDigest: profile.senderDigest },
			status: 'auto_archive',
		});
		expect(result.archived).toBe(200);
		expect(await roleOf(t, newest!)).toBe('archive');
		// The single oldest import is the one past the bound.
		expect(await roleOf(t, imported[199]!)).toBe('inbox');
		expect(await roleOf(t, imported[0]!)).toBe('archive');
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
	beforeEach(() => vi.mocked(fetchGuarded).mockReset());

	it('suppresses locally, POSTs one-click and records the result', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		const id = (await deliverHosted(t, { unsubscribe: ONE_CLICK }))!;
		vi.mocked(fetchGuarded).mockResolvedValueOnce(new Response(null, { status: 200 }));
		const result = await t.action(api.mail.senders.unsubscribeActions.unsubscribe, {
			target: { messageId: id },
		});
		expect(result).toMatchObject({ scope: 'personal', method: 'one_click', result: 'confirmed' });
		expect(fetchGuarded).toHaveBeenCalledWith(ONE_CLICK.httpUrl, expect.anything());
		const profile = (await profileOf(t, mailboxId))!;
		expect(profile).toMatchObject({ status: 'unsubscribed', statusSource: 'user' });
		expect(profile.unsubscribe).toMatchObject({ method: 'one_click', result: 'confirmed' });
		if (result.scope !== 'personal') throw new Error('expected personal');
		expect(result.archived).toBe(1);
		const { operation } = await changesOf(t, result.operationId!);
		expect(operation.kind).toBe('unsubscribe');
	});

	it('keeps the local suppression and records "failed" when the POST fails', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		const id = (await deliverHosted(t, { unsubscribe: ONE_CLICK }))!;
		vi.mocked(fetchGuarded).mockResolvedValueOnce(new Response(null, { status: 500 }));
		const result = await t.action(api.mail.senders.unsubscribeActions.unsubscribe, {
			target: { messageId: id },
		});
		expect(result).toMatchObject({ result: 'failed', error: 'http_500' });
		const profile = (await profileOf(t, mailboxId))!;
		expect(profile.status).toBe('unsubscribed');
		expect(profile.unsubscribe?.result).toBe('failed');
	});

	it('only sends the request for a team inbox message, recording nothing', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t, { scope: 'shared' });
		const id = (await deliverHosted(t, { unsubscribe: ONE_CLICK }))!;
		vi.mocked(fetchGuarded).mockResolvedValueOnce(new Response(null, { status: 200 }));
		const result = await t.action(api.mail.senders.unsubscribeActions.unsubscribe, {
			target: { messageId: id },
		});
		expect(result).toMatchObject({ scope: 'shared', result: 'confirmed' });
		expect(await profileOf(t, mailboxId)).toBeNull();
		expect(await roleOf(t, id)).toBe('inbox');
	});

	it('records "opened" for a mailto or https sender and hands the target to the client', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		await deliverHosted(t, { unsubscribe: { oneClick: false, httpUrl: 'https://shop.example/u' } });
		const profile = (await profileOf(t, mailboxId))!;
		const result = await t.action(api.mail.senders.unsubscribeActions.unsubscribe, {
			target: { mailboxId, senderDigest: profile.senderDigest },
		});
		expect(result).toMatchObject({
			method: 'https',
			httpUrl: 'https://shop.example/u',
			result: null,
		});
		expect(fetchGuarded).not.toHaveBeenCalled();
		expect((await profileOf(t, mailboxId))!.unsubscribe).toMatchObject({
			method: 'https',
			result: 'opened',
		});
	});

	it('still suppresses locally when the sender offers no unsubscribe at all', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		const id = (await deliverHosted(t))!;
		const result = await t.action(api.mail.senders.unsubscribeActions.unsubscribe, {
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
				items: [
					{ senderDigest: quiet.senderDigest, suggestion: 'digest' },
					{ senderDigest: 'not-a-sender', suggestion: 'digest' },
				],
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

describe('the Subscriptions panel batch (one unsubscribe path)', () => {
	it('suppresses personal mail locally and records the result', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		const id = (await deliverHosted(t, { unsubscribe: ONE_CLICK }))!;
		vi.mocked(fetchGuarded)
			.mockReset()
			.mockResolvedValue(new Response(null, { status: 200 }));
		const { results } = await t.action(api.mail.subscriptions.unsubscribeAndArchive, {
			mailboxId,
			senderEmails: [SENDER],
			messageIds: [id],
		});
		expect(results).toEqual([{ senderEmail: SENDER, status: 'unsubscribed', archived: 1 }]);
		const profile = (await profileOf(t, mailboxId))!;
		expect(profile).toMatchObject({ status: 'unsubscribed', statusSource: 'user' });
		expect(profile.unsubscribe?.result).toBe('confirmed');
		const operations = await t.run(
			async (ctx) => await ctx.db.query('mailArrivalOperations').collect()
		);
		expect(operations.map((operation) => operation.kind)).toEqual(['unsubscribe']);
	});
});
