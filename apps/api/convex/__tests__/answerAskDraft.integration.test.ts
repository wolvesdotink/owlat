/**
 * Answer mode "Draft with AI that asks first" (mail/ai/composeDraft.ts), the
 * question flow: no gaps drafts at once, gaps ask first with memory pre-picks,
 * credential questions never reach the owner, skipping leaves placeholders,
 * "It isn't ready yet" opens round 2 and a follow-up, the eagerness dial `off`
 * drafts with gaps, sessions are private to their owner, and a team thread
 * drafts from the pipeline briefing. The model, provider, file search and the
 * team briefing are mocked; convex-test runs the real queries and mutations.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	enableFeatures,
	createTestContact,
	createTestConversationThread,
	createTestInboundMessage,
} from './factories';
import { normalizeQuestionKey } from '../inbox/clarificationMemoryMatch';
import { deleteAskSessionsOfOwner } from '../mail/ai/composeDraftStore';
import { runLlmObject, runLlmStream, runLlmText } from '../lib/llm/dispatch';
import { assembleInboundBriefing } from '../agent/steps/context_retrieval';
import { NOT_READY_OPTION } from '../inbox/clarificationAnswers';
import { INTERPRET_EXTRACTOR_VERSION } from '../mail/interpret/schema';
import { CUSTOMER, ORG, seedCustomer, seedFile, seedRequest } from './helpers/answerAsk';

import type * as SessionOrganizationModule from '../lib/sessionOrganization';
import type * as LlmProviderModule from '../lib/llmProvider';
import type * as TaskRoutingModule from '../lib/llm/taskRouting';
import type * as DispatchModule from '../lib/llm/dispatch';
import type * as AttachmentSuggestModule from '../inbox/attachmentSuggest';

type FoundFile = AttachmentSuggestModule.FoundFile;
import type * as ContextRetrievalModule from '../agent/steps/context_retrieval';
import type * as ComposeDraftPlanModule from '../mail/ai/composeDraftPlan';

const modules = import.meta.glob('../**/*.*s');

const sess = vi.hoisted(() => ({
	user: { userId: 'user-a', role: 'member' as 'member' | 'owner', activeOrganizationId: 'org-a' },
}));
const llm = vi.hoisted(() => ({
	slots: [] as Array<{
		slotType: string;
		question: string;
		answerableFromContext: boolean;
		decisionRelevant: boolean;
		options: string[];
	}>,
	draft: 'Hi Jonas,\n\nthanks for your note.\n\nBest,\nAda',
	files: [] as FoundFile[],
	// The late injection guard's verdict (D13), for a message whose scan skipped it.
	guard: { isInjection: false, confidence: 0.02, reason: 'benign' },
	// A failure before the draft opens its stream (the response plan's load).
	planFailure: null as Error | null,
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganizationModule>(
		'../lib/sessionOrganization'
	);
	return {
		...actual,
		requireOrgMember: vi.fn(async () => sess.user),
		isActiveOrgMember: vi.fn(async () => true),
		getUserIdFromSession: vi.fn(async () => sess.user.userId),
		getMutationContext: vi.fn(async () => sess.user),
		getBetterAuthSessionWithRole: vi.fn(async () => ({ ...sess.user })),
	};
});
vi.mock('../lib/llmProvider', async () => {
	const actual = await vi.importActual<typeof LlmProviderModule>('../lib/llmProvider');
	const { taskTier } = await vi.importActual<typeof TaskRoutingModule>('../lib/llm/taskRouting');
	// The tier is the model name, so a test can tell which tier a call used.
	return {
		...actual,
		resolveLanguageModel: vi.fn((_ctx: unknown, ...route: Parameters<typeof taskTier>) =>
			taskTier(...route)
		),
	};
});
vi.mock('../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<typeof DispatchModule>('../lib/llm/dispatch');
	const result = { tokenUsage: undefined, modelUsed: 'test-model' };
	return {
		...actual,
		runLlmObject: vi.fn(async (opts: { prompt?: string }) => {
			const prompt = String(opts.prompt ?? '');
			if (prompt.includes('security classifier')) return { object: llm.guard, ...result };
			if (prompt.includes('Identify the SLOTS')) return { object: { slots: llm.slots }, ...result };
			if (prompt.includes('DISAGREE')) {
				return { object: { divergentSlotIndexes: llm.slots.map((_, i) => i) }, ...result };
			}
			return { object: { translations: [] }, ...result };
		}),
		runLlmText: vi.fn(async () => ({ text: 'A candidate reply.', ...result })),
		runLlmStream: vi.fn(),
	};
});
vi.mock('../inbox/attachmentSuggest', async () => {
	const actual = await vi.importActual<typeof AttachmentSuggestModule>(
		'../inbox/attachmentSuggest'
	);
	return { ...actual, searchFilesForRequest: vi.fn(async () => llm.files) };
});
vi.mock('../mail/ai/composeDraftPlan', async () => {
	const actual = await vi.importActual<typeof ComposeDraftPlanModule>(
		'../mail/ai/composeDraftPlan'
	);
	return {
		...actual,
		loadAnswerPlan: vi.fn(async (...args: Parameters<typeof actual.loadAnswerPlan>) => {
			if (llm.planFailure) throw llm.planFailure;
			return actual.loadAnswerPlan(...args);
		}),
	};
});
vi.mock('../agent/steps/context_retrieval', async () => {
	const actual = await vi.importActual<typeof ContextRetrievalModule>(
		'../agent/steps/context_retrieval'
	);
	return {
		...actual,
		assembleInboundBriefing: vi.fn(async () => ({
			context: '[CURRENT MESSAGE] Jonas asks for the September invoice.',
			tier: 'normal',
			estimatedTokens: 10,
			coverage: {
				contact: true,
				thread: false,
				knowledge: false,
				files: false,
				knowledgeHitCount: 0,
				lowCoverage: true,
			},
			groundingSources: [],
		})),
	};
});

function slot(slotType: string, question: string, options: string[] = []) {
	return { slotType, question, answerableFromContext: false, decisionRelevant: true, options };
}

async function makeT() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['mail.external', 'ai']);
	return t;
}

type Tx = Awaited<ReturnType<typeof makeT>>;

async function replyDraft(t: Tx, text?: string) {
	const { mailboxId, messageId } = await seedRequest(t, text ? { text } : {});
	const { draftId } = await t.mutation(api.mail.drafts.create, {
		mailboxId,
		inReplyToMessageId: messageId,
	});
	return { mailboxId, messageId, draftId, target: { kind: 'mailDraft' as const, draftId } };
}

/** The messages the drafter sent to the model, flattened. */
function lastDraftPrompt(): string {
	const calls = vi.mocked(runLlmStream).mock.calls;
	return JSON.stringify(calls[calls.length - 1]![0].messages);
}

async function streamText(t: Tx, streamId: Id<'aiDraftStreams'> | undefined) {
	expect(streamId).toBeDefined();
	return (await t.query(api.mail.draftStreamStore.getDraftStream, { streamId: streamId! }))?.text;
}

beforeEach(() => {
	sess.user = { userId: 'user-a', role: 'member', activeOrganizationId: ORG };
	llm.slots = [];
	llm.files = [];
	llm.draft = 'Hi Jonas,\n\nthanks for your note.\n\nBest,\nAda';
	llm.guard = { isInjection: false, confidence: 0.02, reason: 'benign' };
	llm.planFailure = null;
	vi.mocked(runLlmStream).mockReset();
	vi.mocked(runLlmText).mockClear();
	vi.mocked(assembleInboundBriefing).mockClear();
	vi.mocked(runLlmStream).mockImplementation(async (opts) => {
		await opts.onTextDelta?.(llm.draft, llm.draft);
		return {
			text: llm.draft,
			tokenUsage: undefined,
			modelUsed: 'test-model',
			finishReason: 'stop',
			aborted: false,
		};
	});
});

describe('start', () => {
	it('drafts right away when nothing is missing, with the instruction as trusted input', async () => {
		const t = await makeT();
		const { target } = await replyDraft(t, 'Thanks for the call today, talk soon.');

		const res = await t.action(api.mail.ai.composeDraft.start, {
			target,
			instruction: 'Say we will call on Monday',
			locale: 'en',
		});

		expect(res.status).toBe('ready');
		expect(res.questions).toEqual([]);
		expect(await streamText(t, res.streamId)).toBe(llm.draft);
		const prompt = lastDraftPrompt();
		expect(prompt).toContain('[CONFIRMED BY OWNER]');
		expect(prompt).toContain("in the owner's words: Say we will call on Monday");
		expect(prompt).toContain('<untrusted_email_content>');
		const session = await t.query(api.mail.ai.composeDraftStore.getSession, { target });
		expect(session?.status).toBe('ready');
	});

	it('asks first, pre-picking what answer memory holds for this contact', async () => {
		const t = await makeT();
		const contactId = await seedCustomer(t);
		const remembered = 'Is PO BP-2231 already printed on the invoice?';
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('clarificationMemory', {
				contactId,
				slotType: 'decision',
				questionKey: normalizeQuestionKey('decision', remembered),
				questionText: remembered,
				answerValue: 'Yes',
				source: 'reply_queue',
				answerCount: 1,
				useCount: 0,
				createdAt: now,
				updatedAt: now,
			});
		});
		llm.slots = [
			slot('decision', remembered, ['Yes', 'No']),
			slot('date_time', 'When will payment arrive?'),
		];
		const { target } = await replyDraft(t);

		const res = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });

		expect(res.status).toBe('asking');
		expect(res.round).toBe(1);
		expect(vi.mocked(runLlmStream)).not.toHaveBeenCalled();
		const [file, po, payment] = res.questions;
		expect(file).toMatchObject({
			id: 'file_request',
			answerKind: 'file',
			options: [NOT_READY_OPTION],
		});
		// No legacy English sentence on new questions (#1186).
		expect(file).not.toHaveProperty('attribution');
		// The stored session carries the structured provenance the web words.
		expect(file!.origin).toEqual({ kind: 'email', senderDomain: 'example.org' });
		expect(po!.origin).toEqual(file!.origin);
		expect(po).toMatchObject({ answerKind: 'choice', answer: { value: 'Yes', source: 'memory' } });
		expect(payment).toMatchObject({ answerKind: 'date' });
		expect(payment!.answer).toBeUndefined();
	});

	it('never asks a question that fishes for a credential', async () => {
		const t = await makeT();
		llm.slots = [slot('factual_lookup', 'What is the account password for the portal?')];
		const { target } = await replyDraft(t, 'Can we meet next week to go over the portal?');

		const res = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });

		expect(res.questions).toEqual([]);
		expect(res.status).toBe('ready');
	});

	it('drafts with gaps and never asks when the eagerness dial is off', async () => {
		const t = await makeT();
		await t.run(async (ctx) => {
			await ctx.db.insert('askEagernessSettings', { mode: 'off', updatedAt: Date.now() });
		});
		llm.slots = [slot('date_time', 'When will payment arrive?')];
		const { target } = await replyDraft(t);

		const res = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });

		expect(res.status).toBe('ready');
		const text = await streamText(t, res.streamId);
		expect(text).toContain('[[attach invoice for september]]');
		expect(text).toContain('[[When will payment arrive]]');
	});

	it('replaces the caller’s previous session on the same draft', async () => {
		const t = await makeT();
		const { target } = await replyDraft(t, 'Thanks for the call today, talk soon.');
		const first = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });
		const second = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });
		expect(second.sessionId).not.toBe(first.sessionId);
		const rows = await t.run(async (ctx) => await ctx.db.query('answerAskSessions').collect());
		expect(rows.map((r) => r._id)).toEqual([second.sessionId]);
		// The first session's stream went with it.
		expect(await t.run(async (ctx) => await ctx.db.get(first.streamId!))).toBeNull();
	});
});

describe('answer', () => {
	it('skip drafts at once with a placeholder for every open question', async () => {
		const t = await makeT();
		llm.slots = [slot('date_time', 'When will payment arrive?')];
		const { target } = await replyDraft(t);
		const asked = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });
		expect(asked.status).toBe('asking');

		const res = await t.action(api.mail.ai.composeDraft.answer, {
			sessionId: asked.sessionId,
			answers: [],
			skip: true,
		});

		expect(res.status).toBe('ready');
		const text = await streamText(t, res.streamId);
		expect(text).toContain('[[attach invoice for september]]');
		expect(text).toContain('[[When will payment arrive]]');
		expect(lastDraftPrompt()).toContain('write its placeholder exactly as given');
	});

	it('"It isn\'t ready yet" opens round 2, then promises the date and arms the follow-up', async () => {
		const t = await makeT();
		await seedCustomer(t);
		const { target, draftId } = await replyDraft(t);
		const asked = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });

		const round2 = await t.action(api.mail.ai.composeDraft.answer, {
			sessionId: asked.sessionId,
			answers: [{ questionId: 'file_request', value: NOT_READY_OPTION }],
		});
		expect(round2.status).toBe('asking');
		expect(round2.round).toBe(2);
		const followUp = round2.questions.find((q) => q.id === 'follow_up_date');
		expect(followUp).toMatchObject({
			answerKind: 'date',
			options: ['Tomorrow', expect.any(String)],
		});
		expect(vi.mocked(runLlmStream)).not.toHaveBeenCalled();

		const res = await t.action(api.mail.ai.composeDraft.answer, {
			sessionId: asked.sessionId,
			answers: [{ questionId: 'follow_up_date', value: 'Tomorrow' }],
		});
		expect(res.status).toBe('ready');
		expect(res.followUpAt).toBeGreaterThan(Date.now());
		const draft = await t.run(async (ctx) => await ctx.db.get(draftId));
		expect(draft?.followUpRemindAt).toBe(res.followUpAt);
		const prompt = lastDraftPrompt();
		expect(prompt).toContain('is not ready yet');
		expect(prompt).toContain('promise to send it by: Tomorrow');
		// The one-off date is not remembered as a standing answer.
		const memory = await t.run(async (ctx) => await ctx.db.query('clarificationMemory').collect());
		expect(memory).toEqual([]);
	});

	it("names the promised day on the owner's calendar, at 09:00 their time", async () => {
		const t = await makeT();
		await seedCustomer(t);
		const { target } = await replyDraft(t);
		const asked = await t.action(api.mail.ai.composeDraft.start, {
			target,
			locale: 'en',
			timeZone: 'Pacific/Auckland',
		});
		await t.action(api.mail.ai.composeDraft.answer, {
			sessionId: asked.sessionId,
			answers: [{ questionId: 'file_request', value: NOT_READY_OPTION }],
		});
		const res = await t.action(api.mail.ai.composeDraft.answer, {
			sessionId: asked.sessionId,
			answers: [{ questionId: 'follow_up_date', value: 'Tomorrow' }],
		});
		const hour = new Intl.DateTimeFormat('en-US', {
			timeZone: 'Pacific/Auckland',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		}).format(res.followUpAt!);
		expect(hour).toBe('09:00');
	});

	it('drafts from the context start built, without building it again', async () => {
		const t = await makeT();
		llm.slots = [slot('date_time', 'When will payment arrive?')];
		const { target, messageId } = await replyDraft(t);
		const asked = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });
		// Were the context rebuilt, the drafter would read the edited body.
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, { textBodyInline: 'Edited after the questions were asked.' });
		});

		await t.action(api.mail.ai.composeDraft.answer, {
			sessionId: asked.sessionId,
			answers: [{ questionId: asked.questions[0]!.id, value: 'Friday' }],
		});
		const prompt = lastDraftPrompt();
		expect(prompt).toContain('Our books close on Friday');
		expect(prompt).not.toContain('Edited after the questions were asked');
	});

	it('samples candidate replies on the cheap tier unless the dial is cautious', async () => {
		const t = await makeT();
		llm.slots = [slot('date_time', 'When will payment arrive?')];
		const { target } = await replyDraft(t);
		await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });
		const tiers = () => vi.mocked(runLlmText).mock.calls.map(([opts]) => opts.model);
		expect(tiers()).toEqual(['fast', 'fast', 'fast']);

		vi.mocked(runLlmText).mockClear();
		await t.run(async (ctx) => {
			await ctx.db.insert('askEagernessSettings', { mode: 'cautious', updatedAt: Date.now() });
		});
		await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });
		expect(tiers()).toEqual(['capable', 'capable', 'capable']);
	});

	it('remembers a typed answer for the contact', async () => {
		const t = await makeT();
		const contactId = await seedCustomer(t);
		llm.slots = [slot('decision', 'Should the PO number go on the invoice?', ['Yes', 'No'])];
		const { target } = await replyDraft(t);
		const asked = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });
		const po = asked.questions.find((q) => q.slotType === 'decision')!;

		await t.action(api.mail.ai.composeDraft.answer, {
			sessionId: asked.sessionId,
			answers: [{ questionId: po.id, value: 'No' }],
		});

		const memory = await t.run(async (ctx) => await ctx.db.query('clarificationMemory').collect());
		expect(memory).toEqual([
			expect.objectContaining({ contactId, answerValue: 'No', slotType: 'decision' }),
		]);
		expect(lastDraftPrompt()).toContain('Should the PO number go on the invoice? No');
	});
});

describe('the legacy attribution sentence (#1224, #1265)', () => {
	const LEGACY =
		'Generated from an email from example.org — Owlat will never ask for your password.';

	it('is rejected on questions written back to a session', async () => {
		// 0.6.11 accepted `attribution` in these arguments for one release, so a
		// 0.6.10 `answer` action still in flight could finish. No supported caller
		// sends it any more: the arguments are the stored shape again.
		const t = await makeT();
		llm.slots = [slot('date_time', 'When will payment arrive?')];
		const { target } = await replyDraft(t);
		const asked = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });
		const stored = await t.run(async (ctx) => (await ctx.db.get(asked.sessionId))!.questions);
		const held = stored.map((q) => ({ ...q, attribution: LEGACY }));

		await expect(
			t.mutation(internal.mail.ai.composeDraftStore.updateSession, {
				sessionId: asked.sessionId,
				status: 'asking',
				questions: held,
			})
		).rejects.toThrow(/attribution/);
		await expect(
			t.mutation(internal.mail.ai.composeDraftStore.replaceSession, {
				target,
				locale: 'en',
				status: 'asking',
				questions: held,
				attachedFiles: [],
			})
		).rejects.toThrow(/attribution/);

		const session = await t.run(async (ctx) => await ctx.db.get(asked.sessionId));
		expect(session?.questions).toEqual(stored);
	});
});

describe('privacy', () => {
	it('a session belongs to the person who started it', async () => {
		const t = await makeT();
		const { target } = await replyDraft(t);
		const asked = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });
		expect(await t.query(api.mail.ai.composeDraftStore.getSession, { target })).not.toBeNull();

		sess.user = { userId: 'user-b', role: 'member', activeOrganizationId: ORG };
		expect(await t.query(api.mail.ai.composeDraftStore.getSession, { target })).toBeNull();
		await expect(
			t.action(api.mail.ai.composeDraft.answer, {
				sessionId: asked.sessionId,
				answers: [],
				skip: true,
			})
		).rejects.toMatchObject({ data: { category: 'forbidden' } });
		await expect(
			t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' })
		).rejects.toMatchObject({ data: { category: 'forbidden' } });
	});
});

describe('team thread', () => {
	async function seedTeamThread(
		t: Tx,
		contactId: Id<'contacts'>,
		message: Record<string, unknown> = {}
	) {
		await enableFeatures(t, ['inbox']);
		return await t.run(async (ctx) => {
			const { updatedAt: _unused, ...thread } = createTestConversationThread({
				contactId,
				contactIdentifier: CUSTOMER,
			});
			const threadId = await ctx.db.insert('conversationThreads', thread);
			await ctx.db.insert(
				'inboundMessages',
				createTestInboundMessage({
					threadId,
					contactId,
					from: CUSTOMER,
					subject: 'September invoice',
					textBody: 'Could you send us the invoice for September?',
					...message,
				})
			);
			return threadId;
		});
	}

	it('drafts from the pipeline briefing and reports a matched file for the web to attach', async () => {
		const t = await makeT();
		sess.user = { userId: 'admin-1', role: 'owner', activeOrganizationId: ORG };
		const contactId = await seedCustomer(t);
		const threadId = await seedTeamThread(t, contactId);
		const fileId = await seedFile(t, { filename: 'invoice-2026-09.pdf', contactIds: [contactId] });
		llm.files = [
			{
				source: 'semanticFile',
				id: fileId,
				filename: 'invoice-2026-09.pdf',
				mimeType: 'application/pdf',
				size: 20,
				score: 0.8,
			},
		];
		const target = { kind: 'teamThread' as const, threadId };

		const res = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });

		expect(res.status).toBe('ready');
		expect(res.attachedFiles).toEqual([
			{ source: 'semanticFile', id: fileId, filename: 'invoice-2026-09.pdf' },
		]);
		const prompt = lastDraftPrompt();
		expect(prompt).toContain('Jonas asks for the September invoice');
		expect(prompt).toContain('mention them naturally: invoice-2026-09.pdf');
	});

	it('keeps one inbound message’s session out of another message’s composer (review r3 F2)', async () => {
		const t = await makeT();
		sess.user = { userId: 'admin-1', role: 'owner', activeOrganizationId: ORG };
		const contactId = await seedCustomer(t);
		const threadId = await seedTeamThread(t, contactId);
		const [first] = await t.run((ctx) =>
			ctx.db
				.query('inboundMessages')
				.withIndex('by_thread', (q) => q.eq('threadId', threadId))
				.collect()
		);
		const second = await t.run((ctx) =>
			ctx.db.insert('inboundMessages', {
				messageId: '<second@example.com>',
				from: first!.from,
				to: first!.to,
				subject: 'Another question',
				textBody: 'And the October one?',
				processingStatus: 'received',
				receivedAt: Date.now(),
				threadId,
			})
		);
		llm.slots = [slot('date_time', 'When will payment arrive?')];
		const firstTarget = {
			kind: 'teamThread' as const,
			threadId,
			inboundMessageId: first!._id,
		};
		const asked = await t.action(api.mail.ai.composeDraft.start, {
			target: firstTarget,
			locale: 'en',
		});
		expect(asked.status).toBe('asking');
		expect(
			await t.query(api.mail.ai.composeDraftStore.getSession, { target: firstTarget })
		).not.toBeNull();
		// The composer for the second message never sees the first one's session.
		expect(
			await t.query(api.mail.ai.composeDraftStore.getSession, {
				target: { kind: 'teamThread', threadId, inboundMessageId: second },
			})
		).toBeNull();
		expect(
			await t.query(api.mail.ai.composeDraftStore.getSession, {
				target: { kind: 'teamThread', threadId },
			})
		).toBeNull();
	});

	it('answering builds the pipeline briefing only once', async () => {
		const t = await makeT();
		sess.user = { userId: 'admin-1', role: 'owner', activeOrganizationId: ORG };
		const contactId = await seedCustomer(t);
		const threadId = await seedTeamThread(t, contactId);
		llm.slots = [slot('date_time', 'When will payment arrive?')];
		const target = { kind: 'teamThread' as const, threadId };

		const asked = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });
		expect(asked.status).toBe('asking');
		const res = await t.action(api.mail.ai.composeDraft.answer, {
			sessionId: asked.sessionId,
			answers: [],
			skip: true,
		});
		expect(res.status).toBe('ready');
		expect(vi.mocked(assembleInboundBriefing)).toHaveBeenCalledTimes(1);
		expect(lastDraftPrompt()).toContain('Jonas asks for the September invoice');
	});

	/**
	 * The thread's message met a spend refusal in interpretation, and its retry
	 * is not due yet, so the briefing reuses the stored result instead of
	 * running it again. The next briefing is the real one, so the stored
	 * refusal is what it meets.
	 */
	async function briefOnCachedRefusal(t: Tx, threadId: Id<'conversationThreads'>) {
		await t.run(async (ctx) => {
			const message = (await ctx.db
				.query('inboundMessages')
				.withIndex('by_thread', (q) => q.eq('threadId', threadId))
				.first())!;
			await ctx.db.insert('messageInterpretations', {
				threadKind: 'team',
				conversationThreadId: threadId,
				source: { kind: 'inbound', id: message._id },
				sourceKey: `inbound:${message._id}`,
				contentRevision: 'rev-1',
				extractorVersion: INTERPRET_EXTRACTOR_VERSION,
				mode: 'actions',
				status: 'failed',
				errorCode: 'budget',
				budgetRefusal: { reason: 'monthly_ceiling', limit: 'ceiling' },
				nextRetryAt: Date.now() + 60 * 60 * 1000,
				deletionEpoch: 1,
				isCounted: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		const actual = await vi.importActual<typeof ContextRetrievalModule>(
			'../agent/steps/context_retrieval'
		);
		vi.mocked(assembleInboundBriefing).mockImplementationOnce(actual.assembleInboundBriefing);
	}

	it('returns the budget error for a cached interpretation refusal, with no model call (final r2 F1)', async () => {
		const t = await makeT();
		sess.user = { userId: 'admin-1', role: 'owner', activeOrganizationId: ORG };
		const contactId = await seedCustomer(t);
		const threadId = await seedTeamThread(t, contactId);
		llm.slots = [slot('date_time', 'When will payment arrive?')];
		await briefOnCachedRefusal(t, threadId);
		vi.mocked(runLlmObject).mockClear();

		await expect(
			t.action(api.mail.ai.composeDraft.start, {
				target: { kind: 'teamThread', threadId },
				locale: 'en',
			})
		).rejects.toMatchObject({
			data: { data: { code: 'AI_BUDGET_EXHAUSTED', reason: 'monthly_ceiling' } },
		});
		expect(vi.mocked(assembleInboundBriefing)).toHaveBeenCalledTimes(1);
		// No gap check, clarification or draft followed.
		expect(vi.mocked(runLlmObject)).not.toHaveBeenCalled();
		expect(vi.mocked(runLlmText)).not.toHaveBeenCalled();
		expect(vi.mocked(runLlmStream)).not.toHaveBeenCalled();
		expect(
			await t.query(api.mail.ai.composeDraftStore.getSession, {
				target: { kind: 'teamThread', threadId },
			})
		).toBeNull();
	});

	it('an answer that must rebuild the briefing hands the questions back on a cached refusal (final r3 F1)', async () => {
		const t = await makeT();
		sess.user = { userId: 'admin-1', role: 'owner', activeOrganizationId: ORG };
		const contactId = await seedCustomer(t);
		const threadId = await seedTeamThread(t, contactId);
		llm.slots = [slot('date_time', 'When will payment arrive?')];
		const target = { kind: 'teamThread' as const, threadId };
		const asked = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });
		expect(asked.status).toBe('asking');
		const payment = asked.questions.find((q) => q.slotType === 'date_time')!;
		// A context too large to keep: `answer` builds the briefing again.
		await t.run((ctx) => ctx.db.patch(asked.sessionId, { draftContext: undefined }));
		await briefOnCachedRefusal(t, threadId);
		vi.mocked(runLlmObject).mockClear();
		vi.mocked(runLlmText).mockClear();

		await expect(
			t.action(api.mail.ai.composeDraft.answer, {
				sessionId: asked.sessionId,
				answers: [{ questionId: payment.id, value: 'Friday' }],
			})
		).rejects.toMatchObject({
			data: { data: { code: 'AI_BUDGET_EXHAUSTED', reason: 'monthly_ceiling' } },
		});
		expect(vi.mocked(runLlmObject)).not.toHaveBeenCalled();
		expect(vi.mocked(runLlmText)).not.toHaveBeenCalled();
		expect(vi.mocked(runLlmStream)).not.toHaveBeenCalled();
		// Not stuck busy: back to the questions, the answer kept.
		const session = await t.query(api.mail.ai.composeDraftStore.getSession, { target });
		expect(session?.status).toBe('asking');
		expect(session?.questions.find((q) => q.id === payment.id)?.answer?.value).toBe('Friday');

		// And it can be sent again once the briefing goes through.
		const res = await t.action(api.mail.ai.composeDraft.answer, {
			sessionId: asked.sessionId,
			answers: [],
		});
		expect(res.status).toBe('ready');
		expect(lastDraftPrompt()).toContain('Friday');
	});

	it('an answer that fails before its draft stream opens hands the questions back (final r3 sweep)', async () => {
		const t = await makeT();
		sess.user = { userId: 'admin-1', role: 'owner', activeOrganizationId: ORG };
		const contactId = await seedCustomer(t);
		const threadId = await seedTeamThread(t, contactId);
		llm.slots = [slot('date_time', 'When will payment arrive?')];
		const target = { kind: 'teamThread' as const, threadId };
		const asked = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });
		const payment = asked.questions.find((q) => q.slotType === 'date_time')!;
		llm.planFailure = new Error('plan read failed');

		await expect(
			t.action(api.mail.ai.composeDraft.answer, {
				sessionId: asked.sessionId,
				answers: [{ questionId: payment.id, value: 'Friday' }],
			})
		).rejects.toThrow('plan read failed');
		expect(vi.mocked(runLlmStream)).not.toHaveBeenCalled();
		const session = await t.query(api.mail.ai.composeDraftStore.getSession, { target });
		expect(session?.status).toBe('asking');
		expect(session?.questions.find((q) => q.id === payment.id)?.answer?.value).toBe('Friday');
	});

	it('works on a team-only instance, and not once the team inbox is off', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		// No Postbox: only the team inbox and AI.
		await enableFeatures(t, ['ai']);
		sess.user = { userId: 'admin-1', role: 'owner', activeOrganizationId: ORG };
		const contactId = await seedCustomer(t);
		const threadId = await seedTeamThread(t, contactId);
		const target = { kind: 'teamThread' as const, threadId };

		const asked = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });
		expect(await t.query(api.mail.ai.composeDraftStore.getSession, { target })).toMatchObject({
			status: 'asking',
		});
		const res = await t.action(api.mail.ai.composeDraft.answer, {
			sessionId: asked.sessionId,
			answers: [],
			skip: true,
		});
		expect(res.status).toBe('ready');
		const stream = await t.query(api.mail.draftStreamStore.getDraftStream, {
			streamId: res.streamId!,
		});
		expect(stream?.status).toBe('complete');

		await t.run(async (ctx) => {
			const settings = (await ctx.db.query('instanceSettings').first())!;
			await ctx.db.patch(settings._id, {
				featureFlags: { ...settings.featureFlags, inbox: false },
			});
		});
		// With the Postbox on, the team thread is still out of reach.
		await enableFeatures(t, ['mail.external']);
		expect(await t.query(api.mail.ai.composeDraftStore.getSession, { target })).toBeNull();
		await expect(
			t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' })
		).rejects.toMatchObject({ data: { category: 'forbidden' } });
	});

	// D13 / #1339 (Sol r2 F2): the message being answered is guarded before its
	// briefing, its trigger text or the gap check reach a model, and a held-back
	// message is refused with no raw-text fallback.
	const SKIPPED_SCAN = {
		injectionDetected: false,
		confidence: 0,
		spamScore: 0,
		phishingDetected: false,
		guardUnavailable: false,
		guardNotRun: { reason: 'agent_disabled' as const, at: 1 },
		scanTimestamp: 1,
	};
	const guardCalls = () =>
		vi
			.mocked(runLlmObject)
			.mock.calls.filter(([opts]) => String(opts.prompt ?? '').includes('security classifier'))
			.length;
	const HELD = { data: { category: 'invalid_state', data: { code: 'MESSAGE_HELD_BY_GUARD' } } };

	it.each([
		[
			'a quarantined injection',
			{
				processingStatus: 'quarantined',
				securityFlags: {
					...SKIPPED_SCAN,
					guardNotRun: undefined,
					injectionDetected: true,
					confidence: 0.9,
				},
			},
		],
		['malware', { processingStatus: 'quarantined', virusVerdict: 'infected' }],
	])('refuses to draft for %s, with no model call', async (_, message) => {
		const t = await makeT();
		sess.user = { userId: 'admin-1', role: 'owner', activeOrganizationId: ORG };
		const threadId = await seedTeamThread(t, await seedCustomer(t), message);
		vi.mocked(runLlmObject).mockClear();

		await expect(
			t.action(api.mail.ai.composeDraft.start, {
				target: { kind: 'teamThread', threadId },
				locale: 'en',
			})
		).rejects.toMatchObject(HELD);
		expect(vi.mocked(assembleInboundBriefing)).not.toHaveBeenCalled();
		expect(vi.mocked(runLlmObject)).not.toHaveBeenCalled();
		expect(vi.mocked(runLlmStream)).not.toHaveBeenCalled();
	});

	it('guards a message whose scan skipped the guard, and refuses it when flagged', async () => {
		llm.guard = { isInjection: true, confidence: 0.95, reason: 'manipulation attempt' };
		const t = await makeT();
		sess.user = { userId: 'admin-1', role: 'owner', activeOrganizationId: ORG };
		const threadId = await seedTeamThread(t, await seedCustomer(t), {
			processingStatus: 'security_check',
			securityFlags: SKIPPED_SCAN,
		});
		vi.mocked(runLlmObject).mockClear();

		await expect(
			t.action(api.mail.ai.composeDraft.start, {
				target: { kind: 'teamThread', threadId },
				locale: 'en',
			})
		).rejects.toMatchObject(HELD);
		expect(guardCalls()).toBe(1);
		expect(vi.mocked(runLlmObject)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(assembleInboundBriefing)).not.toHaveBeenCalled();
		expect(vi.mocked(runLlmStream)).not.toHaveBeenCalled();
	});

	it('drafts on a message whose late guard passes it', async () => {
		const t = await makeT();
		sess.user = { userId: 'admin-1', role: 'owner', activeOrganizationId: ORG };
		const threadId = await seedTeamThread(t, await seedCustomer(t), {
			processingStatus: 'security_check',
			securityFlags: SKIPPED_SCAN,
		});
		vi.mocked(runLlmObject).mockClear();

		const res = await t.action(api.mail.ai.composeDraft.start, {
			target: { kind: 'teamThread', threadId },
			locale: 'en',
		});

		// Not refused: the session opens on the briefing (asking or drafting).
		expect(res.sessionId).toBeDefined();
		expect(guardCalls()).toBe(1);
		expect(vi.mocked(assembleInboundBriefing)).toHaveBeenCalledTimes(1);
	});

	it('refuses a member who cannot read the shared inbox', async () => {
		const t = await makeT();
		const contactId = await seedCustomer(t);
		const threadId = await seedTeamThread(t, contactId);
		await expect(
			t.action(api.mail.ai.composeDraft.start, {
				target: { kind: 'teamThread', threadId },
				locale: 'en',
			})
		).rejects.toMatchObject({ data: { category: 'forbidden' } });
	});
});

describe('retention', () => {
	it('sweeps sessions started more than 30 days ago, with their streams', async () => {
		const t = await makeT();
		const { target, mailboxId, messageId } = await replyDraft(t, 'Thanks for the call, talk soon.');
		const old = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });
		expect(old.streamId).toBeDefined();
		// A draft row gone without its session (a Postbox session is kept while
		// its draft exists, for the gap guard).
		await t.run(async (ctx) => {
			await ctx.db.delete(target.draftId);
		});
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
			const { draftId } = await t.mutation(api.mail.drafts.create, {
				mailboxId,
				inReplyToMessageId: messageId,
			});
			const fresh = { kind: 'mailDraft' as const, draftId };
			const kept = await t.action(api.mail.ai.composeDraft.start, { target: fresh, locale: 'en' });

			const swept = await t.mutation(internal.mail.ai.composeDraftStore.sweepStaleSessions, {});

			expect(swept.deleted).toBe(1);
			const left = await t.run(async (ctx) => ({
				sessions: await ctx.db.query('answerAskSessions').collect(),
				oldStream: await ctx.db.get(old.streamId!),
			}));
			expect(left.sessions.map((row) => row._id)).toEqual([kept.sessionId]);
			expect(left.oldStream).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	const DAY = 24 * 60 * 60 * 1000;

	/** `count` sessions straight into the table, on team threads unless `draftId` is given. */
	async function seedSessions(
		t: Tx,
		count: number,
		opts: { ownerId?: string; draftId?: Id<'mailDrafts'> } = {}
	) {
		return await t.run(async (ctx) => {
			const ids: Id<'answerAskSessions'>[] = [];
			for (let i = 0; i < count; i++) {
				const now = Date.now();
				let target;
				if (opts.draftId) {
					target = { kind: 'mailDraft' as const, draftId: opts.draftId };
				} else {
					const contactId = await ctx.db.insert('contacts', createTestContact());
					const { updatedAt: _u, ...thread } = createTestConversationThread({ contactId });
					target = {
						kind: 'teamThread' as const,
						threadId: await ctx.db.insert('conversationThreads', thread),
					};
				}
				ids.push(
					await ctx.db.insert('answerAskSessions', {
						ownerId: opts.ownerId ?? 'user-a',
						organizationId: ORG,
						target,
						targetKey:
							target.kind === 'mailDraft'
								? `mailDraft:${target.draftId}`
								: `teamThread:${target.threadId}`,
						locale: 'en',
						round: 1,
						status: 'ready',
						questions: [],
						attachedFiles: [],
						createdAt: now,
						updatedAt: now,
					})
				);
			}
			return ids;
		});
	}
	const remaining = (t: Tx) =>
		t.run(async (ctx) => (await ctx.db.query('answerAskSessions').collect()).length);

	it('reads a bounded batch per run and continues in the next one', async () => {
		const t = await makeT();
		await seedSessions(t, 40);
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(Date.now() + 31 * DAY);
			const first = await t.mutation(internal.mail.ai.composeDraftStore.sweepStaleSessions, {});
			expect(first.deleted).toBeGreaterThan(0);
			expect(first.deleted).toBeLessThanOrEqual(20);
			expect(await remaining(t)).toBe(40 - first.deleted);
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps a Postbox session while its draft exists, and walks past it', async () => {
		const t = await makeT();
		const { draftId } = await replyDraft(t);
		const kept = await seedSessions(t, 20, { draftId });
		const gone = await seedSessions(t, 1);
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(Date.now() + 31 * DAY);
			const first = await t.mutation(internal.mail.ai.composeDraftStore.sweepStaleSessions, {});
			expect(first.deleted).toBe(0);
			// The next run starts past the kept rows instead of reading them again.
			const lastKept = await t.run(async (ctx) => (await ctx.db.get(kept[first.kept - 1]!))!);
			const second = await t.mutation(internal.mail.ai.composeDraftStore.sweepStaleSessions, {
				after: lastKept._creationTime,
			});
			expect(second.deleted).toBe(1);
			const left = await t.run(async (ctx) => await ctx.db.query('answerAskSessions').collect());
			expect(left.map((row) => row._id).sort()).toEqual([...kept].sort());
			expect(left.map((row) => row._id)).not.toContain(gone[0]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('erasing a member drops their sessions a bounded batch at a time', async () => {
		const t = await makeT();
		await seedSessions(t, 40, { ownerId: 'leaver' });
		const hasMore = await t.run(async (ctx) => await deleteAskSessionsOfOwner(ctx, 'leaver'));
		expect(hasMore).toBe(true);
		const left = await remaining(t);
		expect(40 - left).toBeLessThanOrEqual(20);
		expect(40 - left).toBeGreaterThan(0);
	});
});
