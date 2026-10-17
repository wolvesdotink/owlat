/**
 * Read on arrival, end to end across the lanes (SPEC §9, the wiring gate).
 *
 * One personal mailbox, three live hosted deliveries, every scheduled job run
 * with a stubbed model:
 *
 *   - a newsletter the owner subscribed to is counted and placed `digest`
 *     (a bulk stranger's is not read at all, depth row 1, and placed the
 *     same), a notification gets a verbatim gist and is placed `updates`, a
 *     question from a person gets the full read and lands `needs_me` once its
 *     reply verdict settles;
 *   - Explain names what decided the place and how much was read;
 *   - Fix moves the newsletter's sender to Updates, and Undo restores the
 *     digest;
 *   - a plain-language rule with an AI condition applies at R2, logged as a
 *     `rule_apply` operation;
 *   - the Daily Brief carries the digest thread, and a second delivery pass
 *     sends nothing more.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import { enableFeatures } from '../../../__tests__/factories';
import { categoryRefinementSchema } from '../../ai/categoryClassify';
import { briefModelSchema } from '../../interpret/schema';
import { gistOutputSchema } from '../../interpret/gist';
import { digestOutputSchema } from '../../digest/generate';
import { localMinuteOfDay } from '../../briefEmail';
import {
	OWNER,
	seedFilter,
	seedLabel,
	seedPersonalMailbox,
} from '../../rules/__tests__/rules.testlib';
import { learnTest, type T } from './learn.testlib';

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

const NOW = Date.UTC(2026, 9, 19, 7, 0);

const SUBSCRIBED = {
	from: 'Book Club <letters@club.example>',
	subject: 'October picks',
	text: 'Three new novels for October. Our autumn collection is here.',
	unsubscribe: { httpUrl: 'https://club.example/unsubscribe', oneClick: true },
};
const NEWSLETTER = {
	from: 'Shop Weekly <news@shop.example>',
	subject: 'This week at the shop',
	text: 'Our autumn collection is here. Twenty new jackets arrived this week.',
	unsubscribe: { httpUrl: 'https://shop.example/unsubscribe', oneClick: true },
};
const NOTICE = {
	from: 'Parcel Service <no-reply@parcel.example>',
	subject: 'Your parcel was delivered',
	text: 'Your parcel was delivered to the front door at 10:42. Thanks for shopping with us.',
};
const QUESTION = {
	from: 'Alice Example <alice@example.com>',
	subject: 'Contract',
	text: 'Could you send me the signed contract by Friday?',
};

type Opts = { schema: unknown; prompt?: string };
const answer = (object: unknown) => ({ object, tokenUsage: undefined, modelUsed: 'stub-model' });
const shapeOf = (schema: unknown) => (schema as { shape?: Record<string, unknown> }).shape ?? {};
const callsFor = (schema: unknown) =>
	llm.runLlmObject.mock.calls.filter(([opts]) => (opts as Opts).schema === schema);

function extraction(prompt: string) {
	const isQuestion = prompt.includes('signed contract');
	return {
		mode: 'brief',
		items: [],
		transitions: [],
		replyIntent: isQuestion ? 'direct_question' : 'informational_update',
		urgency: 'normal',
		meetingIntent: null,
		coverage: { segmentsRead: ['s0'], uncertain: false, overflow: false },
		latest: { en: [], de: [] },
		facts: [],
		exactWording: { isRequired: false, reason: null },
	};
}

/** The stubbed model: every model path the story reaches, keyed by its output schema. */
function stubModel({ schema, prompt = '' }: Opts) {
	if (schema === categoryRefinementSchema) return answer({ category: 'person' });
	if (schema === briefModelSchema) return answer(extraction(prompt));
	if (schema === gistOutputSchema) {
		return answer({
			spans: [{ segment: 's0', quote: 'Your parcel was delivered to the front door at 10:42.' }],
		});
	}
	if (schema === digestOutputSchema) {
		const refs = [...prompt.matchAll(/ref="(\d+)"/g)].map((m) => Number(m[1]));
		return answer({
			lines: refs.map((ref) => ({
				ref,
				spans: [{ segment: 's0', quote: 'Our autumn collection is here.' }],
			})),
		});
	}
	if ('answers' in shapeOf(schema)) {
		// R2: the category (when asked) and this message's rule question, answered yes.
		return answer({
			...('category' in shapeOf(schema) ? { category: 'notification' } : {}),
			answers: [{ question: 1, answer: 'yes' }],
		});
	}
	// The verification pass and anything else: nothing to add.
	return answer({ verdicts: [] });
}

beforeEach(() => {
	vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
	llm.runLlmObject.mockReset();
	llm.runLlmObject.mockImplementation(async (opts: Opts) => stubModel(opts));
});

afterEach(() => {
	vi.useRealTimers();
});

async function deliver(
	t: T,
	mail: {
		from: string;
		subject: string;
		text: string;
		unsubscribe?: Doc<'mailMessages'>['unsubscribe'];
	},
	id: string
): Promise<Id<'mailMessages'>> {
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
		messageId: `<${id}@story.example>`,
		receivedAt: Date.now(),
		attachments: [],
		...(mail.unsubscribe ? { unsubscribe: mail.unsubscribe } : {}),
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
		const brief = await ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', thread._id))
			.unique();
		return { message, thread, record, brief };
	});
}

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

describe('read on arrival, the main story', () => {
	it('reads, places, explains, fixes, undoes, applies a rule at R2 and sends the digest once', async () => {
		const t = learnTest();
		await enableFeatures(t, ['ai', 'postbox']);
		const { mailboxId } = await seedPersonalMailbox(t);
		const deliveries = await seedLabel(t, mailboxId, 'Deliveries');
		const ruleId = await seedFilter(t, mailboxId, {
			name: 'Deliveries',
			conditions: [{ field: 'from', op: 'contains', value: 'parcel.example' }],
			aiCondition: { question: 'Is this about a parcel delivery?', revision: 0 },
			actions: [{ type: 'addLabel', labelId: deliveries }],
			sourceText: 'Label parcel deliveries',
		});

		// The owner has written to the book club before: its newsletter is eligible.
		await t.run(async (ctx) => {
			await ctx.db.insert('mailContacts', {
				mailboxId,
				email: 'letters@club.example',
				useCount: 1,
				lastUsedAt: Date.now(),
				createdAt: Date.now(),
			});
		});

		const subscribedId = await deliver(t, SUBSCRIBED, 'subscribed');
		const newsletterId = await deliver(t, NEWSLETTER, 'newsletter');
		const noticeId = await deliver(t, NOTICE, 'notice');
		const questionId = await deliver(t, QUESTION, 'question');
		await drain(t);

		// 1. Depth and placement per kind of mail.
		const subscribed = await stateOf(t, subscribedId);
		expect(subscribed.record).toMatchObject({ depth: 'count', modelCalls: 0 });
		expect(subscribed.thread.arrival).toMatchObject({ placement: 'digest', depth: 'count' });
		expect(subscribed.thread.digestPendingSince).toBeDefined();
		expect(subscribed.brief?.skippedSources).toBe(1);

		const newsletter = await stateOf(t, newsletterId);
		// A bulk newsletter from a stranger is never read (depth row 1), and is placed by its kind.
		expect(newsletter.record).toMatchObject({ depth: 'none', modelCalls: 0 });
		expect(newsletter.record?.reasonKeys).toEqual([{ key: 'arrival.reason.ineligible' }]);
		expect(newsletter.thread.arrival).toMatchObject({ placement: 'digest', depth: 'none' });
		expect(newsletter.thread.digestPendingSince).toBeDefined();

		const notice = await stateOf(t, noticeId);
		expect(notice.record?.depth).toBe('gist');
		expect(notice.thread.arrival?.placement).toBe('updates');
		expect(notice.brief?.gist).toBeDefined();
		expect(notice.brief?.gistSources).toBe(1);

		const question = await stateOf(t, questionId);
		expect(question.record?.depth).toBe('full');
		expect(question.thread.needsReply).toBeDefined();
		expect(question.thread.arrival?.placement).toBe('needs_me');

		// Neither newsletter reached a model; the gist and the full read did.
		expect(callsFor(gistOutputSchema)).toHaveLength(1);
		expect(callsFor(digestOutputSchema)).toHaveLength(0);

		// 2. Explain gives the reason.
		const whyCounted = await t.query(api.mail.arrival.explain.forThread, {
			threadId: subscribed.thread._id,
		});
		expect(whyCounted).toMatchObject({
			placement: 'digest',
			decidedBy: 'category',
			depth: 'count',
			modelCalls: 0,
			sender: { address: 'letters@club.example', status: 'keep', delivered: 1 },
		});
		expect(whyCounted!.reasons.map((reason) => reason.key)).toContain('arrival.reason.category');
		const why = await t.query(api.mail.arrival.explain.forThread, {
			threadId: newsletter.thread._id,
		});
		expect(why).toMatchObject({
			placement: 'digest',
			decidedBy: 'category',
			category: { label: 'newsletter', source: 'heuristic' },
			depth: 'none',
			modelCalls: 0,
		});
		expect(why!.reasons).toEqual([{ key: 'arrival.reason.ineligible' }]);

		// 3. Fix moves the newsletter's sender to Updates; Undo restores the digest.
		const fix = await t.mutation(api.mail.arrival.fix.apply, {
			messageId: subscribedId,
			destination: 'updates',
			scope: 'sender',
		});
		expect(fix.operationId).not.toBeNull();
		await drain(t);
		const fixed = await stateOf(t, subscribedId);
		expect(fixed.thread.arrival?.placement).toBe('updates');
		expect(fixed.thread.digestPendingSince).toBeUndefined();

		const undone = await t.mutation(api.mail.arrival.operations.undo, {
			operationId: fix.operationId!,
		});
		expect(undone.status).toBe('undone');
		await drain(t);
		const restored = await stateOf(t, subscribedId);
		expect(restored.thread.arrival?.placement).toBe('digest');
		expect(restored.thread.digestPendingSince).toBeDefined();
		// The other sender's newsletter never moved.
		expect((await stateOf(t, newsletterId)).thread.arrival?.placement).toBe('digest');

		// 4. The AI rule applied at R2: the label is on, logged as one rule_apply.
		expect(notice.message.labelIds).toContain(deliveries);
		expect(notice.record?.filterMatches).toEqual([
			expect.objectContaining({ filterId: ruleId, pass: 'ai', answer: true }),
		]);
		const ruleOps = await t.run(
			async (ctx) =>
				await ctx.db
					.query('mailArrivalOperations')
					.withIndex('by_mailbox_created', (q) => q.eq('mailboxId', mailboxId))
					.collect()
		);
		expect(ruleOps.filter((op) => op.kind === 'rule_apply')).toEqual([
			expect.objectContaining({ messageId: noticeId, filterId: ruleId, actor: 'rule' }),
		]);
		// No other mail got the rule's label.
		expect(subscribed.message.labelIds).not.toContain(deliveries);
		expect(newsletter.message.labelIds).not.toContain(deliveries);
		expect(question.message.labelIds).not.toContain(deliveries);

		// 5. The digest picks both newsletter threads up and is delivered once.
		await t.run(async (ctx) => {
			await ctx.db.insert('mailUserSettings', {
				userId: 'user-A',
				autoAdvance: 'next',
				dailyBriefEmail: {
					enabled: true,
					minute: localMinuteOfDay(Date.now(), 0),
					utcOffsetMinutes: 0,
				},
				createdAt: 1,
				updatedAt: 1,
			});
		});
		const first = await t.action(internal.mail.briefEmailActions.deliverDueBriefs, {});
		expect(first.delivered).toBe(1);
		expect(callsFor(digestOutputSchema)).toHaveLength(1);

		const digests = await t.run(
			async (ctx) =>
				await ctx.db
					.query('mailDigests')
					.withIndex('by_mailbox_period', (q) => q.eq('mailboxId', mailboxId))
					.collect()
		);
		expect(digests).toHaveLength(1);
		expect(digests[0]).toMatchObject({ state: 'sent', items: [] });
		expect(digests[0]!.visited.map((visit) => visit.threadId).sort()).toEqual(
			[subscribed.thread._id, newsletter.thread._id].sort()
		);
		for (const id of [subscribedId, newsletterId]) {
			const consumed = await stateOf(t, id);
			expect(consumed.thread.digestPendingSince).toBeUndefined();
			expect(consumed.thread.digestConsumedThrough).toBe(consumed.thread.arrival?.sourceOrderKey);
		}
		// The notification and the question were never digest threads.
		expect((await stateOf(t, noticeId)).thread.digestPendingSince).toBeUndefined();
		expect((await stateOf(t, questionId)).thread.digestPendingSince).toBeUndefined();

		const second = await t.action(internal.mail.briefEmailActions.deliverDueBriefs, {});
		expect(second.delivered).toBe(0);
		expect(callsFor(digestOutputSchema)).toHaveLength(1);
	});
});
