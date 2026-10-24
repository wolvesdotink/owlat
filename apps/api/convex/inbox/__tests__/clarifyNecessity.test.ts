/**
 * The necessity judgment on all three surfaces: with `clarifyNecessity`
 * at `enforce`, one necessity judgment through the decisions lane's runner
 * replaces the sampled replies and the divergence judge.
 *
 * - Needed: every open slot is asked in one batch, the surface's file
 *   question and answer memory kept.
 * - Not needed, or no answer: nothing is asked beyond the owed files.
 * - No sample and no capable-tier call is made.
 * - `shadow`: today's check decides, the judgment is asked beside it with
 *   today's answer as its baseline.
 *
 * The runner is mocked here (its claim and admission are tested in
 * `decision/__tests__/phase3Bundles.test.ts`); every model call is mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStepCtx } from '../../agent/steps/__tests__/stepCtx';

const mocks = vi.hoisted(() => ({
	models: [] as string[],
	runLlmText: vi.fn(),
	runLlmObject: vi.fn(),
	runBundle: vi.fn(),
}));

vi.mock('../../lib/llm/dispatch', () => ({
	runLlmText: (opts: { model: string }) => {
		mocks.models.push(`text:${opts.model}`);
		return mocks.runLlmText(opts);
	},
	runLlmObject: (opts: { model: string }) => {
		mocks.models.push(`object:${opts.model}`);
		return mocks.runLlmObject(opts);
	},
}));
vi.mock('../../lib/llmProvider', () => ({
	resolveLanguageModel: vi.fn(async (_ctx: unknown, role: string) => `model:${role}`),
}));
vi.mock('../../analytics/meteredSpend', async () => ({
	...(await vi.importActual<object>('../../analytics/meteredSpend')),
	meterLlmCall: async (_ctx: unknown, _target: unknown, call: (m: unknown) => unknown) =>
		call({ requests: [], record: () => undefined }),
}));
vi.mock('../../decision/bundleRunner', () => ({ runBundle: mocks.runBundle }));
vi.mock('../attachmentSuggest', () => ({ searchFilesForRequest: vi.fn(async () => []) }));

import { replySlotsSchema, divergenceSchema, type ReplySlot } from '../clarificationSlots';
import { clarifyStep, type ClarifyInput } from '../../agent/steps/clarify';
import { refineClarification } from '../../mail/ai/needsReplyRefine';
import { runGapCheck } from '../../mail/ai/composeDraftGap';
import type { Id } from '../../_generated/dataModel';
import { AdmissionRefusedError } from '../../lib/llm/admissionPort';

const slot = (over: Partial<ReplySlot>): ReplySlot => ({
	slotType: 'decision',
	question: 'Should we agree to the new date?',
	answerableFromContext: false,
	decisionRelevant: true,
	options: [],
	itemRef: null,
	...over,
});

const SLOTS: ReplySlot[] = [
	slot({}),
	slot({ slotType: 'price_number', question: 'What price should we quote?' }),
	slot({ slotType: 'date_time', question: 'Which date works?' }),
	slot({ slotType: 'attachment', question: 'Which contract should we send?' }),
	slot({ slotType: 'stance_tone', question: 'How firm?', answerableFromContext: true }),
];

function policy(clarifyNecessity: 'off' | 'shadow' | 'enforce') {
	return { policy: { clarifyNecessity, policyVersion: 3 }, isDecisionPlaneOn: false };
}

/** The runner answers `labels` (or nothing, `hasRun: false`). */
function necessity(label: 'needed' | 'not_needed' | null) {
	mocks.runBundle.mockResolvedValue(
		label === null
			? { hasRun: false, why: 'no_allowance' }
			: { hasRun: true, status: 'complete', labels: { necessity: label } }
	);
}

beforeEach(() => {
	mocks.models.length = 0;
	mocks.runBundle.mockReset();
	mocks.runLlmText.mockReset();
	mocks.runLlmObject.mockReset();
	mocks.runLlmText.mockResolvedValue({ text: 'A candidate', tokenUsage: undefined });
	mocks.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
		if (schema === replySlotsSchema) return { object: { slots: SLOTS }, modelUsed: 'm' };
		if (schema === divergenceSchema) return { object: { divergentSlotIndexes: [1] } };
		throw new Error('translation unavailable');
	});
});

/** Nothing sampled, nothing on the capable tier. */
function expectNoSamplingAndNoCapableCall() {
	expect(mocks.runLlmText).not.toHaveBeenCalled();
	expect(mocks.models.filter((m) => m.endsWith('model:draft'))).toEqual([]);
}

// ── Team Inbox ────────────────────────────────────────────────────────────

const inboundMessageId = 'msg_d5_team' as Id<'inboundMessages'>;
const teamInput: ClarifyInput = {
	inboundMessageId,
	context: 'Customer: can we move the date, at what price, and which contract applies?',
	classification: {
		category: 'support',
		priority: 'normal',
		sentiment: 'neutral',
		intent: 'question',
		confidence: 0.9,
	} as ClarifyInput['classification'],
};

function teamCtx(
	mode: 'off' | 'shadow' | 'enforce',
	fills: { questionId: string; value: string }[] = []
) {
	return makeStepCtx<Parameters<typeof clarifyStep.execute>[0]>({
		queries: {
			getAskEagernessInternal: { mode: null },
			getMessage: { contextCoverage: { lowCoverage: true }, contactId: 'contact_d5' },
			routingContext: policy(mode),
		},
		mutations: { recordClarificationAsk: undefined, resolveFills: { fills } },
	});
}

describe('Team clarify step with the necessity judgment enforced', () => {
	it('asks every open slot in one capped batch, keeping memory, with no sample', async () => {
		necessity('needed');
		const ctx = teamCtx('enforce', [{ questionId: 'clarify_1', value: '1,200 EUR' }]);
		const { output } = await clarifyStep.execute(ctx, teamInput);
		// Four open, relevant slots; the default cap is three, all in one batch.
		expect(output.questions.map((q) => q.id)).toEqual(['clarify_0', 'clarify_2']);
		expect(output.memoryAnswers).toMatchObject([
			{ id: 'clarify_1', answer: { value: '1,200 EUR', source: 'memory' } },
		]);
		expect(output.resolution).toBe('questions_emitted');
		expectNoSamplingAndNoCapableCall();
		expect(mocks.runBundle).toHaveBeenCalledTimes(1);
		expect(mocks.runBundle.mock.calls[0]![1]).toMatchObject({
			bundle: { id: 'mail.necessity' },
			plan: { task: 'mail.necessity', mode: 'advisory' },
			subject: { kind: 'inbound_message', inboundMessageId },
			root: { rootRequestId: `team:${inboundMessageId}` },
			built: { state: { thread: teamInput.context }, isComplete: false },
		});
	});

	it('asks nothing when the owner is not needed', async () => {
		necessity('not_needed');
		const { output } = await clarifyStep.execute(teamCtx('enforce'), teamInput);
		expect(output).toMatchObject({ questions: [], memoryAnswers: [], resolution: 'converged' });
		expectNoSamplingAndNoCapableCall();
	});

	it('asks nothing, and samples nothing, without an answer', async () => {
		necessity(null);
		const { output } = await clarifyStep.execute(teamCtx('enforce'), teamInput);
		expect(output).toMatchObject({ questions: [], resolution: 'necessity_unavailable' });
		expectNoSamplingAndNoCapableCall();
	});

	it('in shadow, today’s check decides and the judgment gets its answer as baseline', async () => {
		necessity('not_needed');
		const { output } = await clarifyStep.execute(teamCtx('shadow'), teamInput);
		expect(output.questions.map((q) => q.id)).toEqual(['clarify_1']); // the judge's pick
		expect(mocks.runLlmText).toHaveBeenCalledTimes(3);
		expect(mocks.runBundle.mock.calls[0]![1]).toMatchObject({
			plan: { task: 'mail.necessity', mode: 'shadow' },
			baseline: { necessity: 'needed' },
		});
	});

	it('off asks no necessity question at all', async () => {
		const { output } = await clarifyStep.execute(teamCtx('off'), teamInput);
		expect(output.questions.map((q) => q.id)).toEqual(['clarify_1']);
		expect(mocks.runBundle).not.toHaveBeenCalled();
	});
});

// ── Postbox ───────────────────────────────────────────────────────────────

const mailSubject = {
	kind: 'mail_message' as const,
	mailMessageId: 'mail_d5' as Id<'mailMessages'>,
	mailboxId: 'mbx_d5' as Id<'mailboxes'>,
};

function actionCtx(mode: 'off' | 'shadow' | 'enforce') {
	return {
		runQuery: vi.fn(async () => policy(mode)),
		runMutation: vi.fn(async () => ({ fills: [] })),
		runAction: vi.fn(),
	} as never;
}

describe('Postbox refinement with the necessity judgment enforced', () => {
	const opts = {
		transcript: 'Them: can we move the date, at what price, and which contract applies?',
		fromAddress: 'ada@acme.test',
		root: { rootRequestId: 'postbox:mail_d5' },
		subject: mailSubject,
	};

	it('asks the owed file and the open slots in one capped batch, on no capable call', async () => {
		necessity('needed');
		const flag = await refineClarification(actionCtx('enforce'), opts);
		// The safety filter's cap (three) bounds the batch, file first.
		expect(flag?.questions.map((q) => q.text)).toEqual([
			'Which contract should we send?',
			'Should we agree to the new date?',
			'What price should we quote?',
		]);
		expect(flag?.questions[0]).toMatchObject({ answerKind: 'file' });
		expectNoSamplingAndNoCapableCall();
		expect(mocks.runBundle.mock.calls[0]![1]).toMatchObject({
			subject: mailSubject,
			root: opts.root,
		});
	});

	it('keeps only the owed file without an answer', async () => {
		necessity(null);
		const flag = await refineClarification(actionCtx('enforce'), opts);
		expect(flag?.questions.map((q) => q.text)).toEqual(['Which contract should we send?']);
		expectNoSamplingAndNoCapableCall();
	});
});

// ── Answer mode ───────────────────────────────────────────────────────────

describe('Answer mode gap check with the necessity judgment enforced', () => {
	const input = {
		context: 'Them: can we move the date, at what price? Please send the contract.',
		triggerText: 'Please send the contract.',
		subject: 'Contract',
		counterpartAddress: 'ada@acme.test',
		locale: 'en',
		decisionSubject: mailSubject,
	};

	it('asks the file and the open slots in one batch, at interactive priority under `ai`', async () => {
		necessity('needed');
		const result = await runGapCheck(actionCtx('enforce'), input);
		expect(result.questions.map((q) => q.answerKind)).toEqual(['file', 'text', 'number']);
		expectNoSamplingAndNoCapableCall();
		expect(mocks.runBundle.mock.calls[0]![1]).toMatchObject({
			subject: mailSubject,
			masterGate: 'ai',
			priority: 'interactive',
		});
	});

	it('the cautious dial pays for no capable sample either', async () => {
		necessity('needed');
		await runGapCheck(actionCtx('enforce'), { ...input, eagerness: 'cautious' as const });
		expectNoSamplingAndNoCapableCall();
	});

	it('a fresh draft with no answered message asks only for the file', async () => {
		necessity('needed');
		const { decisionSubject: _omit, ...fresh } = input;
		const result = await runGapCheck(actionCtx('enforce'), fresh);
		expect(result.questions.map((q) => q.answerKind)).toEqual(['file']);
		expect(mocks.runBundle).not.toHaveBeenCalled();
		expectNoSamplingAndNoCapableCall();
	});
});

// ── Spend refusals: never a failed sample or judgment ────────────────

describe('a spend refusal during clarification', () => {
	const refusal = () => new AdmissionRefusedError('daily_ceiling', '$1.00');

	it('reaches the Team walker from a refused sample (the message is held)', async () => {
		mocks.runLlmText.mockRejectedValueOnce(refusal());
		await expect(clarifyStep.execute(teamCtx('off'), teamInput)).rejects.toBeInstanceOf(
			AdmissionRefusedError
		);
	});

	it('reaches the Team walker from a refused necessity call', async () => {
		mocks.runBundle.mockImplementation(
			async (_ctx: unknown, run: { onCallError?: (error: unknown) => void }) => {
				run.onCallError?.(refusal());
				return { hasRun: true, status: 'failed' };
			}
		);
		await expect(clarifyStep.execute(teamCtx('enforce'), teamInput)).rejects.toBeInstanceOf(
			AdmissionRefusedError
		);
	});

	it('defers the Postbox run instead of asking nothing', async () => {
		mocks.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
			if (schema === replySlotsSchema) return { object: { slots: SLOTS } };
			throw refusal(); // the divergence judge is refused
		});
		await expect(
			refineClarification(actionCtx('off'), {
				transcript: 'Them: can we move the date?',
				fromAddress: 'ada@acme.test',
				subject: mailSubject,
			})
		).rejects.toBeInstanceOf(AdmissionRefusedError);
	});

	it('surfaces the budget error in Answer mode', async () => {
		mocks.runBundle.mockImplementation(
			async (_ctx: unknown, run: { onCallError?: (error: unknown) => void }) => {
				run.onCallError?.(refusal());
				return { hasRun: true, status: 'failed' };
			}
		);
		await expect(
			runGapCheck(actionCtx('enforce'), {
				context: 'Them: what price?',
				triggerText: 'What price?',
				subject: 'Price',
				locale: 'en',
				decisionSubject: mailSubject,
			})
		).rejects.toMatchObject({ data: { data: { code: 'AI_BUDGET_EXHAUSTED' } } });
	});
});
