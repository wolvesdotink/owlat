/**
 * D10 (ADR-0073), lazy interpretation for display-only mail:
 *
 *   - a personal delivery whose only consumer is the reader display is
 *     deferred: no run is scheduled, the source is stored deferred (not
 *     outstanding) and the brief reads `pending` with `deferredSources`;
 *   - the stale-source sweep and the history backfill leave it alone;
 *   - opening the thread (`lazy.ensure`) runs it even when the history is done;
 *   - every consumer other than the display keeps the eager run: a shared
 *     mailbox, a reply candidate, a thread with tracked items or a response
 *     plan, and an ineligible source (its run skips without a model call).
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import { enableFeatures } from '../../../__tests__/factories';
import { insertDeliveredMessage } from '../../deliveryPipeline/insert';
import {
	runPostInsertInboundEffects,
	type InboundOrigin,
} from '../../deliveryPipeline/afterInsert';
import {
	seedFolder,
	seedMailbox,
	type MailboxSeed,
	type SeededFolderRole,
} from '../../__tests__/helpers.testlib';
import { STALE_MS, settleSource } from '../outstanding';
import { briefCompleteness } from '../purgeRepairs';
import { historyGapOf } from '../brief';
import { enqueueHistoryPage } from '../backfillSources';
import { modules, type Test } from './interpret.testlib';

const session = vi.hoisted(() => ({
	current: { userId: 'user-A', role: 'member', activeOrganizationId: 'org-1' },
}));
vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session.current),
		isActiveOrgMember: vi.fn(async () => true),
		getMutationContext: vi.fn(async () => session.current),
		getBetterAuthSessionWithRole: vi.fn(async () => session.current),
	};
});

beforeEach(() => {
	vi.useRealTimers();
});

type RunCtx = Parameters<Parameters<Test['run']>[0]>[0];

async function deliver(
	ctx: RunCtx,
	mailboxId: Id<'mailboxes'>,
	opts: { role: SeededFolderRole; origin: InboundOrigin; from?: string; messageId?: string }
): Promise<Doc<'mailMessages'>> {
	const mailbox = (await ctx.db.get(mailboxId))!;
	const folder = (await ctx.db
		.query('mailFolders')
		.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', opts.role))
		.first())!;
	const id = await insertDeliveredMessage(ctx, {
		mailbox,
		folder,
		rawStorageId: await ctx.storage.store(new Blob(['raw'])),
		rawSize: 3,
		from: opts.from ?? 'Shop <orders@shop.test>',
		to: [mailbox.address],
		cc: [],
		bcc: [],
		subject: 'Your order shipped',
		textBodyInline: 'Your order 4711 shipped today and arrives on Friday.',
		messageId: opts.messageId ?? '<o1@shop.test>',
		receivedAt: Date.now(),
		attachments: [],
		inboundOrigin: opts.origin,
	});
	await runPostInsertInboundEffects(ctx, { messageId: id, folder, origin: opts.origin });
	return (await ctx.db.get(id))!;
}

async function seed(t: Test, mailbox: MailboxSeed = {}) {
	const mailboxId = await seedMailbox(t, { address: 'me@owlat.test', ...mailbox });
	for (const role of ['inbox', 'archive'] as const) await seedFolder(t, mailboxId, role);
	return mailboxId;
}

async function state(t: Test, message: Doc<'mailMessages'>) {
	return t.run(async (ctx) => ({
		runs: (await ctx.db.system.query('_scheduled_functions').collect())
			.filter((job) => job.state.kind === 'pending' && job.name.includes('interpretMessage'))
			.map((job) => job.args[0] as { source: unknown }),
		snapshot: await ctx.db
			.query('interpretSources')
			.withIndex('by_source_key', (q) => q.eq('sourceKey', `mail:${message._id}`))
			.first(),
		brief: await ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', message.threadId))
			.first(),
	}));
}

/** A delivery the Reply Queue was not asked about (synced into Archive). */
const deliverToArchive = (t: Test, mailboxId: Id<'mailboxes'>, messageId?: string) =>
	t.run((ctx) =>
		deliver(ctx, mailboxId, {
			role: 'archive',
			origin: 'sync',
			...(messageId ? { messageId } : {}),
		})
	);

describe('D10: display-only interpretation is deferred', () => {
	it('defers a personal delivery whose only consumer is the reader', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seed(t);
		const message = await deliverToArchive(t, mailboxId);

		const { runs, snapshot, brief } = await state(t, message);
		expect(runs).toEqual([]);
		expect(snapshot).toMatchObject({ isDeferred: true, deferReason: 'display_only' });
		expect(snapshot?.isOutstanding).toBeUndefined();
		expect(brief).toMatchObject({ deferredSources: 1, completeness: 'pending' });
		expect(brief?.pendingSources).toBeUndefined();
		expect(historyGapOf(brief)).toBe('pending');
	});

	it('the stale-source sweep and the history backfill leave it alone', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const mailboxId = await seed(t);
		const message = await deliverToArchive(t, mailboxId);
		vi.advanceTimersByTime(STALE_MS * 2);

		expect(await t.mutation(internal.mail.interpret.outstanding.sweep, {})).toEqual({
			rerun: 0,
			unread: 0,
		});
		const scheduled = await t.run((ctx) =>
			enqueueHistoryPage(ctx, { kind: 'mail', id: message.threadId })
		);
		expect(scheduled.scheduled).toBe(0);
		const { runs, snapshot } = await state(t, message);
		expect(runs).toEqual([]);
		expect(snapshot?.isDeferred).toBe(true);
	});

	it('opening the thread runs it, even when its history was read through', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const mailboxId = await seed(t);
		const message = await deliverToArchive(t, mailboxId);
		await t.run(async (ctx) => {
			const brief = await ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', message.threadId))
				.first();
			await ctx.db.patch(brief!._id, { historyState: 'done' });
		});

		const threadRef = { kind: 'mail' as const, id: message.threadId };
		expect(await t.mutation(api.mail.interpret.lazy.ensure, { threadRef })).toEqual({
			isEnqueued: true,
			runs: 1,
		});
		const { runs, snapshot, brief } = await state(t, message);
		expect(runs).toEqual([{ source: { kind: 'mail', id: message._id } }]);
		expect(snapshot).toMatchObject({ isOutstanding: true });
		expect(snapshot?.isDeferred).toBeUndefined();
		expect(brief?.deferredSources).toBeUndefined();
		expect(brief).toMatchObject({ pendingSources: 1, completeness: 'pending' });

		// Read now: a second open has nothing deferred left.
		expect(await t.mutation(api.mail.interpret.lazy.ensure, { threadRef })).toEqual({
			isEnqueued: false,
			reason: 'has_brief',
		});
	});

	it('an open with AI off leaves it deferred', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const mailboxId = await seed(t);
		const message = await deliverToArchive(t, mailboxId);
		const threadRef = { kind: 'mail' as const, id: message.threadId };
		expect(await t.mutation(api.mail.interpret.lazy.ensure, { threadRef })).toEqual({
			isEnqueued: false,
			reason: 'ai_off',
		});
		expect((await state(t, message)).snapshot?.isDeferred).toBe(true);
	});

	it('an outcome recorded for it (a purge, another run) clears the deferral', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seed(t);
		const message = await deliverToArchive(t, mailboxId);
		await t.run((ctx) => settleSource(ctx, `mail:${message._id}`, 'recorded'));
		const { snapshot, brief } = await state(t, message);
		expect(snapshot?.isDeferred).toBeUndefined();
		expect(brief?.deferredSources).toBeUndefined();
	});

	it('the classify run defers a delivered message that is no reply candidate', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seed(t);
		// An inbox delivery: the Reply Queue classify was scheduled for it, so the
		// source is captured outstanding and nothing else is scheduled.
		const message = await t.run((ctx) =>
			deliver(ctx, mailboxId, { role: 'inbox', origin: 'mx', from: 'no-reply@shop.test' })
		);
		expect((await state(t, message)).snapshot?.isOutstanding).toBe(true);
		// The classifier's non-candidate path: the flag is cleared, then it asks.
		await t.mutation(internal.mail.needsReply.applyResult, {
			threadId: message.threadId,
			needsReply: null,
		});
		expect(
			await t.mutation(internal.mail.interpret.defer.deferDeliveredIfDisplayOnly, {
				mailMessageId: message._id,
			})
		).toBe(true);
		const { snapshot, brief } = await state(t, message);
		expect(snapshot).toMatchObject({ isDeferred: true });
		expect(snapshot?.isOutstanding).toBeUndefined();
		expect(brief).toMatchObject({ deferredSources: 1, completeness: 'pending' });
		expect(brief?.pendingSources).toBeUndefined();
	});
});

describe('D10: every other consumer keeps the eager run', () => {
	it('a shared mailbox (actions mode)', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seed(t, { scope: 'shared' });
		const message = await deliverToArchive(t, mailboxId);
		const { runs, snapshot } = await state(t, message);
		expect(runs).toHaveLength(1);
		expect(snapshot?.isDeferred).toBeUndefined();
	});

	it('a reply candidate (the thread is flagged or pending)', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seed(t);
		const message = await t.run((ctx) =>
			deliver(ctx, mailboxId, { role: 'inbox', origin: 'mx', from: 'sam@acme.test' })
		);
		// The thread is still pending its needs-reply verdict.
		expect(
			await t.mutation(internal.mail.interpret.defer.deferDeliveredIfDisplayOnly, {
				mailMessageId: message._id,
			})
		).toBe(false);
	});

	it('a thread with open items, or with a response plan', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seed(t);
		const first = await deliverToArchive(t, mailboxId, '<o1@shop.test>');
		await t.run(async (ctx) => {
			const brief = await ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', first.threadId))
				.first();
			await ctx.db.patch(brief!._id, {
				itemCounts: { us: 1, them: 0, unclear: 0, closed: 0, hidden: 0 },
			});
		});
		const withItems = await deliverToArchive(t, mailboxId, '<o2@shop.test>');
		expect(withItems.threadId).not.toBe(first.threadId);
		expect((await state(t, withItems)).snapshot?.isDeferred).toBe(true);

		// Same thread as an item-carrying brief: kept eager.
		const reply = await t.run(async (ctx) => {
			const mailbox = (await ctx.db.get(mailboxId))!;
			const folder = (await ctx.db.get(first.folderId))!;
			const id = await insertDeliveredMessage(ctx, {
				mailbox,
				folder,
				rawStorageId: await ctx.storage.store(new Blob(['raw'])),
				rawSize: 3,
				from: 'Shop <orders@shop.test>',
				to: [mailbox.address],
				cc: [],
				bcc: [],
				subject: 'Re: Your order shipped',
				textBodyInline: 'Update: it arrives Saturday instead.',
				messageId: '<o3@shop.test>',
				inReplyTo: '<o1@shop.test>',
				receivedAt: Date.now(),
				attachments: [],
				inboundOrigin: 'sync',
			});
			await runPostInsertInboundEffects(ctx, { messageId: id, folder, origin: 'sync' });
			return (await ctx.db.get(id))!;
		});
		expect(reply.threadId).toBe(first.threadId);
		const replyState = await state(t, reply);
		expect(replyState.snapshot?.isDeferred).toBeUndefined();
		expect(replyState.runs).toContainEqual({ source: { kind: 'mail', id: reply._id } });
	});

	it('briefCompleteness counts deferred sources like outstanding ones', () => {
		const base = { sourceCounts: undefined };
		expect(briefCompleteness({ ...base, deferredSources: 1 })).toBe('pending');
		expect(briefCompleteness({ ...base })).toBe('none');
	});
});
