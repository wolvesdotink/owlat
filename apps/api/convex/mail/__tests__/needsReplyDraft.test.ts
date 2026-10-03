/**
 * The Reply Queue starter draft after the owner answers a clarification card
 * (`needsReplyClassify.draftWithAnswers` → `draftClarificationReply`).
 *
 * It drafts through the shared draft service (surface 'personal') with the
 * knowledge recall tool scoped to the sender's contact, puts the answers and
 * attached-file notes in the trusted confirmed block, and lands the body on the
 * card. The shared service and the recall tool are mocked; no model runs.
 */

import { getFunctionName } from 'convex/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as DraftService from '../../agent/shared/draftService';

const mocks = vi.hoisted(() => ({
	runSharedDraft: vi.fn(),
	buildRecallKnowledgeTool: vi.fn((_args: unknown) => ({ tool: 'recallKnowledge' })),
	runLlmText: vi.fn(),
}));

vi.mock('../../agent/shared/draftService', async () => {
	const actual = await vi.importActual<typeof DraftService>('../../agent/shared/draftService');
	return { ...actual, runSharedDraft: mocks.runSharedDraft };
});
vi.mock('../../agent/steps/draft/recall', () => ({
	MAX_RECALL_CALLS: 3,
	buildRecallKnowledgeTool: mocks.buildRecallKnowledgeTool,
}));
vi.mock('../../lib/llmProvider', () => ({ resolveLanguageModel: vi.fn(async () => 'mock-model') }));
vi.mock('../../lib/llm/dispatch', () => ({ runLlmText: mocks.runLlmText }));
vi.mock('../ai/voiceGuidance', () => ({
	loadVoiceGuidance: vi.fn(async () => null),
	formatVoiceSection: vi.fn(() => ''),
}));

import { draftClarificationReply } from '../ai/needsReplyDraft';
import type { Id } from '../../_generated/dataModel';

const threadId = 'thread_1' as Id<'mailThreads'>;

function context(overrides: Record<string, unknown> = {}) {
	return {
		mailboxId: 'mailbox_1',
		latestMessageId: 'msg_1',
		ownerAddress: 'ada@example.com',
		contactId: 'contact_1',
		transcript: 'Them: could you send us the September invoice?',
		answers: [{ question: 'Is the PO number on it?', answer: 'Yes, it is on it' }],
		fileNotes: '- The file "invoice-09.pdf" is attached to this reply; mention it naturally.',
		fileGaps: [],
		questionGaps: [],
		answeredSlotTypes: ['factual_lookup'],
		...overrides,
	};
}

function makeCtx(opts: { context?: unknown; gateThrows?: boolean } = {}) {
	const mutations: { name: string; args: Record<string, unknown> }[] = [];
	const ctx = {
		runQuery: vi.fn(async (ref: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('getClarificationContext')) {
				return opts.context === undefined ? context() : opts.context;
			}
			throw new Error(`unexpected runQuery: ${name}`);
		}),
		runMutation: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('assertAiAllowed') && opts.gateThrows) throw new Error('AI off');
			mutations.push({ name, args });
			return undefined;
		}),
		runAction: vi.fn(),
	};
	return {
		ctx: ctx as unknown as Parameters<typeof draftClarificationReply>[0],
		mutations,
		raw: ctx,
	};
}

beforeEach(() => {
	mocks.runSharedDraft.mockReset();
	mocks.buildRecallKnowledgeTool.mockClear();
	mocks.runLlmText.mockReset();
	mocks.runLlmText.mockResolvedValue({ text: 'baseline', tokenUsage: undefined, modelUsed: 'm' });
	mocks.runSharedDraft.mockResolvedValue({
		draftBody: '  Hi, here is the September invoice, PO included.  ',
		draftQuality: { score: 0.9, complete: true, grounded: true, flags: [] },
		draftOptions: [],
		tokenUsage: undefined,
		modelUsed: 'mock-model',
	});
});

describe('draftClarificationReply', () => {
	it('drafts through the shared service with recall and the confirmed answers', async () => {
		const { ctx, mutations } = makeCtx();
		await draftClarificationReply(ctx, { threadId });

		expect(mocks.runSharedDraft).toHaveBeenCalledOnce();
		const params = mocks.runSharedDraft.mock.calls[0]![1];
		expect(params).toMatchObject({
			surface: 'personal',
			context: 'Them: could you send us the September invoice?',
			tools: { recallKnowledge: { tool: 'recallKnowledge' } },
			maxSteps: 5,
			strategyScope: { mailboxId: 'mailbox_1', classification: 'other' },
		});
		expect(params.audience).toContain('ada@example.com');
		// Trusted block: the answer as "question answer", then the file note.
		expect(params.confirmedContext).toBe(
			'- Is the PO number on it? Yes, it is on it\n' +
				'- The file "invoice-09.pdf" is attached to this reply; mention it naturally.'
		);
		// Recall is scoped to the sender's contact, never org-wide.
		expect(mocks.buildRecallKnowledgeTool.mock.calls[0]![0]).toMatchObject({
			scopeToContact: 'contact_1',
		});

		const persisted = mutations.find((m) => m.name.includes('persistClarificationDraft'));
		expect(persisted?.args).toEqual({
			threadId,
			expectedLatestMessageId: 'msg_1',
			draft: 'Hi, here is the September invoice, PO included.',
		});
	});

	it('leaves a placeholder for a file question still open, even when the model drops it', async () => {
		const gap = '[[Please provide the invoice PDFs]]';
		const { ctx, mutations } = makeCtx({ context: context({ fileNotes: '', fileGaps: [gap] }) });
		await draftClarificationReply(ctx, { threadId });

		const params = mocks.runSharedDraft.mock.calls[0]![1];
		expect(params.confirmedContext).toContain('not attached yet');
		expect(params.confirmedContext).toContain(gap);
		const persisted = mutations.find((m) => m.name.includes('persistClarificationDraft'));
		expect(persisted?.args['draft']).toBe(
			`Hi, here is the September invoice, PO included.\n\n${gap}`
		);
	});

	it('leaves a placeholder for a question the owner skipped', async () => {
		const gap = '[[Which delivery date works for you]]';
		const { ctx, mutations } = makeCtx({ context: context({ questionGaps: [gap] }) });
		await draftClarificationReply(ctx, { threadId });

		const params = mocks.runSharedDraft.mock.calls[0]![1];
		expect(params.confirmedContext).toContain('has not answered these questions yet');
		expect(params.confirmedContext).toContain(gap);
		const persisted = mutations.find((m) => m.name.includes('persistClarificationDraft'));
		expect(persisted?.args['draft']).toBe(
			`Hi, here is the September invoice, PO included.\n\n${gap}`
		);
	});

	it('keeps the placeholder within the stored limit when the model writes a long reply', async () => {
		const gap = '[[Provide the invoices]]';
		mocks.runSharedDraft.mockResolvedValueOnce({
			draftBody: 'A'.repeat(4000),
			draftQuality: undefined,
			draftOptions: [],
			tokenUsage: undefined,
			modelUsed: 'mock-model',
		});
		const { ctx, mutations } = makeCtx({ context: context({ fileNotes: '', fileGaps: [gap] }) });
		await draftClarificationReply(ctx, { threadId });

		const draft = mutations.find((m) => m.name.includes('persistClarificationDraft'))?.args[
			'draft'
		] as string;
		expect(draft.length).toBeLessThanOrEqual(4000);
		expect(draft.endsWith(gap)).toBe(true);
	});

	it('recalls org-general knowledge only when the sender has no contact', async () => {
		const { ctx } = makeCtx({ context: context({ contactId: undefined }) });
		await draftClarificationReply(ctx, { threadId });
		expect(mocks.buildRecallKnowledgeTool.mock.calls[0]![0]).toMatchObject({
			scopeToContact: 'org-general-only',
		});
	});

	it('writes nothing when the shared service refuses (injection) or AI is off', async () => {
		mocks.runSharedDraft.mockRejectedValueOnce(new Error('Context contains prompt-injection'));
		const refused = makeCtx();
		await draftClarificationReply(refused.ctx, { threadId });
		expect(refused.mutations.some((m) => m.name.includes('persistClarificationDraft'))).toBe(false);

		const off = makeCtx({ gateThrows: true });
		await draftClarificationReply(off.ctx, { threadId });
		expect(off.raw.runQuery).not.toHaveBeenCalled();
		expect(mocks.runSharedDraft).toHaveBeenCalledOnce();
	});

	it('skips drafting when the card has no answers', async () => {
		const { ctx } = makeCtx({ context: context({ answers: [] }) });
		await draftClarificationReply(ctx, { threadId });
		expect(mocks.runSharedDraft).not.toHaveBeenCalled();
	});
});
