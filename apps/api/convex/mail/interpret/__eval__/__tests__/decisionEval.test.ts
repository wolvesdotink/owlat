/**
 * The decision runner with mocked providers (no network, no price), and the
 * scorer's arithmetic on a run whose answers are known.
 */
import { describe, expect, it } from 'vitest';
import type { DecisionAnswer, QuestionSet } from '../../../../lib/decision/questions';
import type {
	DecisionEndpointProvenance,
	DecisionResult,
	DecisionState,
} from '../../../../lib/decisionProviders/types';
import { DecisionWireError } from '../../../../lib/decisionProviders/wire';
import { LlmPartialUsageError } from '../../../../lib/llm/partialUsage';
import { estimateCost } from '../../../../lib/llm/pricing';
import type { EvalThread } from '../corpus';
import type { DecisionEvalTask, DecisionRun, EvalDecisionProvider } from '../decisionRun';
import { runDecisionEval } from '../decisionRunner';
import { scoreDecisionTask } from '../decisionScore';
import { loadCorpus } from './corpusFixture';

const corpus = loadCorpus();

/** Answers every question of a set through `pick`, stamped like a native adapter. */
function mockProvider(
	pick: (key: string, question: QuestionSet[string], state: DecisionState) => DecisionAnswer,
	options: {
		calibrated?: boolean;
		/** `true` throws a transient 503; an error is thrown as it is. */
		fail?: (call: number) => boolean | Error;
		provenance?: DecisionEndpointProvenance;
		isLocal?: boolean;
	} = {}
): EvalDecisionProvider & { states: DecisionState[]; calls: number } {
	const provider = {
		name: 'mock:decide-1',
		isLocal: options.isLocal ?? false,
		states: [] as DecisionState[],
		calls: 0,
		async ask({ state, questions }: { state: DecisionState; questions: QuestionSet }) {
			provider.calls++;
			provider.states.push(state);
			const failure = options.fail?.(provider.calls);
			if (failure instanceof Error) throw failure;
			if (failure) throw new Error('503 upstream unavailable');
			const answers = Object.fromEntries(
				Object.entries(questions).map(([key, q]) => [key, pick(key, q, state)])
			);
			return {
				answers,
				usage: { promptTokens: 400, completionTokens: 20, totalTokens: 420 },
				modelUsed: 'mock-decide-1',
				provenance: options.provenance ?? 'typesafe-native',
				calibrated: options.calibrated ?? true,
			} as DecisionResult;
		},
	};
	return provider;
}

const choiceAnswer = (value: string, confidence: number, options: string[]): DecisionAnswer => ({
	kind: 'choice',
	value,
	confidence,
	probabilities: Object.fromEntries(
		options.map((o) => [o, o === value ? confidence : (1 - confidence) / (options.length - 1)])
	),
});

/** Four threads with known labels (see the corpus files), all moved into held-out here. */
const PICKED: ReadonlySet<string> = new Set(['en-001', 'inj-002', 'cc-001', 'team-005']);
const small: EvalThread[] = corpus
	.filter((t) => PICKED.has(t.id))
	.map((t) => ({ ...t, split: 'heldout' as const }));

/** A provider that always says: needs work (0.6), person/support, informational, no owner input, acceptable. */
const constant = () =>
	mockProvider((key, question) => {
		if (question.type === 'choice') {
			const options = Object.keys(question.criteria);
			if (key === 'triage') return choiceAnswer('needs_work', 0.6, options);
			return choiceAnswer(options.includes('person') ? 'person' : 'support', 0.9, options);
		}
		const p = { disposition: 0.2, necessity: 0.3, acceptable: 0.9 }[key] ?? 0.5;
		return { kind: 'noul', probability: p };
	});

describe('runDecisionEval', () => {
	it('asks four kinds of round trip and records one ledger row per request', async () => {
		const provider = constant();
		const run = await runDecisionEval(small, { provider, split: 'heldout', now: () => 0 });
		// triage + message bundle per message (4 × 2), necessity on the 2 reply
		// messages, one per draft (2 + 1).
		expect(provider.calls).toBe(8 + 2 + 3);
		expect(run.rows).toHaveLength(13);
		const tasks = run.rows.map((r) => r.task);
		expect(tasks.filter((t) => t === 'mail.triage')).toHaveLength(4);
		expect(tasks.filter((t) => t === 'mail.category')).toHaveLength(4);
		expect(tasks.filter((t) => t === 'mail.necessity')).toHaveLength(2);
		expect(tasks.filter((t) => t === 'mail.draft_quality')).toHaveLength(3);
		expect(run.rows[0]).toMatchObject({
			plane: 'decision',
			rootRequestId: 'eval.decision.postbox:cc-001/m1',
			requestId: 'eval.decision.postbox:cc-001/m1#triage',
			attempt: 1,
			endpoint: 'typesafe-native',
			promptTokens: 400,
			latencyMs: 0,
		});
		expect(run.rows.find((r) => r.rootRequestId?.includes('team-005'))?.rootRequestId).toBe(
			'eval.decision.team:team-005/m1'
		);
		// An unknown model id is priced with the default and marked estimated.
		expect(run.rows.every((r) => r.isEstimated === true && r.costUsd > 0)).toBe(true);
	});

	it('never puts labels, label notes or internal team notes into a state', async () => {
		const provider = constant();
		await runDecisionEval(corpus, { provider, split: 'all' });
		const seen = JSON.stringify(provider.states);
		for (const thread of corpus) {
			for (const note of thread.internalNotes ?? []) expect(seen).not.toContain(note.text);
			for (const d of thread.labels.decisions) {
				for (const draft of d.drafts ?? []) expect(seen).not.toContain(draft.reason);
				for (const missing of d.clarification?.missing ?? []) expect(seen).not.toContain(missing);
			}
		}
		for (const word of ['"triage"', '"disposition"', 'needs_work', 'not_needed', '"acceptance"']) {
			expect(seen).not.toContain(word);
		}
	});

	it('retries an outage, then keeps the prediction as failed instead of wrong', async () => {
		const flakyProvider = mockProvider(
			(_, q) =>
				q.type === 'choice'
					? choiceAnswer(Object.keys(q.criteria)[0] as string, 0.5, Object.keys(q.criteria))
					: { kind: 'noul', probability: 0.5 },
			{ fail: (call) => call % 2 === 1 }
		);
		const sleeps: number[] = [];
		const sleep = async (ms: number) => {
			sleeps.push(ms);
		};
		const recovered = await runDecisionEval(small, {
			provider: flakyProvider,
			split: 'heldout',
			sleep,
		});
		expect(sleeps).toHaveLength(13);
		expect(sleeps.every((ms) => ms === 1000)).toBe(true);
		expect(recovered.predictions.every((p) => p.outcome === 'answered')).toBe(true);
		expect(recovered.rows.filter((r) => r.attempt === 2)).toHaveLength(13);

		const down = mockProvider(() => ({ kind: 'noul', probability: 1 }), { fail: () => true });
		const run = await runDecisionEval(small, {
			provider: down,
			split: 'heldout',
			maxAttempts: 3,
			sleep,
		});
		expect(run.predictions.every((p) => p.outcome === 'failed')).toBe(true);
		expect(run.predictions[0]?.error).toContain('503');
		// Necessity and drafts are still asked: outages do not change the call plan.
		expect(run.rows).toHaveLength(13 * 3);
		expect(run.rows.every((r) => r.isEstimated && r.costUsd === 0)).toBe(true);
		const report = scoreDecisionTask(small, run, 'disposition');
		expect(report).toMatchObject({ labelled: 4, answered: 0, failed: 4 });
		expect(report.accuracy.estimate).toBeNull();
	});

	it('prices a failed request off the billed usage its error carries', async () => {
		const usage = { promptTokens: 900, completionTokens: 40, totalTokens: 940 };
		const wire = mockProvider(() => ({ kind: 'noul', probability: 1 }), {
			fail: () =>
				new DecisionWireError('answer outside the option set', { usage, modelUsed: 'gpt-6-luna' }),
		});
		const run = await runDecisionEval(small, {
			provider: wire,
			split: 'heldout',
			sleep: async () => {},
		});
		// A codec refusal is terminal, as in the dispatch: one request per round trip.
		expect(run.rows).toHaveLength(13);
		const priced = estimateCost('gpt-6-luna', usage);
		expect(priced.costUsd).toBeGreaterThan(0);
		for (const row of run.rows) {
			expect(row).toMatchObject({
				...usage,
				modelUsed: 'gpt-6-luna',
				costUsd: priced.costUsd,
				isEstimated: priced.estimated,
			});
		}

		const partial = mockProvider(() => ({ kind: 'noul', probability: 1 }), {
			fail: () => new LlmPartialUsageError(new Error('503 overloaded'), usage, 'gpt-6-luna'),
		});
		const retried = await runDecisionEval(small, {
			provider: partial,
			split: 'heldout',
			sleep: async () => {},
		});
		// Transient, so retried; each billed attempt is its own priced row.
		expect(retried.rows).toHaveLength(26);
		expect(retried.rows.every((r) => r.promptTokens === 900 && r.costUsd === priced.costUsd)).toBe(
			true
		);

		// Usage the error cannot vouch for is no usage: unknown cost, marked estimated.
		const garbled = mockProvider(() => ({ kind: 'noul', probability: 1 }), {
			fail: () =>
				new DecisionWireError('bad', {
					usage: { promptTokens: -1, completionTokens: 2, totalTokens: 1 },
					modelUsed: 'gpt-6-luna',
				}),
		});
		const unknown = await runDecisionEval(small, {
			provider: garbled,
			split: 'heldout',
			sleep: async () => {},
		});
		expect(
			unknown.rows.every((r) => r.promptTokens === 0 && r.costUsd === 0 && r.isEstimated)
		).toBe(true);
	});

	it('does not retry a failure the decision dispatch would not retry', async () => {
		const refused = Object.assign(new Error('redirect refused'), { retriable: false });
		const terminal = mockProvider(() => ({ kind: 'noul', probability: 1 }), {
			fail: () => refused,
		});
		const sleeps: number[] = [];
		const run = await runDecisionEval(small, {
			provider: terminal,
			split: 'heldout',
			maxAttempts: 3,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(run.rows).toHaveLength(13);
		expect(sleeps).toEqual([]);
		const unauthorized = Object.assign(new Error('Unauthorized'), { status: 401 });
		const badKey = mockProvider(() => ({ kind: 'noul', probability: 1 }), {
			fail: () => unauthorized,
		});
		const once = await runDecisionEval(small, {
			provider: badKey,
			split: 'heldout',
			maxAttempts: 3,
		});
		expect(once.rows).toHaveLength(13);
	});

	it('records zero provider cost for the operator’s own engine, keeping the tokens', async () => {
		const local = mockProvider(
			(_, q) =>
				q.type === 'choice'
					? choiceAnswer(Object.keys(q.criteria)[0] as string, 0.5, Object.keys(q.criteria))
					: { kind: 'noul', probability: 0.5 },
			{ provenance: 'local', isLocal: true, calibrated: false }
		);
		const run = await runDecisionEval(small, { provider: local, split: 'heldout' });
		expect(run.rows).toHaveLength(13);
		for (const row of run.rows) {
			expect(row).toMatchObject({
				promptTokens: 400,
				costUsd: 0,
				isEstimated: false,
				isLocalEngine: true,
				endpoint: 'local',
			});
		}
		// A local engine's failed request is free too.
		const localDown = mockProvider(() => ({ kind: 'noul', probability: 1 }), {
			isLocal: true,
			fail: () => true,
		});
		const failed = await runDecisionEval(small, {
			provider: localDown,
			split: 'heldout',
			sleep: async () => {},
		});
		expect(
			failed.rows.every((r) => r.costUsd === 0 && r.isLocalEngine === true && !r.isEstimated)
		).toBe(true);
		// The answer's own provenance counts even when the provider did not say.
		const unflagged = mockProvider(() => ({ kind: 'noul', probability: 1 }), {
			provenance: 'local',
		});
		const priced = await runDecisionEval(small, { provider: unflagged, split: 'heldout' });
		expect(priced.rows.every((r) => r.costUsd === 0)).toBe(true);
	});

	it('fails a prediction whose answer has the wrong kind', async () => {
		const confused = mockProvider(() => ({ kind: 'noul', probability: 0.5 }));
		const run = await runDecisionEval(small, { provider: confused, split: 'heldout' });
		const triage = run.predictions.filter((p) => p.task === 'triage');
		expect(triage.every((p) => p.outcome === 'failed' && /not a choice/.test(p.error ?? ''))).toBe(
			true
		);
		expect(
			run.predictions.filter((p) => p.task === 'disposition').every((p) => p.outcome === 'answered')
		).toBe(true);
	});
});

describe('scoreDecisionTask', () => {
	let run: DecisionRun;
	const score = async (task: DecisionEvalTask, options = {}) => {
		run ??= await runDecisionEval(small, { provider: constant(), split: 'heldout' });
		return scoreDecisionTask(small, run, task, options);
	};

	it('scores a Choice task on Choice peakedness', async () => {
		const triage = await score('triage');
		expect(triage).toMatchObject({
			questionType: 'choice',
			probability: 'choice_peakedness',
			threshold: null,
			labelled: 4,
			answered: 4,
			failed: 0,
		});
		// needs_work is right for en-001 and team-005, wrong for inj-002 (spam) and cc-001 (no_work).
		expect(triage.accuracy).toMatchObject({ successes: 2, n: 4, estimate: 0.5 });
		expect(triage.perClass['needs_work']?.recall.estimate).toBe(1);
		expect(triage.perClass['spam']?.recall.estimate).toBe(0);
		expect(triage.calibration.brier).toBeCloseTo((0.16 + 0.36 + 0.36 + 0.16) / 4, 10);
		expect(triage.calibration.distributionBrier).not.toBeNull();
		expect(triage.calibration.adapters).toBe('calibrated');
		// Predicting needs_work never sends mail to spam or skips work.
		expect(triage.consequential.errors).toEqual([]);
		expect(triage.consequential.upper95WhenNoneObserved).toBeCloseTo(1 - 0.05 ** (1 / 4), 10);
		expect(Object.keys(triage.byLanguage).sort()).toEqual(['en']);
	});

	it('scores a Noul task on the Noul probability, at the threshold given', async () => {
		const disposition = await score('disposition');
		expect(disposition).toMatchObject({ probability: 'noul_probability', threshold: 0.5 });
		expect(disposition.accuracy.estimate).toBe(0.5);
		expect(disposition.calibration.brier).toBeCloseTo((0.64 + 0.04 + 0.04 + 0.64) / 4, 10);
		expect(disposition.consequential.errors.map((e) => e.threadId).sort()).toEqual([
			'en-001',
			'team-005',
		]);
		expect(disposition.consequential.errors[0]).toMatchObject({
			label: 'reply',
			predicted: 'informational',
			probability: 0.2,
		});
		const lenient = await score('disposition', { thresholds: { disposition: 0.1 } });
		expect(lenient.threshold).toBe(0.1);
		expect(lenient.consequential.errors).toEqual([]);
		expect(lenient.perClass['reply']?.recall.estimate).toBe(1);
	});

	it('scores necessity on reply messages and drafts one by one', async () => {
		const necessity = await score('necessity');
		expect(necessity.labelled).toBe(2);
		expect(necessity.consequential.errors).toHaveLength(2);
		const drafts = await score('draft_quality');
		expect(drafts.labelled).toBe(3);
		expect(drafts.accuracy.estimate).toBe(0);
		// The edited draft is a wrong answer but not a consequential one.
		expect(drafts.consequential.errors.map((e) => `${e.threadId}/${e.draftId}`).sort()).toEqual([
			'en-001/d2',
			'team-005/d1',
		]);
	});

	it('compares with today’s classifier when it ran on the same split', async () => {
		await score('triage');
		const baseline: DecisionRun = {
			executor: 'today (heuristic + model)',
			split: 'heldout',
			rows: [],
			predictions: [
				{
					task: 'triage',
					threadId: 'en-001',
					messageId: 'm1',
					locale: 'en',
					outcome: 'answered',
					value: 'needs_work',
				},
				{
					task: 'triage',
					threadId: 'inj-002',
					messageId: 'm1',
					locale: 'en',
					outcome: 'answered',
					value: 'spam',
				},
				{
					task: 'triage',
					threadId: 'cc-001',
					messageId: 'm1',
					locale: 'en',
					outcome: 'answered',
					value: 'needs_work',
				},
				{
					task: 'triage',
					threadId: 'team-005',
					messageId: 'm1',
					locale: 'en',
					outcome: 'failed',
					error: 'x',
				},
			],
		};
		const triage = scoreDecisionTask(small, run, 'triage', { baseline });
		expect(triage.baseline).toMatchObject({
			executor: 'today (heuristic + model)',
			answered: 3,
			failed: 1,
		});
		expect(triage.baseline?.accuracy.estimate).toBeCloseTo(2 / 3, 10);
		expect(triage.agreement).toMatchObject({ compared: 3 });
		expect(triage.agreement?.rate.estimate).toBeCloseTo(2 / 3, 10);
		expect(triage.agreement?.confusion).toEqual({ needs_work: { needs_work: 2, spam: 1 } });
		// Today's classifier never answers drafts: no baseline, no agreement.
		const drafts = scoreDecisionTask(small, run, 'draft_quality', { baseline });
		expect(drafts.baseline).toBeNull();
		expect(drafts.agreement).toBeNull();
	});

	it('says when the answering adapters were not calibrated', async () => {
		const llmLike = mockProvider(
			(key, q) =>
				q.type === 'choice'
					? choiceAnswer(Object.keys(q.criteria)[0] as string, 1, Object.keys(q.criteria))
					: { kind: 'noul', probability: key === 'disposition' ? 1 : 0 },
			{ calibrated: false }
		);
		const uncalibrated = await runDecisionEval(small, { provider: llmLike, split: 'heldout' });
		expect(scoreDecisionTask(small, uncalibrated, 'triage').calibration.adapters).toBe(
			'uncalibrated'
		);
	});
});
