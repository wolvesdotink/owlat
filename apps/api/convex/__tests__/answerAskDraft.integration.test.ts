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
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	enableFeatures,
	createTestConversationThread,
	createTestInboundMessage,
} from './factories';
import { normalizeQuestionKey } from '../inbox/clarificationMemoryMatch';
import { runLlmStream } from '../lib/llm/dispatch';
import { FILE_NOT_READY_OPTION } from '../mail/ai/composeDraftPolicy';
import { CUSTOMER, ORG, seedCustomer, seedFile, seedRequest } from './helpers/answerAsk';

import type * as SessionOrganizationModule from '../lib/sessionOrganization';
import type * as LlmProviderModule from '../lib/llmProvider';
import type * as DispatchModule from '../lib/llm/dispatch';
import type * as AttachmentSuggestModule from '../inbox/attachmentSuggest';

type FoundFile = AttachmentSuggestModule.FoundFile;
import type * as ContextRetrievalModule from '../agent/steps/context_retrieval';

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
	return { ...actual, resolveLanguageModel: vi.fn(() => 'test-model') };
});
vi.mock('../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<typeof DispatchModule>('../lib/llm/dispatch');
	const result = { tokenUsage: undefined, modelUsed: 'test-model' };
	return {
		...actual,
		runLlmObject: vi.fn(async (opts: { prompt?: string }) => {
			const prompt = String(opts.prompt ?? '');
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
	vi.mocked(runLlmStream).mockReset();
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
			options: [FILE_NOT_READY_OPTION],
		});
		expect(file!.attribution).toContain('example.org');
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
			answers: [{ questionId: 'file_request', value: FILE_NOT_READY_OPTION }],
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
	async function seedTeamThread(t: Tx, contactId: Id<'contacts'>) {
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
