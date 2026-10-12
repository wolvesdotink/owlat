/**
 * The cheap-first writer (plan Phase 4, D2) end to end through the real meter,
 * dispatch, self-check, admission and ledger mutations (a convex-test
 * instance behind an action ctx). The SDK is scripted per model.
 *
 * Pinned: the whole path (fast draft, its check, the escalation, its check)
 * is held before the first call, every call runs under that one hold, and it
 * settles once against the requests made; a fast draft that passes, or whose
 * verdict is unknown, is kept; a failing or unusable one is escalated ONCE; a
 * provider failure (401, 403) or a configuration failure buys no escalation;
 * a refused hold, also at the ceiling under concurrency, spends nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';

const sdk = vi.hoisted(() => ({ generateText: vi.fn(), generateObject: vi.fn() }));

vi.mock('ai', async () => ({
	...(await vi.importActual<object>('ai')),
	generateText: (args: unknown) => sdk.generateText(args),
	generateObject: (args: unknown) => sdk.generateObject(args),
}));
vi.mock('../../../lib/llmProvider', async (importActual) => {
	const { stampModelEndpoint } = await import('../../../lib/llm/modelEndpoint');
	const check = stampModelEndpoint(
		{ modelId: 'gpt-4.1-nano', specificationVersion: 'v2' } as never,
		'openai-native',
		{ tier: 'fast' }
	);
	return {
		...(await importActual<object>()),
		resolveLanguageModel: vi.fn(async (_ctx: unknown, task: string) => {
			if (task !== 'mail.draft_check') throw new Error(`unexpected resolve: ${task}`);
			return check;
		}),
	};
});

import { newHarness } from '../../../__tests__/testModules';
import { actionCtxOver, reconcileSpend } from '../../../aiRouting/__tests__/spend.testlib';
import { stampModelEndpoint } from '../../../lib/llm/modelEndpoint';
import { AdmissionRefusedError } from '../../../lib/llm/admissionPort';
import { AiNotConfiguredError } from '../../../lib/aiNotConfigured';
import { runSharedDraft, type SharedDraftParams } from '../draftService';
import { CHEAP_FIRST_ACCEPT_SCORE, failsCheapFirst, passesCheapFirst } from '../cheapFirstDraft';

const fast = stampModelEndpoint(
	{ modelId: 'gpt-4o-mini', specificationVersion: 'v2' } as never,
	'openai-native',
	{ tier: 'fast' }
);
const capable = stampModelEndpoint(
	{ modelId: 'gpt-4o', specificationVersion: 'v2' } as never,
	'openai-native',
	{ tier: 'capable' }
);
const usage = (input: number, output: number) => ({
	inputTokens: input,
	outputTokens: output,
	totalTokens: input + output,
});
const good = { score: 0.92, complete: true, grounded: true, flags: [] };
const weak = { score: 0.55, complete: false, grounded: true, flags: ['misses the date'] };
const reply = (text: string) => ({ text, usage: usage(1_000, 200), finishReason: 'stop' });
const verdict = (quality: object) => ({
	object: quality,
	usage: usage(500, 50),
	finishReason: 'stop',
});
const httpError = (statusCode: number) =>
	new APICallError({
		message: `HTTP ${statusCode}`,
		url: 'https://api.openai.com/v1/responses',
		requestBodyValues: {},
		statusCode,
		isRetryable: false,
	});

/** Script the drafts by model (in order) and the checks (in order). */
function provider(script: { fast?: unknown[]; capable?: unknown[]; checks?: unknown[] }) {
	const drafts: Record<string, unknown[]> = {
		'gpt-4o-mini': [...(script.fast ?? [])],
		'gpt-4o': [...(script.capable ?? [])],
	};
	const checks = [...(script.checks ?? [])];
	const next = (queue: unknown[] | undefined, what: string) => {
		const item = queue?.shift();
		if (item instanceof Error) throw item;
		if (item === undefined) throw new Error(`unscripted ${what}`);
		return item;
	};
	sdk.generateText.mockImplementation(async (args: { model: { modelId: string } }) =>
		next(drafts[args.model.modelId], `draft by ${args.model.modelId}`)
	);
	sdk.generateObject.mockImplementation(async () => next(checks, 'check'));
}
const draftsBy = () =>
	sdk.generateText.mock.calls.map(
		([args]) => (args as { model: { modelId: string } }).model.modelId
	);

function params(over: Partial<SharedDraftParams> = {}): SharedDraftParams {
	return {
		surface: 'organization',
		resolveModel: async () => fast,
		writer: { resolveCapable: async () => capable },
		audience: 'an organization',
		styleReference: "the organization's",
		context: 'From: sam@acme.test\nSubject: Thanks\nThanks, the invoice arrived.',
		classification: {
			category: 'general',
			intent: 'information',
			sentiment: 'positive',
			priority: 'low',
		},
		toneInstruction: '',
		signatureInstruction: '',
		voiceSection: '',
		spendLabels: { draft: 'agent_draft', selfCheck: 'agent_draft_selfcheck' },
		root: { rootRequestId: 'team:m1' },
		...over,
	};
}

async function setup(dailyUsd?: string) {
	if (dailyUsd !== undefined) vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', dailyUsd);
	const t = newHarness();
	if (dailyUsd !== undefined) await reconcileSpend(t);
	return { t, ...actionCtxOver(t) };
}
type T = ReturnType<typeof newHarness>;
const reservations = (t: T) => t.run((c) => c.db.query('llmReservations').collect());
const rows = (t: T) =>
	t.run(async (c) =>
		(await c.db.query('llmUsageEvents').collect()).filter((row) =>
			['agent_draft', 'agent_draft_selfcheck'].includes(row.feature)
		)
	);

beforeEach(() => {
	sdk.generateText.mockReset();
	sdk.generateObject.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('the cheap-first verdict rules', () => {
	it('keeps a complete, grounded draft at or above the bar, and escalates only on a definite failing verdict', () => {
		expect(passesCheapFirst(good)).toBe(true);
		expect(passesCheapFirst({ ...good, score: CHEAP_FIRST_ACCEPT_SCORE })).toBe(true);
		expect(failsCheapFirst({ ...good, score: CHEAP_FIRST_ACCEPT_SCORE - 0.01 })).toBe(true);
		expect(failsCheapFirst({ ...good, complete: false })).toBe(true);
		expect(failsCheapFirst({ ...good, grounded: false })).toBe(true);
		// An unknown verdict is not a failing one.
		expect(failsCheapFirst(null)).toBe(false);
		expect(passesCheapFirst(null)).toBe(false);
	});
});

describe('runSharedDraft with the cheap-first writer', () => {
	it('keeps a fast draft that passes; both calls run under the one path hold', async () => {
		const { t, ctx } = await setup('10');
		provider({ fast: [reply('Glad it arrived.')], checks: [verdict(good)] });

		const out = await runSharedDraft(ctx, params());

		expect(out).toMatchObject({ draftBody: 'Glad it arrived.', draftQuality: good });
		expect(draftsBy()).toEqual(['gpt-4o-mini']);
		const holds = await reservations(t);
		expect(holds).toEqual([expect.objectContaining({ status: 'settled', task: 'mail.draft' })]);
		const written = await rows(t);
		expect(written).toHaveLength(2);
		expect(written.every((row) => row.reservationId === holds[0]!.reservationId)).toBe(true);
		expect(written.find((row) => row.feature === 'agent_draft')).toMatchObject({
			modelUsed: 'gpt-4o-mini',
			qualityResult: 'passed',
		});
	});

	it('escalates a failing fast draft ONCE, every call under the hold taken before the first', async () => {
		const { t, ctx } = await setup('10');
		let heldBeforeFirstCall = false;
		provider({
			capable: [reply('Thanks Sam, glad the invoice arrived.')],
			checks: [verdict(weak), verdict(weak)],
		});
		sdk.generateText.mockImplementationOnce(async () => {
			heldBeforeFirstCall = (await reservations(t)).some((hold) => hold.status === 'held');
			return reply('ok.');
		});

		const out = await runSharedDraft(ctx, params());

		expect(heldBeforeFirstCall).toBe(true);
		expect(draftsBy()).toEqual(['gpt-4o-mini', 'gpt-4o']);
		expect(sdk.generateObject).toHaveBeenCalledTimes(2);
		expect(out).toMatchObject({
			draftBody: 'Thanks Sam, glad the invoice arrived.',
			draftQuality: weak,
			modelUsed: 'gpt-4o',
			tokenUsage: { promptTokens: 2_000, completionTokens: 400, totalTokens: 2_400 },
		});
		const [hold, ...others] = await reservations(t);
		expect(others).toEqual([]);
		expect(hold!.status).toBe('settled');
		const written = await rows(t);
		expect(written).toHaveLength(4);
		expect(written.every((row) => row.reservationId === hold!.reservationId)).toBe(true);
		const fastRow = written.find((row) => row.modelUsed === 'gpt-4o-mini')!;
		expect(fastRow).toMatchObject({ qualityResult: 'escalated', rootRequestId: 'team:m1' });
		expect(written.find((row) => row.modelUsed === 'gpt-4o')).toMatchObject({
			qualityResult: 'failed',
			parentCallId: fastRow.requestId,
			task: 'mail.draft',
		});
	});

	it('escalates a fast draft that is tool-call markup, without a retry', async () => {
		const { ctx } = await setup('10');
		provider({
			fast: [reply('<invoke name="recallKnowledge"><parameter name="q">x</parameter></invoke>')],
			capable: [reply('Thanks Sam.')],
			checks: [verdict(good)],
		});

		const out = await runSharedDraft(ctx, params());

		expect(out.draftBody).toBe('Thanks Sam.');
		expect(draftsBy()).toEqual(['gpt-4o-mini', 'gpt-4o']);
	});

	it('keeps the fast draft when its verdict is unknown (the check failed)', async () => {
		const { ctx } = await setup('10');
		provider({ fast: [reply('ok.')], checks: [new Error('bad schema')] });

		const out = await runSharedDraft(ctx, params());

		expect(out).toMatchObject({ draftBody: 'ok.', draftQuality: null });
		expect(draftsBy()).toEqual(['gpt-4o-mini']);
	});

	it.each([401, 403])(
		'a fast pass that fails with HTTP %i ends the writer with no paid escalation',
		async (status) => {
			const { t, ctx } = await setup('10');
			provider({ fast: [httpError(status)] });

			await expect(runSharedDraft(ctx, params())).rejects.toMatchObject({ statusCode: status });

			expect(draftsBy()).toEqual(['gpt-4o-mini']);
			expect(sdk.generateObject).not.toHaveBeenCalled();
			expect((await rows(t)).filter((row) => row.modelUsed === 'gpt-4o')).toEqual([]);
			expect(await reservations(t)).toEqual([expect.objectContaining({ status: 'settled' })]);
		}
	);

	it('a configuration failure ends the writer before any hold or request', async () => {
		const { t, ctx } = await setup('10');
		const out = runSharedDraft(
			ctx,
			params({
				resolveModel: async () => {
					throw new AiNotConfiguredError();
				},
			})
		);
		await expect(out).rejects.toBeInstanceOf(AiNotConfiguredError);
		expect(sdk.generateText).not.toHaveBeenCalled();
		expect(await reservations(t)).toEqual([]);
	});

	it('leaves the usable fast draft when the escalation fails, and settles on what was sent', async () => {
		const { t, ctx } = await setup('10');
		provider({
			fast: [reply('ok.')],
			capable: [httpError(500), httpError(500), httpError(500)],
			checks: [verdict(weak)],
		});

		const out = await runSharedDraft(ctx, params());

		expect(out).toMatchObject({ draftBody: 'ok.', draftQuality: weak, modelUsed: 'gpt-4o-mini' });
		expect(await reservations(t)).toEqual([expect.objectContaining({ status: 'settled' })]);
		expect((await rows(t)).filter((row) => row.modelUsed === 'gpt-4o')).toHaveLength(3);
	});

	it('refuses before any request when the whole path does not fit (D1)', async () => {
		const { t, ctx } = await setup('0.0001');
		provider({ fast: [reply('ok.')] });

		await expect(runSharedDraft(ctx, params())).rejects.toBeInstanceOf(AdmissionRefusedError);
		expect(sdk.generateText).not.toHaveBeenCalled();
		expect(await reservations(t)).toHaveLength(0);
		expect(await rows(t)).toHaveLength(0);
	});

	it('at the ceiling, a second path is refused before any paid call while the first runs to the end', async () => {
		// Measure one path's hold, then allow the standard class 1.5 of them.
		const probe = await setup('100');
		provider({ fast: [reply('ok.')], checks: [verdict(good)] });
		await runSharedDraft(probe.ctx, params());
		const [measured] = await reservations(probe.t);
		const pathUsd = measured!.heldMicrousd / 1_000_000;
		vi.unstubAllEnvs();
		sdk.generateText.mockReset();
		sdk.generateObject.mockReset();

		// The triage allowance keeps 10% of the ceiling from standard work.
		const { t, ctx } = await setup(String((1.5 * pathUsd) / 0.9));
		let second: unknown;
		provider({ capable: [reply('Thanks Sam.')], checks: [verdict(weak), verdict(good)] });
		sdk.generateText.mockImplementationOnce(async () => {
			// The first path is mid-flight with its whole path held.
			second = await runSharedDraft(ctx, params()).catch((error: unknown) => error);
			return reply('ok.');
		});

		const first = await runSharedDraft(ctx, params());

		expect(second).toBeInstanceOf(AdmissionRefusedError);
		expect(first.draftBody).toBe('Thanks Sam.');
		// Two drafts and two checks, all the first path's: the second sent nothing.
		expect(draftsBy()).toEqual(['gpt-4o-mini', 'gpt-4o']);
		expect(sdk.generateObject).toHaveBeenCalledTimes(2);
		const holds = await reservations(t);
		expect(holds).toEqual([expect.objectContaining({ status: 'settled' })]);
		expect((await rows(t)).every((row) => row.reservationId === holds[0]!.reservationId)).toBe(
			true
		);
	});

	it('holds nothing without a ceiling (the default posture)', async () => {
		const { t, ctx } = await setup();
		provider({
			fast: [reply('ok.')],
			capable: [reply('Thanks Sam.')],
			checks: [verdict(weak), verdict(good)],
		});

		const out = await runSharedDraft(ctx, params());

		expect(out.draftBody).toBe('Thanks Sam.');
		expect(await reservations(t)).toHaveLength(0);
		expect(await rows(t)).toHaveLength(4);
	});

	it('is today’s one generation, with no quality result, without the writer', async () => {
		const { t, ctx } = await setup('10');
		provider({ fast: [reply('ok.')], checks: [verdict(weak)] });

		const out = await runSharedDraft(ctx, params({ writer: undefined }));

		expect(out).toMatchObject({ draftBody: 'ok.', draftQuality: weak });
		expect(draftsBy()).toEqual(['gpt-4o-mini']);
		const draftRows = (await rows(t)).filter((row) => row.feature === 'agent_draft');
		expect(draftRows).toHaveLength(1);
		expect(draftRows[0]!.qualityResult).toBeUndefined();
	});
});
