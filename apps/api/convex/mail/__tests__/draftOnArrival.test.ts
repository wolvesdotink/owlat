/**
 * Personal-mail draft-on-arrival (mail/ai/draftOnArrival.ts).
 *
 * Exercises the fail-soft branches and the happy path of generateDraftOnArrival
 * with a hand-rolled ctx — no Convex, no live model. The shared draft service is
 * REAL here (this is the integration point); only its LLM seam is mocked, so we
 * verify that personal mail drives the same pipeline and persists a review slot.
 *
 * FAIL-SOFT invariants pinned:
 *   - AI disabled (assertAiAllowed throws)  → no slot persisted.
 *   - No live needs-reply thread (loader null) → no slot persisted.
 *   - LLM generation error → no slot persisted (thread still shows for reply).
 *   - A draft with a gap → no slot; its gaps become the thread's questions.
 *   - Happy path → exactly one persistDraftSlot with the quality score as
 *     confidence, after two model calls (the draft and its self-check) and no
 *     alternative-drafts call (#1200). NEVER auto-sends (there is no send call
 *     anywhere).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFunctionName } from 'convex/server';

// LLM seam used by the shared draft service (resolved paths match its imports).
const runLlmTextMock = vi.fn(async (_a: unknown) => ({
	text: 'PERSONAL DRAFT BODY',
	tokenUsage: undefined,
	modelUsed: 'mock-model',
}));
const runLlmObjectMock = vi.fn(async (_a: unknown) => ({
	object: { score: 0.72, complete: true, grounded: true, flags: [] },
	tokenUsage: undefined,
	modelUsed: 'mock-model',
}));
vi.mock('../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../analytics/__tests__/meteredDispatch.testlib');
	return {
		runLlmText: metered((a: unknown) => runLlmTextMock(a as never)),
		runLlmTextWithTools: metered((a: unknown) => runLlmTextMock(a as never)),
		runLlmObject: metered((a: unknown) => runLlmObjectMock(a as never)),
	};
});
vi.mock('../../lib/llmProvider', () => ({
	resolveLanguageModel: () => ({}) as never,
	classifiedDraftRouteOf: () => 'capable',
}));

import { generateDraftOnArrival } from '../ai/draftOnArrival';
import { ledgerRows } from '../../analytics/__tests__/meteredDispatch.testlib';
import { LlmPartialUsageError } from '../../lib/llm/partialUsage';

type Persisted = { draft: string; confidence: number; quality?: unknown; options?: string[] };

function makeLoaded(over: Record<string, unknown> = {}) {
	return {
		context: 'From: sam@acme.test\nSubject: Hi\nCan you confirm Friday works?',
		triggerMessageId: 'msg1',
		triggerSubject: 'Hi',
		mailboxId: 'mbx1',
		latestMessageId: 'msg1',
		urgency: 'normal',
		isBulk: false,
		senderAddress: 'sam@acme.test',
		...over,
	};
}

/**
 * Build a mock ActionCtx. runMutation distinguishes the three call sites by the
 * shape of their args (assertAiAllowed: {}, getGuidanceForMailbox: {mailboxId},
 * persistDraftSlot: {draft}). runQuery always returns `loaded`.
 */
function makeCtx(opts: { aiOff?: boolean; loaded: unknown }) {
	const persisted: Persisted[] = [];
	const held: unknown[] = [];
	const runMutation = vi.fn(async (_ref: unknown, params: Record<string, unknown>) => {
		if (params && 'draft' in params) {
			persisted.push(params as unknown as Persisted);
			return;
		}
		if (params && 'questions' in params) {
			held.push(params);
			return;
		}
		if (params && 'mailboxId' in params) return { guidance: null };
		// assertAiAllowed ({})
		if (opts.aiOff) throw new Error('AI disabled');
		return;
	});
	const runQuery = vi.fn(async (ref: unknown) => {
		const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
		return name.includes('resolveForDraft') ? 'default' : opts.loaded;
	});
	return { ctx: { runMutation, runQuery } as never, persisted, held, runMutation, runQuery };
}

beforeEach(() => {
	runLlmTextMock.mockClear();
	runLlmObjectMock.mockClear();
	runLlmTextMock.mockResolvedValue({
		text: 'PERSONAL DRAFT BODY',
		tokenUsage: undefined,
		modelUsed: 'mock-model',
	});
});

describe('generateDraftOnArrival', () => {
	it('FAIL-SOFT: AI disabled → no slot persisted, loader never consulted', async () => {
		const h = makeCtx({ aiOff: true, loaded: makeLoaded() });
		await generateDraftOnArrival(h.ctx, { threadId: 'thr1' as never });
		expect(h.persisted).toHaveLength(0);
		expect(h.runQuery).not.toHaveBeenCalled();
	});

	it('FAIL-SOFT: no live needs-reply thread (loader null) → no slot persisted', async () => {
		const h = makeCtx({ loaded: null });
		await generateDraftOnArrival(h.ctx, { threadId: 'thr1' as never });
		expect(h.persisted).toHaveLength(0);
	});

	it('records the primary draft generation under its own spend label', async () => {
		const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
		runLlmTextMock.mockResolvedValueOnce({
			text: 'PERSONAL DRAFT BODY',
			tokenUsage: usage as never,
			modelUsed: 'mock-model',
		});
		const h = makeCtx({ loaded: makeLoaded() });
		await generateDraftOnArrival(h.ctx, { threadId: 'thr1' as never });
		// Once: the shared service records it, the caller no longer does (#1256).
		expect(ledgerRows(h.runMutation).filter((row) => row.feature === 'postbox_draft')).toEqual([
			expect.objectContaining({
				usage,
				modelUsed: 'mock-model',
				attempt: 1,
				rootRequestId: 'postbox_thread:thr1',
			}),
		]);
	});

	it('records the spend of a generation that fails after a paid step (#1256)', async () => {
		const usage = { promptTokens: 6, completionTokens: 3, totalTokens: 9 };
		runLlmTextMock.mockRejectedValueOnce(
			new LlmPartialUsageError(new Error('provider down'), usage, 'mock-model')
		);
		const h = makeCtx({ loaded: makeLoaded() });
		await generateDraftOnArrival(h.ctx, { threadId: 'thr1' as never });
		expect(h.persisted).toHaveLength(0);
		expect(ledgerRows(h.runMutation).map((row) => [row.feature, row.usage, row.modelUsed])).toEqual(
			[['postbox_draft', usage, 'mock-model']]
		);
	});

	it('happy path: persists exactly one review slot with the quality score as confidence', async () => {
		const h = makeCtx({ loaded: makeLoaded() });
		await generateDraftOnArrival(h.ctx, { threadId: 'thr1' as never });
		expect(h.persisted).toHaveLength(1);
		const slot = h.persisted[0]!;
		expect(slot.draft).toBe('PERSONAL DRAFT BODY');
		expect(slot.confidence).toBe(0.72);
		expect(slot.quality).toEqual({ score: 0.72, complete: true, grounded: true, flags: [] });
		// The draft and its self-check, and no alternatives: the slot has no
		// way to offer them (#1200). The self-check scored low (0.72), the case
		// that used to buy a third, capable-tier call on every arrival.
		expect(runLlmTextMock).toHaveBeenCalledTimes(1);
		expect(runLlmObjectMock).toHaveBeenCalledTimes(1);
		expect(slot.options).toBeUndefined();
		expect(h.runQuery).toHaveBeenCalledWith(expect.anything(), {
			mailboxId: 'mbx1',
			classification: 'other',
		});
	});

	it('stores no draft with a gap of its own: each gap becomes a question for the owner', async () => {
		runLlmTextMock.mockResolvedValueOnce({
			text: 'Hi Sam,\n\nFriday works. The total is [[invoice total]].\n\nBest',
			tokenUsage: undefined,
			modelUsed: 'mock-model',
		});
		const h = makeCtx({ loaded: makeLoaded() });
		await generateDraftOnArrival(h.ctx, { threadId: 'thr1' as never });

		expect(h.persisted).toHaveLength(0);
		expect(h.held).toHaveLength(1);
		expect(h.held[0]).toMatchObject({
			threadId: 'thr1',
			triggerMessageId: 'msg1',
			questions: [
				expect.objectContaining({
					id: 'gap_0',
					text: 'invoice total',
					origin: { kind: 'email', senderDomain: 'acme.test' },
				}),
			],
		});
	});

	it('stores nothing for a gap no question may ask for (a password)', async () => {
		runLlmTextMock.mockResolvedValueOnce({
			text: 'Hi Sam, I will log in with [[your password]].',
			tokenUsage: undefined,
			modelUsed: 'mock-model',
		});
		const h = makeCtx({ loaded: makeLoaded() });
		await generateDraftOnArrival(h.ctx, { threadId: 'thr1' as never });

		expect(h.persisted).toHaveLength(0);
		expect(h.held).toHaveLength(0);
	});

	it('counts a reviewer note the model wrote as a gap, so it is asked too', async () => {
		runLlmTextMock.mockResolvedValueOnce({
			text: 'Hallo Sam,\n\n[Bitte prüfen: x]\n\nViele Grüße',
			tokenUsage: undefined,
			modelUsed: 'mock-model',
		});
		const h = makeCtx({ loaded: makeLoaded() });
		await generateDraftOnArrival(h.ctx, { threadId: 'thr1' as never });

		expect(h.persisted).toHaveLength(0);
		const questions = (h.held[0] as { questions: { text: string }[] }).questions;
		expect(questions.map((q) => q.text)).toEqual(['Bitte prüfen: x']);
	});

	it('FAIL-SOFT: LLM generation error → no slot persisted (thread still shows for reply)', async () => {
		runLlmTextMock.mockRejectedValueOnce(new Error('llm down'));
		const h = makeCtx({ loaded: makeLoaded() });
		await generateDraftOnArrival(h.ctx, { threadId: 'thr1' as never });
		expect(h.persisted).toHaveLength(0);
	});

	it('FAIL-SOFT: an empty generated body persists nothing', async () => {
		runLlmTextMock.mockResolvedValueOnce({
			text: '   ',
			tokenUsage: undefined,
			modelUsed: 'mock-model',
		});
		const h = makeCtx({ loaded: makeLoaded() });
		await generateDraftOnArrival(h.ctx, { threadId: 'thr1' as never });
		expect(h.persisted).toHaveLength(0);
	});
});
