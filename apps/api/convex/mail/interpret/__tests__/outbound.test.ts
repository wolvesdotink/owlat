/**
 * Outbound wiring (SPEC §5 "Outbound") against a real (convex-test) database:
 *
 *   - a Postbox recipient reaching `sent` appends `reply_sent`, schedules the
 *     sent message's interpretation once and marks the brief pending;
 *   - a bounce appends `delivery_failed` and fails ONLY the dispositions that
 *     send moved, for the recipient it missed;
 *   - the post-interpretation reconcile catches a bounce that landed first;
 *   - a team reply's Send: finalization appends `auto_sent` / `reply_sent` and
 *     schedules `teamReply` interpretation; a failed Send fails what it answered.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { onTeamSendFinalized } from '../sendActivity';
import { reconcileSendFailure } from '../sendFailure';
import { appendActivity } from '../activity';
import {
	modules,
	reduceItem,
	reduceResult,
	seedMailThread,
	seedTeamThread,
	type Test,
} from './interpret.testlib';

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

const SENT = Date.UTC(2026, 9, 7, 9, 0);
const REPLIED = Date.UTC(2026, 9, 7, 11, 0);

/** Our reply in the thread, queued to the given recipients. */
async function seedOutbound(
	t: Test,
	mailboxId: Id<'mailboxes'>,
	threadId: Id<'mailThreads'>,
	recipients: string[]
): Promise<Id<'mailMessages'>> {
	return t.run(async (ctx) => {
		const inbound = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', threadId))
			.first();
		return ctx.db.insert('mailMessages', {
			mailboxId,
			folderId: inbound!.folderId,
			uid: 2,
			modseq: 2,
			rfc822MessageId: `<reply-${recipients.length}@owlat.test>`,
			threadId,
			fromAddress: 'me@owlat.test',
			toAddresses: recipients,
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Re: hello',
			normalizedSubject: 'hello',
			snippet: 'Attached.',
			rawStorageId: await ctx.storage.store(new Blob(['raw'])),
			rawSize: 3,
			attachments: [],
			hasAttachments: false,
			flagSeen: true,
			flagFlagged: false,
			flagAnswered: false,
			flagDraft: false,
			flagDeleted: false,
			customFlags: [],
			labelIds: [],
			receivedAt: REPLIED,
			internalDate: REPLIED,
			sentByUserId: 'user-A',
			outbound: {
				state: 'queued',
				recipients: recipients.map((address, idx) => ({
					idx,
					address,
					mtaJobId: `pb-x-${idx}`,
					state: 'queued' as const,
				})),
			},
			createdAt: REPLIED,
			updatedAt: REPLIED,
		});
	});
}

/** Two open items from the inbound message: one from Jonas, one from Mia. */
async function seedItems(t: Test, messageId: Id<'mailMessages'>, threadId: Id<'mailThreads'>) {
	await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source: { kind: 'mail', id: messageId },
		threadRef: { kind: 'mail', id: threadId },
		mode: 'brief',
		contentRevision: 'rev-1',
		extractorVersion: 1,
		expectedRevision: 0,
		deletionEpoch: 0,
		sourceAt: SENT,
		direction: 'inbound',
		status: 'complete',
		result: reduceResult({
			items: [
				reduceItem(),
				reduceItem({
					assertion: 'Confirm the venue',
					display: { en: 'Confirm the venue', de: 'Bestätige den Ort' },
					requester: { email: 'mia@example.com', isUs: false },
				}),
			],
		}),
	});
	return t.run(async (ctx) =>
		ctx.db
			.query('threadItems')
			.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
			.collect()
	);
}

/** The reducer applying our reply: it answered both items. */
async function applyReply(
	t: Test,
	outboundId: Id<'mailMessages'>,
	threadId: Id<'mailThreads'>,
	itemIds: Id<'threadItems'>[]
) {
	const revision = await t.run(
		async (ctx) =>
			(await ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.first())!.interpretationRevision
	);
	await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source: { kind: 'outboundMail', id: outboundId },
		threadRef: { kind: 'mail', id: threadId },
		mode: 'brief',
		contentRevision: 'rev-out',
		extractorVersion: 1,
		expectedRevision: revision,
		deletionEpoch: 0,
		sourceAt: REPLIED,
		direction: 'outbound',
		status: 'complete',
		result: reduceResult({
			items: [],
			transitions: itemIds.map((itemId) => ({
				itemId,
				disposition: 'answered' as const,
				evidence: [{ segmentId: 's0', start: 0, end: 9, quote: 'Attached.' }],
				isVerified: true,
				isReviewNeeded: false,
			})),
			replyIntent: 'informational_update',
		}),
	});
}

async function state(t: Test, threadId: Id<'mailThreads'>) {
	return t.run(async (ctx) => ({
		items: await ctx.db
			.query('threadItems')
			.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
			.collect(),
		activity: await ctx.db
			.query('threadActivity')
			.withIndex('by_mail_thread_and_seq', (q) => q.eq('mailThreadId', threadId))
			.collect(),
		brief: await ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.first(),
		scheduled: (await ctx.db.system.query('_scheduled_functions').collect()).map((job) => ({
			name: job.name,
			args: job.args,
		})),
	}));
}

function transition(
	t: Test,
	mailMessageId: Id<'mailMessages'>,
	recipientIdx: number,
	input:
		| { to: 'sent'; at: number }
		| { to: 'bounced'; at: number; bounceMessage?: string }
		| { to: 'failed'; at: number; errorMessage: string }
) {
	return t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
		mailMessageId,
		recipientIdx,
		input,
	});
}

describe('Postbox outbound lifecycle → thread brief', () => {
	it('schedules the sent message once, appends reply_sent and marks the brief pending', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, threadId } = await seedMailThread(t);
		const outboundId = await seedOutbound(t, mailboxId, threadId, [
			'jonas@example.com',
			'mia@example.com',
		]);

		await transition(t, outboundId, 0, { to: 'sent', at: REPLIED });
		await transition(t, outboundId, 1, { to: 'sent', at: REPLIED + 1 });
		// A webhook redelivery is recorded, not transitioned.
		await transition(t, outboundId, 0, { to: 'sent', at: REPLIED + 2 });

		const s = await state(t, threadId);
		const sent = s.activity.filter((a) => a.type === 'reply_sent');
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			actor: { kind: 'user', id: 'user-A' },
			provenance: 'recorded',
			opRef: { kind: 'outbound', id: outboundId },
			eventAt: REPLIED,
		});
		const runs = s.scheduled.filter((j) => j.name.includes('outboundRun'));
		expect(runs).toHaveLength(1);
		expect(runs[0]?.args[0]).toEqual({ source: { kind: 'outboundMail', id: outboundId } });
		expect(s.brief?.completeness).toBe('pending');
	});

	it('a bounce fails only the dispositions that send moved for the missed recipient', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedMailThread(t);
		const items = await seedItems(t, messageId, threadId);
		const jonas = items.find((i) => i.counterpartyKey === 'jonas@example.com')!;
		const mia = items.find((i) => i.counterpartyKey === 'mia@example.com')!;
		const outboundId = await seedOutbound(t, mailboxId, threadId, [
			'jonas@example.com',
			'mia@example.com',
		]);
		await transition(t, outboundId, 0, { to: 'sent', at: REPLIED });
		await transition(t, outboundId, 1, { to: 'sent', at: REPLIED });
		await applyReply(t, outboundId, threadId, [jonas._id, mia._id]);

		await transition(t, outboundId, 1, { to: 'bounced', at: REPLIED + 60_000 });
		// A repeat bounce changes nothing more.
		await transition(t, outboundId, 1, { to: 'bounced', at: REPLIED + 61_000 });

		const s = await state(t, threadId);
		const byId = new Map(s.items.map((i) => [i._id, i]));
		expect(byId.get(jonas._id)?.disposition).toBe('answered');
		expect(byId.get(mia._id)).toMatchObject({ disposition: 'failed', revision: 3 });
		expect(s.activity.filter((a) => a.type === 'delivery_failed')).toHaveLength(1);
		const changed = s.activity.filter(
			(a) => a.type === 'item_changed' && a.delta?.dispositionTo === 'failed'
		);
		expect(changed).toHaveLength(1);
		expect(changed[0]).toMatchObject({
			itemId: mia._id,
			itemRevision: 3,
			delta: { dispositionFrom: 'answered', dispositionTo: 'failed' },
			opRef: { kind: 'outbound', id: outboundId },
		});
	});

	it('fails every answered item when the send reached nobody', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedMailThread(t);
		const items = await seedItems(t, messageId, threadId);
		const outboundId = await seedOutbound(t, mailboxId, threadId, ['jonas@example.com']);
		await transition(t, outboundId, 0, { to: 'sent', at: REPLIED });
		await applyReply(
			t,
			outboundId,
			threadId,
			items.map((i) => i._id)
		);

		await transition(t, outboundId, 0, { to: 'bounced', at: REPLIED + 60_000 });

		const s = await state(t, threadId);
		expect(s.items.map((i) => i.disposition)).toEqual(['failed', 'failed']);
	});

	it('leaves an item another message moved since', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedMailThread(t);
		const [first] = await seedItems(t, messageId, threadId);
		const outboundId = await seedOutbound(t, mailboxId, threadId, ['jonas@example.com']);
		await transition(t, outboundId, 0, { to: 'sent', at: REPLIED });
		await applyReply(t, outboundId, threadId, [first!._id]);
		await t.run(async (ctx) => {
			await ctx.db.patch(first!._id, { disposition: 'accepted' });
		});

		await transition(t, outboundId, 0, { to: 'bounced', at: REPLIED + 60_000 });

		const s = await state(t, threadId);
		expect(s.items.find((i) => i._id === first!._id)?.disposition).toBe('accepted');
	});

	it('the post-interpretation reconcile fails what a bounce that landed first missed', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedMailThread(t);
		const [first] = await seedItems(t, messageId, threadId);
		const outboundId = await seedOutbound(t, mailboxId, threadId, ['jonas@example.com']);
		await transition(t, outboundId, 0, { to: 'bounced', at: REPLIED });
		// The model read the reply after the bounce: it still marks the item answered.
		await applyReply(t, outboundId, threadId, [first!._id]);
		expect((await state(t, threadId)).items.find((i) => i._id === first!._id)?.disposition).toBe(
			'answered'
		);

		const changed = await t.mutation(internal.mail.interpret.sendFailure.reconcile, {
			source: { kind: 'outboundMail', id: outboundId },
		});

		expect(changed).toBe(1);
		expect((await state(t, threadId)).items.find((i) => i._id === first!._id)?.disposition).toBe(
			'failed'
		);
	});

	it('a send that never failed takes nothing back', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedMailThread(t);
		const [first] = await seedItems(t, messageId, threadId);
		const outboundId = await seedOutbound(t, mailboxId, threadId, ['jonas@example.com']);
		await transition(t, outboundId, 0, { to: 'sent', at: REPLIED });
		await applyReply(t, outboundId, threadId, [first!._id]);

		const changed = await t.run(async (ctx) =>
			reconcileSendFailure(ctx, { kind: 'outboundMail', id: outboundId })
		);

		expect(changed).toEqual([]);
		expect((await state(t, threadId)).items.find((i) => i._id === first!._id)?.disposition).toBe(
			'answered'
		);
	});
	it('a bounce leaves an answer another send now supports (dispositionSource)', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedMailThread(t);
		const [first] = await seedItems(t, messageId, threadId);
		const replyA = await seedOutbound(t, mailboxId, threadId, ['jonas@example.com']);
		await transition(t, replyA, 0, { to: 'sent', at: REPLIED });
		await applyReply(t, replyA, threadId, [first!._id]);
		// What the reducer records once a later reply B restates the answer.
		await t.run(async (ctx) =>
			ctx.db.patch(first!._id, {
				dispositionSource: { sourceKey: 'outboundMail:replyB', at: REPLIED + 1 },
			})
		);

		await transition(t, replyA, 0, { to: 'bounced', at: REPLIED + 60_000 });

		const item = (await state(t, threadId)).items.find((i) => i._id === first!._id);
		expect(item?.disposition).toBe('answered');
	});

	it('a failure it does make names the failed send as the disposition source', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedMailThread(t);
		const [first] = await seedItems(t, messageId, threadId);
		const replyA = await seedOutbound(t, mailboxId, threadId, ['jonas@example.com']);
		await transition(t, replyA, 0, { to: 'sent', at: REPLIED });
		await applyReply(t, replyA, threadId, [first!._id]);

		await transition(t, replyA, 0, { to: 'bounced', at: REPLIED + 60_000 });

		const item = (await state(t, threadId)).items.find((i) => i._id === first!._id);
		expect(item).toMatchObject({
			disposition: 'failed',
			dispositionSource: { sourceKey: `op:outboundMail:${replyA}` },
		});
	});

	// Review F1: equal disposition is not dependence. `sendFailure` reads
	// `threadItems.dispositionSource`; a newer verified reply restating the
	// current disposition moves it to that reply (reducePlan.ts, round 5 F2).
	it('A answers, B answers again, A bounces: the item stays answered', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedMailThread(t);
		const [first] = await seedItems(t, messageId, threadId);
		const replyA = await seedOutbound(t, mailboxId, threadId, ['jonas@example.com']);
		const replyB = await seedOutbound(t, mailboxId, threadId, ['jonas@example.com', 'x@y.test']);
		await transition(t, replyA, 0, { to: 'sent', at: REPLIED });
		await applyReply(t, replyA, threadId, [first!._id]);
		await transition(t, replyB, 0, { to: 'sent', at: REPLIED + 1 });
		await applyReply(t, replyB, threadId, [first!._id]);

		await transition(t, replyA, 0, { to: 'bounced', at: REPLIED + 60_000 });

		const item = (await state(t, threadId)).items.find((i) => i._id === first!._id);
		expect(item?.disposition).toBe('answered');
	});
});

describe('Team send finalization → thread brief', () => {
	async function seedSend(t: Test, inboundId: Id<'inboundMessages'>) {
		return t.run(async (ctx) =>
			ctx.db.insert('transactionalSends', {
				kind: 'agent_reply',
				email: 'customer@example.com',
				status: 'queued',
				queuedAt: REPLIED,
				subject: 'Re: Order 42',
				inboundMessageId: inboundId,
			})
		);
	}

	async function teamActivity(t: Test, threadId: Id<'conversationThreads'>) {
		return t.run(async (ctx) => ({
			activity: await ctx.db
				.query('threadActivity')
				.withIndex('by_conversation_thread_and_seq', (q) => q.eq('conversationThreadId', threadId))
				.collect(),
			scheduled: (await ctx.db.system.query('_scheduled_functions').collect()).map((j) => ({
				name: j.name,
				args: j.args,
			})),
		}));
	}

	it('an auto-approved send appends auto_sent and schedules teamReply interpretation once', async () => {
		const t = convexTest(schema, modules);
		const { threadId, inboundId } = await seedTeamThread(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(inboundId, { approvalSource: 'auto' });
		});
		const sendId = await seedSend(t, inboundId);

		await t.run(async (ctx) => {
			const send = (await ctx.db.get(sendId))!;
			await onTeamSendFinalized(ctx, send, { to: 'sent', at: REPLIED });
			await onTeamSendFinalized(ctx, send, { to: 'sent', at: REPLIED });
		});

		const s = await teamActivity(t, threadId);
		expect(s.activity.map((a) => [a.type, a.actor.kind])).toEqual([['auto_sent', 'agent']]);
		const runs = s.scheduled.filter((j) => j.name.includes('outboundRun'));
		expect(runs).toHaveLength(1);
		expect(runs[0]?.args[0]).toEqual({ source: { kind: 'teamReply', id: sendId } });
	});

	it('a human-approved send appends reply_sent; a failed Send appends delivery_failed', async () => {
		const t = convexTest(schema, modules);
		const { threadId, inboundId } = await seedTeamThread(t);
		const sendId = await seedSend(t, inboundId);

		await t.run(async (ctx) => {
			const send = (await ctx.db.get(sendId))!;
			await onTeamSendFinalized(ctx, send, { to: 'sent', at: REPLIED });
			await ctx.db.patch(sendId, { status: 'bounced' });
			await onTeamSendFinalized(ctx, send, { to: 'bounced', at: REPLIED + 1 });
		});

		const s = await teamActivity(t, threadId);
		expect(s.activity.map((a) => [a.type, a.actor.kind])).toEqual([
			['reply_sent', 'user'],
			['delivery_failed', 'system'],
		]);
	});

	/** A person's follow-up on the thread, queued as a `team_reply` Send. */
	async function seedFollowUp(
		t: Test,
		threadId: Id<'conversationThreads'>,
		inboundId: Id<'inboundMessages'>
	) {
		return t.run(async (ctx) => {
			const followUpId = await ctx.db.insert('inboxFollowUps', {
				threadId,
				inReplyToMessageId: inboundId,
				subject: 'Re: Order 42',
				body: 'The refund is on its way.',
				status: 'sending',
				createdBy: 'user-B',
				createdAt: REPLIED,
				sendAt: REPLIED,
			});
			const sendId = await ctx.db.insert('transactionalSends', {
				kind: 'team_reply',
				email: 'customer@example.com',
				status: 'queued',
				queuedAt: REPLIED,
				subject: 'Re: Order 42',
				followUpId,
			});
			await ctx.db.patch(followUpId, { sendId });
			return { followUpId, sendId };
		});
	}

	it('a follow-up sent through the Send lifecycle appends reply_sent by its author and is interpreted once', async () => {
		const t = convexTest(schema, modules);
		const { threadId, inboundId } = await seedTeamThread(t);
		const { followUpId, sendId } = await seedFollowUp(t, threadId, inboundId);

		for (const at of [REPLIED, REPLIED + 1]) {
			await t.mutation(internal.delivery.sendLifecycle.transition, {
				send: { kind: 'transactional', id: sendId },
				transition: { to: 'sent', at, providerMessageId: 'p-1' },
			});
		}

		const s = await teamActivity(t, threadId);
		expect(s.activity.map((a) => [a.type, a.actor])).toEqual([
			['reply_sent', { kind: 'user', id: 'user-B' }],
		]);
		const runs = s.scheduled.filter((j) => j.name.includes('outboundRun'));
		expect(runs).toHaveLength(1);
		expect(runs[0]?.args[0]).toEqual({ source: { kind: 'teamReply', id: sendId } });
		expect((await t.run(async (ctx) => ctx.db.get(followUpId)))?.status).toBe('sent');
	});

	it('a failed follow-up appends delivery_failed and fails what it answered', async () => {
		const t = convexTest(schema, modules);
		const { threadId, inboundId } = await seedTeamThread(t);
		const { sendId } = await seedFollowUp(t, threadId, inboundId);
		await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
			source: { kind: 'inbound', id: inboundId },
			threadRef: { kind: 'team', id: threadId },
			mode: 'actions',
			contentRevision: 'rev-1',
			extractorVersion: 1,
			expectedRevision: 0,
			deletionEpoch: 0,
			sourceAt: SENT,
			direction: 'inbound',
			status: 'complete',
			result: reduceResult({
				items: [reduceItem({ requester: { email: 'customer@example.com', isUs: false } })],
				latest: undefined,
				facts: undefined,
			}),
		});
		// What the reducer records when the follow-up's interpretation answers
		// the item (its key shape, reduce.ts keyBase). Written by hand: the
		// reducer resolves a follow-up's thread only once sources/load/reduceState
		// follow `followUpId` (interpret lane).
		const itemId = await t.run(async (ctx) => {
			const item = (await ctx.db
				.query('threadItems')
				.withIndex('by_conversation_thread_and_status', (q) =>
					q.eq('conversationThreadId', threadId)
				)
				.first())!;
			await ctx.db.patch(item._id, {
				disposition: 'answered',
				dispositionSource: { sourceKey: `teamReply:${sendId}`, at: REPLIED },
				revision: 2,
			});
			await appendActivity(ctx, {
				threadRef: { kind: 'team', id: threadId },
				idempotencyKey: `interp:teamReply:${sendId}:rev-out:1:patch:${item._id}`,
				type: 'item_changed',
				actor: { kind: 'system' },
				provenance: 'reported',
				itemId: item._id,
				itemRevision: 2,
				delta: { dispositionFrom: 'unanswered', dispositionTo: 'answered' },
			});
			return item._id;
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'transactional', id: sendId },
			transition: { to: 'failed', at: REPLIED, errorMessage: 'boom', errorCode: 'X' },
		});

		const s = await teamActivity(t, threadId);
		expect(s.activity.filter((a) => a.type === 'delivery_failed')).toHaveLength(1);
		expect((await t.run(async (ctx) => ctx.db.get(itemId)))?.disposition).toBe('failed');
	});

	it.todo(
		'a dispatched follow-up stores its text snapshot (needs sources.threadOfSource to follow followUpId)'
	);

	it('a failed team reply fails the dispositions it answered', async () => {
		const t = convexTest(schema, modules);
		const { threadId, inboundId } = await seedTeamThread(t);
		const sendId = await seedSend(t, inboundId);
		await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
			source: { kind: 'inbound', id: inboundId },
			threadRef: { kind: 'team', id: threadId },
			mode: 'actions',
			contentRevision: 'rev-1',
			extractorVersion: 1,
			expectedRevision: 0,
			deletionEpoch: 0,
			sourceAt: SENT,
			direction: 'inbound',
			status: 'complete',
			result: reduceResult({
				items: [reduceItem({ requester: { email: 'customer@example.com', isUs: false } })],
				latest: undefined,
				facts: undefined,
			}),
		});
		const item = await t.run(async (ctx) =>
			ctx.db
				.query('threadItems')
				.withIndex('by_conversation_thread_and_status', (q) =>
					q.eq('conversationThreadId', threadId)
				)
				.first()
		);
		await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
			source: { kind: 'teamReply', id: sendId },
			threadRef: { kind: 'team', id: threadId },
			mode: 'actions',
			contentRevision: 'rev-out',
			extractorVersion: 1,
			expectedRevision: 1,
			deletionEpoch: 0,
			sourceAt: REPLIED,
			direction: 'outbound',
			status: 'complete',
			result: reduceResult({
				items: [],
				latest: undefined,
				facts: undefined,
				transitions: [
					{
						itemId: item!._id,
						disposition: 'answered',
						evidence: [{ segmentId: 's0', start: 0, end: 4, quote: 'Done' }],
						isVerified: true,
						isReviewNeeded: false,
					},
				],
			}),
		});

		await t.run(async (ctx) => {
			await ctx.db.patch(sendId, { status: 'failed' });
			await onTeamSendFinalized(ctx, (await ctx.db.get(sendId))!, { to: 'failed', at: REPLIED });
		});

		const after = await t.run(async (ctx) => ctx.db.get(item!._id));
		expect(after?.disposition).toBe('failed');
	});
});
