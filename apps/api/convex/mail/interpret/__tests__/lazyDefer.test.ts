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
import { STALE_MS, markOutstanding, settleSource } from '../outstanding';
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

	it('opening a thread with several deferred messages schedules only the newest (Sol r3)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const mailboxId = await seed(t);
		const first = await deliverToArchive(t, mailboxId, '<o1@shop.test>');
		const second = await t.run(async (ctx) => {
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
				textBodyInline: 'It is out for delivery.',
				messageId: '<o2@shop.test>',
				inReplyTo: '<o1@shop.test>',
				receivedAt: Date.now() + 1000,
				attachments: [],
				inboundOrigin: 'sync',
			});
			await runPostInsertInboundEffects(ctx, { messageId: id, folder, origin: 'sync' });
			return (await ctx.db.get(id))!;
		});
		expect(second.threadId).toBe(first.threadId);
		expect((await state(t, first)).snapshot?.isDeferred).toBe(true);
		expect((await state(t, second)).snapshot?.isDeferred).toBe(true);

		const threadRef = { kind: 'mail' as const, id: first.threadId };
		expect(await t.mutation(api.mail.interpret.lazy.ensure, { threadRef })).toEqual({
			isEnqueued: true,
			runs: 1,
		});
		// The newest runs (and reads the older one first, in its run); the older
		// one stays deferred until that run takes it.
		const { runs } = await state(t, second);
		expect(runs).toEqual([{ source: { kind: 'mail', id: second._id } }]);
		expect((await state(t, second)).snapshot).toMatchObject({ isOutstanding: true });
		expect((await state(t, first)).snapshot?.isDeferred).toBe(true);
		// A second open while that run is in flight starts no second reader.
		expect(await t.mutation(api.mail.interpret.lazy.ensure, { threadRef })).toEqual({
			isEnqueued: false,
			reason: 'running',
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

	/** A reply into `first`'s thread, delivered the same way (synced into Archive). */
	async function replyTo(t: Test, first: Doc<'mailMessages'>, n: number) {
		return t.run(async (ctx) => {
			const mailbox = (await ctx.db.get(first.mailboxId))!;
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
				messageId: `<r${n}@shop.test>`,
				inReplyTo: '<o1@shop.test>',
				receivedAt: Date.now(),
				attachments: [],
				inboundOrigin: 'sync',
			});
			await runPostInsertInboundEffects(ctx, { messageId: id, folder, origin: 'sync' });
			return (await ctx.db.get(id))!;
		});
	}

	/** One item on the thread, with this status, last changed `ageMs` ago. */
	async function seedItem(
		t: Test,
		message: Doc<'mailMessages'>,
		status: 'open' | 'done' | 'declined',
		ageMs = 0
	) {
		await t.run(async (ctx) => {
			const at = Date.now() - ageMs;
			await ctx.db.insert('threadItems', {
				threadKind: 'mail',
				mailThreadId: message.threadId,
				mailboxId: message.mailboxId,
				revision: 1,
				intent: 'request',
				facets: ['payment'],
				assertion: 'atrest:1:assertion',
				display: { en: 'atrest:1:en', de: 'atrest:1:de' },
				requester: { email: 'orders@shop.test', isUs: false },
				responsible: { isUs: true },
				responsibility: 'us',
				status,
				disposition: 'unanswered',
				evidence: [
					{
						source: { kind: 'mail', id: message._id },
						segmentId: 's0',
						start: 0,
						end: 4,
						contentRevision: 'rev1',
					},
				],
				verify: 'na',
				askedAt: at,
				createdAt: at,
				updatedAt: at,
			});
		});
	}

	const DAY = 24 * 60 * 60 * 1000;

	it('a thread with an open item', async () => {
		const t = convexTest(schema, modules);
		const first = await deliverToArchive(t, await seed(t), '<o1@shop.test>');
		await seedItem(t, first, 'open');
		const reply = await replyTo(t, first, 1);
		expect(reply.threadId).toBe(first.threadId);
		const replyState = await state(t, reply);
		expect(replyState.snapshot?.isDeferred).toBeUndefined();
		expect(replyState.runs).toContainEqual({ source: { kind: 'mail', id: reply._id } });
	});

	it('a thread with an item closed within the lookback, which the message could reopen (Sol r1 F1)', async () => {
		for (const status of ['done', 'declined'] as const) {
			const t = convexTest(schema, modules);
			const first = await deliverToArchive(t, await seed(t), '<o1@shop.test>');
			await seedItem(t, first, status, 2 * DAY);
			const reply = await replyTo(t, first, 1);
			const replyState = await state(t, reply);
			expect(replyState.snapshot?.isDeferred, status).toBeUndefined();
			expect(replyState.runs).toContainEqual({ source: { kind: 'mail', id: reply._id } });
		}
	});

	it('an item closed before the lookback cannot be moved, so the reply still defers', async () => {
		const t = convexTest(schema, modules);
		const first = await deliverToArchive(t, await seed(t), '<o1@shop.test>');
		await seedItem(t, first, 'done', 40 * DAY);
		const reply = await replyTo(t, first, 1);
		expect((await state(t, reply)).snapshot?.isDeferred).toBe(true);
	});

	it('another source of the thread still outstanding (Sol r1 F2)', async () => {
		const t = convexTest(schema, modules);
		const first = await deliverToArchive(t, await seed(t), '<o1@shop.test>');
		// The first message's run is in flight (enqueued eagerly, e.g. a reply
		// candidate's): it may be creating the item the next message updates.
		await t.run((ctx) => markOutstanding(ctx, `mail:${first._id}`));
		const reply = await replyTo(t, first, 1);
		const replyState = await state(t, reply);
		expect(replyState.snapshot?.isDeferred).toBeUndefined();
		expect(replyState.runs).toContainEqual({ source: { kind: 'mail', id: reply._id } });

		// Once both have an outcome, a later display-only message defers again.
		await t.run(async (ctx) => {
			await settleSource(ctx, `mail:${first._id}`, 'recorded');
			await settleSource(ctx, `mail:${reply._id}`, 'recorded');
		});
		const later = await replyTo(t, first, 2);
		expect((await state(t, later)).snapshot?.isDeferred).toBe(true);
	});

	it('a history walk still admitting pages', async () => {
		const t = convexTest(schema, modules);
		const first = await deliverToArchive(t, await seed(t), '<o1@shop.test>');
		await t.run(async (ctx) => {
			const brief = await ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', first.threadId))
				.first();
			await ctx.db.patch(brief!._id, { historyState: 'pending' });
		});
		const reply = await replyTo(t, first, 1);
		expect((await state(t, reply)).snapshot?.isDeferred).toBeUndefined();
	});

	it('briefCompleteness counts deferred sources like outstanding ones', () => {
		const base = { sourceCounts: undefined };
		expect(briefCompleteness({ ...base, deferredSources: 1 })).toBe('pending');
		expect(briefCompleteness({ ...base })).toBe('none');
	});
});
