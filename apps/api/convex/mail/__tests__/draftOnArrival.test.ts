/**
 * Personal-mail draft-on-arrival (mail/draftOnArrival.ts).
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
 *   - Happy path → exactly one persistDraftSlot with the quality score as
 *     confidence. NEVER auto-sends (there is no send call anywhere).
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
vi.mock('../../lib/llm/dispatch', () => ({
	runLlmText: (a: unknown) => runLlmTextMock(a as never),
	runLlmTextWithTools: (a: unknown) => runLlmTextMock(a as never),
	runLlmObject: (a: unknown) => runLlmObjectMock(a as never),
}));
vi.mock('../../lib/llmProvider', () => ({
	resolveLanguageModel: () => ({}) as never,
	resolveLanguageModelForClassifiedDraft: () => ({}) as never,
}));
vi.mock('../replyOptions', () => ({
	MAX_REPLY_OPTIONS: 3,
	generateReplyOptions: vi.fn(async () => ({
		replies: ['ALT ONE', 'ALT TWO'],
		tokenUsage: undefined,
		modelUsed: 'mock-model',
	})),
}));
vi.mock('../../analytics/llmUsage', () => ({ recordLlmSpend: vi.fn(async () => {}) }));

import { generateDraftOnArrival } from '../draftOnArrival';

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
		clarificationQuestions: undefined,
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
	const runMutation = vi.fn(async (_ref: unknown, params: Record<string, unknown>) => {
		if (params && 'draft' in params) {
			persisted.push(params as unknown as Persisted);
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
	return { ctx: { runMutation, runQuery } as never, persisted, runMutation, runQuery };
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

	it('happy path: persists exactly one review slot with the quality score as confidence', async () => {
		const h = makeCtx({ loaded: makeLoaded() });
		await generateDraftOnArrival(h.ctx, { threadId: 'thr1' as never });
		expect(h.persisted).toHaveLength(1);
		const slot = h.persisted[0]!;
		expect(slot.draft).toBe('PERSONAL DRAFT BODY');
		expect(slot.confidence).toBe(0.72);
		expect(slot.quality).toEqual({ score: 0.72, complete: true, grounded: true, flags: [] });
		// review-first (confidence 0.5, quality < 0.8) → alternatives offered.
		expect(slot.options?.length).toBeGreaterThanOrEqual(2);
		expect(h.runQuery).toHaveBeenCalledWith(expect.anything(), {
			mailboxId: 'mbx1',
			classification: 'other',
		});
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
