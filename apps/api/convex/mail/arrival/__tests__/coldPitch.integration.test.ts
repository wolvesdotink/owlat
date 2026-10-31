/**
 * Cold pitches end to end: a cold sales pitch that asks for a call, from a sender the
 * owner never wrote to, delivered live through the hosted MX path with every
 * scheduled job run and a stubbed model that calls it a pitch AND says it
 * needs a reply. The screener is off throughout.
 *
 *   - either completion order (verdict before or after the reply verdict)
 *     ends in the digest, under Cold outreach, with no Reply Queue entry and
 *     the mail left in the Inbox (never spam); a re-run of the classification
 *     (the sweep's retry, a pending settle) does not bring the flag back;
 *   - a known sender is never asked, and a first-contact message the model
 *     does not call a pitch still lands in Needs you;
 *   - an owner reply clears the verdict, and a stale yes after it cannot
 *     restore it;
 *   - a heuristic category does not skip the question, and mail the Reply
 *     Queue screens out is never asked about;
 *   - relationship evidence that appears later (an acceptance, mail the owner
 *     wrote from another client, in any thread) clears the sender's verdicts,
 *     and mail written before it means the sender is never asked;
 *   - a fenced thread disregards its verdict and takes no late one;
 *   - a sender with more verdicts than one batch has them all cleared, and a
 *     re-verified signature that changes the read clears the verdict and
 *     refuses a yes read before it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { enableFeatures } from '../../../__tests__/factories';
import { categoryRefinementSchema } from '../../ai/categoryClassify';
import { briefModelSchema } from '../../interpret/schema';
import { readDigestCandidates } from '../../digest/select';
import { noteOwnerReply } from '../learningSignals';
import { refreshArrivalProjection, senderProfileOf } from '../projection';
import { commitColdPitchVerdict, isHeldOutAsColdPitch, SENDER_CLEARS_RECORDS } from '../coldPitch';
import { fenceThreadInterpretation } from '../../interpret/staleFence';
import { sourceVersionOf } from '../../interpret/sourceVersion';
import { OWNER, seedPersonalMailbox } from '../../rules/__tests__/rules.testlib';
import { roleOf } from '../../senders/__tests__/senders.testlib';
import { learnTest, seedSenderThreads, type T } from './learn.testlib';

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

const llm = vi.hoisted(() => ({ runLlmObject: vi.fn() }));

vi.mock('../../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../../analytics/__tests__/meteredDispatch.testlib');
	return { runLlmObject: metered((opts: unknown) => llm.runLlmObject(opts)) };
});
vi.mock('../../../lib/llmProvider', () => ({
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'stub-model' })),
}));

const NOW = Date.UTC(2026, 9, 21, 7, 0);
const PITCHER = 'jordan@growthleads.example';
const PITCH = {
	from: `Jordan Miles <${PITCHER}>`,
	subject: 'Quick question about your website',
	text: 'Hi, our agency doubles organic traffic in 90 days. Would you be open to a quick 15-minute call this week?',
};

type Opts = { schema: unknown; prompt?: string };
const answer = (object: unknown) => ({ object, tokenUsage: undefined, modelUsed: 'stub-model' });
const shapeOf = (schema: unknown) => (schema as { shape?: Record<string, unknown> }).shape ?? {};
const coldPitchCalls = () =>
	llm.runLlmObject.mock.calls.filter(([opts]) => 'coldPitch' in shapeOf((opts as Opts).schema));

/** What the stub says to the cold-pitch question. */
let verdict: 'yes' | 'no' = 'yes';

/** Every model path the delivery reaches: the pitch reads as needing a reply. */
function stubModel({ schema }: Opts) {
	if (schema === categoryRefinementSchema) return answer({ category: 'other' });
	if (schema === briefModelSchema) {
		return answer({
			mode: 'brief',
			items: [],
			transitions: [],
			replyIntent: 'direct_question',
			urgency: 'normal',
			meetingIntent: null,
			coverage: { segmentsRead: ['s0'], uncertain: false, overflow: false },
			latest: { en: [], de: [] },
			facts: [],
			exactWording: { isRequired: false, reason: null },
		});
	}
	const shape = shapeOf(schema);
	if ('coldPitch' in shape || 'answers' in shape) {
		return answer({
			...('category' in shape ? { category: 'other' } : {}),
			...('coldPitch' in shape ? { coldPitch: verdict } : {}),
			...('answers' in shape ? { answers: [] } : {}),
		});
	}
	return answer({ verdicts: [] });
}

beforeEach(() => {
	vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
	verdict = 'yes';
	llm.runLlmObject.mockReset();
	llm.runLlmObject.mockImplementation(async (opts: Opts) => stubModel(opts));
});

afterEach(() => {
	vi.useRealTimers();
});

async function deliver(t: T, mail: typeof PITCH, id: string): Promise<Id<'mailMessages'>> {
	const rawStorageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['raw'])));
	const result = await t.mutation(internal.mail.delivery.deliverToMailbox, {
		rawStorageId,
		rawSize: 3,
		recipientAddress: OWNER,
		from: mail.from,
		to: [OWNER],
		cc: [],
		bcc: [],
		subject: mail.subject,
		textBodyInline: mail.text,
		snippet: mail.text,
		messageId: `<${id}@pitch.example>`,
		receivedAt: Date.now(),
		attachments: [],
	});
	if (!('messageId' in result)) throw new Error(`delivery of ${id} was skipped`);
	return result.messageId;
}

async function stateOf(t: T, messageId: Id<'mailMessages'>) {
	return await t.run(async (ctx) => {
		const message = (await ctx.db.get(messageId))!;
		const thread = (await ctx.db.get(message.threadId))!;
		const record = await ctx.db
			.query('mailArrivalRecords')
			.withIndex('by_message', (q) => q.eq('messageId', messageId))
			.first();
		const candidates = await readDigestCandidates(ctx, message.mailboxId);
		return { message, thread, record, candidates };
	});
}

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

/** The body fingerprint R2 reads a message with, and passes along with a yes. */
async function versionOf(t: T, id: Id<'mailMessages'>): Promise<string> {
	const version = await t.run(async (ctx) => sourceVersionOf(ctx, { kind: 'mail', id }));
	if (version === null) throw new Error('message is gone');
	return version;
}

/** The held-out state: digest, Cold outreach, no queue entry, still in the Inbox. */
async function expectHeldOut(t: T, messageId: Id<'mailMessages'>) {
	const state = await stateOf(t, messageId);
	expect(state.record?.coldPitchAt).toBeDefined();
	expect(state.thread.needsReply).toBeUndefined();
	expect(state.thread.arrival).toMatchObject({ placement: 'digest', isColdPitch: true });
	expect(state.thread.digestPendingSince).toBeDefined();
	expect(state.candidates).toEqual([
		expect.objectContaining({ threadId: state.thread._id, kind: 'cold_outreach' }),
	]);
	expect(await roleOf(t, messageId)).toBe('inbox');
	expect(state.thread.category?.label).not.toBe('spam');
	const queue = await t.query(api.mail.needsReply.listQueue, {
		mailboxId: state.message.mailboxId,
	});
	expect(queue.items.filter((item) => item.threadId === state.thread._id)).toEqual([]);
	return state;
}

describe('cold sales pitches at arrival (#1381)', () => {
	it('verdict first: digest, Cold outreach, no Reply Queue entry, never spam', async () => {
		const t = learnTest();
		await enableFeatures(t, ['ai', 'postbox', 'postbox.coldPitch']);
		await seedPersonalMailbox(t);
		const messageId = await deliver(t, PITCH, 'pitch');
		await drain(t);

		expect(coldPitchCalls()).toHaveLength(1);
		const state = await expectHeldOut(t, messageId);
		const why = await t.query(api.mail.arrival.explain.forThread, { threadId: state.thread._id });
		expect(why).toMatchObject({
			placement: 'digest',
			decidedBy: 'cold_pitch',
			isReplyNeeded: false,
		});

		// The sweep's re-run and a pending settle do not bring the flag back.
		await t.mutation(internal.mail.needsReply.requeue, { threadId: state.thread._id });
		await drain(t);
		await t.mutation(internal.mail.needsReplyPending.settlePending, { threadId: state.thread._id });
		await expectHeldOut(t, messageId);
	});

	it('verdict last: the reply flag already set for the pitch is cleared', async () => {
		const t = learnTest();
		await enableFeatures(t, ['ai', 'postbox']);
		await seedPersonalMailbox(t);
		const messageId = await deliver(t, PITCH, 'pitch');
		await drain(t);
		// Without the flag the question is never asked: the bug, a pitch in Needs you.
		expect(coldPitchCalls()).toHaveLength(0);
		const before = await stateOf(t, messageId);
		expect(before.thread.needsReply?.messageId).toBe(messageId);
		expect(before.thread.arrival?.placement).toBe('needs_me');

		await enableFeatures(t, ['ai', 'postbox', 'postbox.coldPitch']);
		await t.mutation(internal.mail.arrival.r2.commitArrivalAiAnswers, {
			messageId,
			answers: [],
			coldPitchSourceVersion: await versionOf(t, messageId),
		});
		const state = await expectHeldOut(t, messageId);

		await t.mutation(internal.mail.needsReply.requeue, { threadId: state.thread._id });
		await drain(t);
		await expectHeldOut(t, messageId);
	});

	it('never asks about a known sender, and a no keeps first contact in Needs you', async () => {
		const t = learnTest();
		await enableFeatures(t, ['ai', 'postbox', 'postbox.coldPitch']);
		const { mailboxId } = await seedPersonalMailbox(t);
		await t.run(async (ctx) => {
			await ctx.db.insert('mailContacts', {
				mailboxId,
				email: PITCHER,
				useCount: 1,
				lastUsedAt: Date.now(),
				createdAt: Date.now(),
			});
		});
		const known = await deliver(t, PITCH, 'known');
		await drain(t);
		expect(coldPitchCalls()).toHaveLength(0);
		expect((await stateOf(t, known)).thread.arrival?.placement).toBe('needs_me');

		verdict = 'no';
		const firstContact = await deliver(
			t,
			{
				from: 'Ana Ruiz <ana@practice.example>',
				subject: 'Website project for our practice',
				text: 'A colleague recommended your studio. Could we have a short call about a new website?',
			},
			'first-contact'
		);
		await drain(t);
		expect(coldPitchCalls()).toHaveLength(1);
		const state = await stateOf(t, firstContact);
		expect(state.record?.coldPitchAt).toBeUndefined();
		expect(state.thread.needsReply?.messageId).toBe(firstContact);
		expect(state.thread.arrival).toMatchObject({ placement: 'needs_me' });
		expect(state.thread.arrival?.isColdPitch).toBeUndefined();
	});

	it('a choice the owner makes about the sender later voids the verdict', async () => {
		const t = learnTest();
		await enableFeatures(t, ['ai', 'postbox', 'postbox.coldPitch']);
		await seedPersonalMailbox(t);
		const messageId = await deliver(t, PITCH, 'pitch');
		await drain(t);
		const held = await expectHeldOut(t, messageId);

		// The owner keeps the sender (Senders page): a status they set.
		await t.run(async (ctx) => {
			const profile = await senderProfileOf(ctx, held.message.mailboxId, PITCHER);
			await ctx.db.patch(profile!._id, { status: 'keep', statusSource: 'user' });
			await refreshArrivalProjection(ctx, held.thread._id);
		});
		const kept = await stateOf(t, messageId);
		expect(kept.thread.arrival?.isColdPitch).toBeUndefined();
		expect(kept.thread.arrival?.placement).toBe('today');
		await t.run(async (ctx) => {
			expect(await isHeldOutAsColdPitch(ctx, held.message)).toBe(false);
		});
	});

	it('an owner reply clears the verdict, and a stale yes cannot restore it', async () => {
		const t = learnTest();
		await enableFeatures(t, ['ai', 'postbox', 'postbox.coldPitch']);
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		const messageId = await deliver(t, PITCH, 'pitch');
		await drain(t);
		const held = await expectHeldOut(t, messageId);

		// The owner answers from another client: the Sent copy syncs in.
		await t.run(async (ctx) => {
			const now = Date.now();
			const { _id, _creationTime, ...pitch } = held.message;
			const sentId = await ctx.db.insert('mailMessages', {
				...pitch,
				folderId: folders.sent,
				fromAddress: OWNER,
				toAddresses: [PITCHER],
				receivedAt: now,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.patch(held.thread._id, { folderRoles: ['inbox', 'sent'] });
			await ctx.db.insert('mailContacts', {
				mailboxId,
				email: PITCHER,
				useCount: 1,
				lastUsedAt: now,
				createdAt: now,
			});
			await noteOwnerReply(ctx, (await ctx.db.get(sentId))!);
		});
		const cleared = await stateOf(t, messageId);
		expect(cleared.record?.coldPitchAt).toBeUndefined();
		expect(cleared.thread.arrival?.isColdPitch).toBeUndefined();
		expect(cleared.thread.arrival?.placement).not.toBe('digest');

		// A late R2 answer for the same message finds it no longer a candidate.
		await t.mutation(internal.mail.arrival.r2.commitArrivalAiAnswers, {
			messageId,
			answers: [],
			coldPitchSourceVersion: await versionOf(t, messageId),
		});
		expect((await stateOf(t, messageId)).record?.coldPitchAt).toBeUndefined();
	});
});

describe('relationship evidence and the fence (#1381)', () => {
	async function heldPitch(t: T) {
		await enableFeatures(t, ['ai', 'postbox', 'postbox.coldPitch']);
		const seeded = await seedPersonalMailbox(t);
		const messageId = await deliver(t, PITCH, 'pitch');
		await drain(t);
		return { ...seeded, messageId, held: await expectHeldOut(t, messageId) };
	}

	async function appendSent(t: T, folderId: Id<'mailFolders'>, id: string, subject: string) {
		const rawStorageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['raw'])));
		await t.mutation(internal.mail.imap.append.appendMessage, {
			folderId,
			rawStorageId,
			rawSize: 3,
			rfc822MessageId: `<${id}@owlat.test>`,
			fromAddress: OWNER,
			toAddresses: [PITCHER],
			ccAddresses: [],
			bccAddresses: [],
			subject,
			textBodyInline: 'Thanks for your help with the project.',
			flags: ['\\Seen'],
		});
		await drain(t);
	}

	/** The verdict no longer counts anywhere: record, projection, digest, queue veto. */
	async function expectReleased(t: T, messageId: Id<'mailMessages'>) {
		const state = await stateOf(t, messageId);
		expect(state.record?.coldPitchAt).toBeUndefined();
		expect(state.thread.arrival?.isColdPitch).toBeUndefined();
		expect(state.candidates).toEqual([]);
		await t.run(async (ctx) => {
			expect(await isHeldOutAsColdPitch(ctx, state.message)).toBe(false);
		});
		return state;
	}

	it('asks about a pitch whose category a heuristic settled, with no rule questions', async () => {
		const t = learnTest();
		await enableFeatures(t, ['ai', 'postbox', 'postbox.coldPitch']);
		await seedPersonalMailbox(t);
		const messageId = await deliver(
			t,
			{ ...PITCH, subject: 'Special offer: double organic traffic' },
			'heuristic'
		);
		await drain(t);
		expect(coldPitchCalls()).toHaveLength(1);
		const state = await expectHeldOut(t, messageId);
		expect(state.thread.category).toMatchObject({ label: 'promotion', source: 'heuristic' });
	});

	it('never asks about mail the Reply Queue screens out (a no-reply sender)', async () => {
		const t = learnTest();
		await enableFeatures(t, ['ai', 'postbox', 'postbox.coldPitch']);
		await seedPersonalMailbox(t);
		const messageId = await deliver(
			t,
			{ ...PITCH, from: 'Growth Leads <noreply@growthleads.example>' },
			'no-reply'
		);
		await drain(t);
		expect(coldPitchCalls()).toHaveLength(0);
		expect((await stateOf(t, messageId)).record?.coldPitchAt).toBeUndefined();
	});

	it('accepting the sender lets the pitch back into the Reply Queue', async () => {
		const t = learnTest();
		const { messageId, held } = await heldPitch(t);
		await t.mutation(api.mail.contacts.acceptSender, {
			mailboxId: held.message.mailboxId,
			email: PITCHER,
		});
		await expectReleased(t, messageId);

		await t.mutation(internal.mail.needsReply.requeue, { threadId: held.thread._id });
		await drain(t);
		const state = await stateOf(t, messageId);
		expect(state.thread.needsReply?.messageId).toBe(messageId);
		expect(state.thread.arrival?.placement).toBe('needs_me');
	});

	it('writing to the sender from another client, in another thread, clears the verdict', async () => {
		const t = learnTest();
		const { messageId, held, folders } = await heldPitch(t);
		await appendSent(t, folders.sent, 'elsewhere', 'Something else entirely');

		const state = await expectReleased(t, messageId);
		expect(state.thread.arrival?.placement).not.toBe('digest');
		const contact = await t.run(async (ctx) =>
			ctx.db
				.query('mailContacts')
				.withIndex('by_mailbox_and_email', (q) =>
					q.eq('mailboxId', held.message.mailboxId).eq('email', PITCHER)
				)
				.first()
		);
		expect(contact?.useCount).toBe(1);
	});

	it('never asks about a sender the owner wrote to before from another client', async () => {
		const t = learnTest();
		await enableFeatures(t, ['ai', 'postbox', 'postbox.coldPitch']);
		const { folders } = await seedPersonalMailbox(t);
		await appendSent(t, folders.sent, 'earlier', 'Earlier discussion with Jordan');

		const messageId = await deliver(t, PITCH, 'pitch');
		await drain(t);
		expect(coldPitchCalls()).toHaveLength(0);
		expect((await stateOf(t, messageId)).record?.coldPitchAt).toBeUndefined();
	});

	it('a fenced thread disregards its verdict until the fence is lifted', async () => {
		const t = learnTest();
		const { messageId, held } = await heldPitch(t);
		// What `signatureReverify.apply` does when a narrower scope fences the thread.
		await t.run(async (ctx) => {
			await fenceThreadInterpretation(ctx, held.thread._id);
			await refreshArrivalProjection(ctx, held.thread._id);
		});
		const fenced = await stateOf(t, messageId);
		expect(fenced.thread.arrival?.isColdPitch).toBeUndefined();
		expect(fenced.candidates).toEqual([]);
		await t.run(async (ctx) => {
			expect(await isHeldOutAsColdPitch(ctx, held.message)).toBe(false);
		});
		const why = await t.query(api.mail.arrival.explain.forThread, { threadId: held.thread._id });
		expect(why?.decidedBy).not.toBe('cold_pitch');

		await t.mutation(internal.mail.interpret.staleFence.release, { threadId: held.thread._id });
		await drain(t);
		expect((await stateOf(t, messageId)).thread.arrival).toMatchObject({
			placement: 'digest',
			isColdPitch: true,
		});
	});

	it('a late yes for a fenced thread is not committed', async () => {
		const t = learnTest();
		await enableFeatures(t, ['ai', 'postbox']);
		await seedPersonalMailbox(t);
		const messageId = await deliver(t, PITCH, 'pitch');
		await drain(t);
		const before = await stateOf(t, messageId);
		await t.run(async (ctx) => {
			await fenceThreadInterpretation(ctx, before.thread._id);
		});
		await enableFeatures(t, ['ai', 'postbox', 'postbox.coldPitch']);
		await t.mutation(internal.mail.arrival.r2.commitArrivalAiAnswers, {
			messageId,
			answers: [],
			coldPitchSourceVersion: await versionOf(t, messageId),
		});
		const state = await stateOf(t, messageId);
		expect(state.record?.coldPitchAt).toBeUndefined();
		expect(state.thread.needsReply?.messageId).toBe(messageId);
	});

	it('accepting a sender clears every verdict, past one batch', async () => {
		const t = learnTest();
		await enableFeatures(t, ['ai', 'postbox', 'postbox.coldPitch']);
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		const count = SENDER_CLEARS_RECORDS + 1;
		const seeded = await seedSenderThreads(t, mailboxId, folders.inbox, count, PITCHER);
		for (const id of seeded.messageIds) {
			const version = await versionOf(t, id);
			await t.run(async (ctx) => {
				expect(await commitColdPitchVerdict(ctx, id, version)).toBe(true);
			});
		}
		const digest = () => t.run(async (ctx) => readDigestCandidates(ctx, mailboxId));
		expect(await digest()).toHaveLength(count);

		await t.mutation(api.mail.contacts.acceptSender, { mailboxId, email: PITCHER });
		await drain(t);
		expect(await digest()).toEqual([]);
		const pitched = await t.run(async (ctx) =>
			ctx.db
				.query('mailArrivalRecords')
				.filter((q) => q.neq(q.field('coldPitchAt'), undefined))
				.collect()
		);
		expect(pitched).toEqual([]);
	});
});

describe('a re-verified signature that changes the read (#1381)', () => {
	/** A verdict the reader withholds (signed, no scope), as `signatureReverify` finds it. */
	const UNSCOPED = {
		isSigned: true as const,
		isSignatureValid: true,
		keySource: 'pinned' as const,
	};

	async function reverifyClearsigned(t: T, messageId: Id<'mailMessages'>) {
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, { inboundSignatureInfo: UNSCOPED });
		});
		await t.mutation(internal.mail.mailbox.signatureReverify.apply, {
			messageId,
			isReadChanged: true,
			info: { ...UNSCOPED, scope: 'clearsigned' },
		});
	}

	it('clears the verdict before any full interpretation of the message', async () => {
		const t = learnTest();
		await enableFeatures(t, ['ai', 'postbox', 'postbox.coldPitch']);
		await seedPersonalMailbox(t);
		const messageId = await deliver(t, PITCH, 'pitch');
		await t.mutation(internal.mail.arrival.r2.commitArrivalAiAnswers, {
			messageId,
			answers: [],
			coldPitchSourceVersion: await versionOf(t, messageId),
		});
		expect((await stateOf(t, messageId)).thread.arrival?.isColdPitch).toBe(true);

		await reverifyClearsigned(t, messageId);
		const state = await stateOf(t, messageId);
		expect(state.thread.interpretationStaleSince).toBeUndefined();
		expect(state.record?.coldPitchAt).toBeUndefined();
		expect(state.thread.arrival?.isColdPitch).toBeUndefined();
		expect(state.candidates).toEqual([]);
		await t.run(async (ctx) => {
			expect(await isHeldOutAsColdPitch(ctx, state.message)).toBe(false);
		});
		await drain(t);
	});

	it('refuses a yes read before the signature narrowed the body', async () => {
		const t = learnTest();
		await enableFeatures(t, ['ai', 'postbox', 'postbox.coldPitch']);
		await seedPersonalMailbox(t);
		const messageId = await deliver(t, PITCH, 'pitch');
		const readBefore = await versionOf(t, messageId);

		await reverifyClearsigned(t, messageId);
		const readAfter = await versionOf(t, messageId);
		expect(readAfter).not.toBe(readBefore);
		await t.mutation(internal.mail.arrival.r2.commitArrivalAiAnswers, {
			messageId,
			answers: [],
			coldPitchSourceVersion: readBefore,
		});
		expect((await stateOf(t, messageId)).record?.coldPitchAt).toBeUndefined();

		// The same yes, read from the body as it reads now, commits.
		await t.mutation(internal.mail.arrival.r2.commitArrivalAiAnswers, {
			messageId,
			answers: [],
			coldPitchSourceVersion: readAfter,
		});
		expect((await stateOf(t, messageId)).record?.coldPitchAt).toBeDefined();
		await drain(t);
	});
});
