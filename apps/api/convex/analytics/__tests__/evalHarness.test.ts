import { describe, it, expect } from 'vitest';
import {
	GOLDEN_SET,
	scoreDraft,
	runEvalSuite,
	detectRegression,
	calibrateThreshold,
	type LabelledOutcome,
} from '../evalHarness';
import {
	aggregateClarifyMetrics,
	aggregateDraftQuality,
	type ClarifyAskRow,
	type ShadowDecisionRow,
} from '../qualityMetrics';

describe('scoreDraft', () => {
	it('scores an identical draft as zero edit-distance', () => {
		const { similarity, editDistance } = scoreDraft('hello there friend', 'hello there friend');
		expect(similarity).toBe(1);
		expect(editDistance).toBe(0);
	});

	it('scores a fully different draft as high edit-distance', () => {
		const { similarity, editDistance } = scoreDraft('yes absolutely', 'no never at all');
		expect(similarity).toBeLessThan(0.3);
		expect(editDistance).toBeGreaterThan(0.7);
	});
});

describe('runEvalSuite (golden set)', () => {
	it('reports perfect similarity when candidates equal the ideal replies', () => {
		const candidates = new Map(GOLDEN_SET.map((c) => [c.id, c.idealReply]));
		const result = runEvalSuite(candidates);
		expect(result.scoredCount).toBe(GOLDEN_SET.length);
		expect(result.meanSimilarity).toBe(1);
		expect(result.meanEditDistance).toBe(0);
		expect(result.minSimilarity).toBe(1);
	});

	it('marks a missing candidate as unscored with worst-case distance', () => {
		const [first, ...rest] = GOLDEN_SET;
		const candidates = new Map(rest.map((c) => [c.id, c.idealReply]));
		const result = runEvalSuite(candidates);
		const missing = result.cases.find((c) => c.id === first!.id)!;
		expect(missing.scored).toBe(false);
		expect(missing.editDistance).toBe(1);
		expect(result.scoredCount).toBe(GOLDEN_SET.length - 1);
	});

	it('drops the mean when a draft diverges from the ideal reply', () => {
		const candidates = new Map(GOLDEN_SET.map((c) => [c.id, c.idealReply]));
		candidates.set(GOLDEN_SET[0]!.id, 'completely unrelated words here nothing alike');
		const result = runEvalSuite(candidates);
		expect(result.meanSimilarity).toBeLessThan(1);
		expect(result.minSimilarity).toBeLessThan(0.5);
	});
});

describe('detectRegression', () => {
	const baseline = { meanSimilarity: 0.9 };

	it('passes a run that holds the baseline', () => {
		const candidates = new Map(GOLDEN_SET.map((c) => [c.id, c.idealReply]));
		const report = detectRegression(runEvalSuite(candidates), baseline);
		expect(report.regressed).toBe(false);
		expect(report.failingCases).toHaveLength(0);
	});

	it('detects a prompt regression that tanks a case below the floor', () => {
		const candidates = new Map(GOLDEN_SET.map((c) => [c.id, c.idealReply]));
		// Simulate a bad prompt: one draft becomes garbage.
		candidates.set(GOLDEN_SET[1]!.id, 'lorem ipsum dolor sit amet');
		const report = detectRegression(runEvalSuite(candidates), baseline);
		expect(report.regressed).toBe(true);
		expect(report.failingCases).toContain(GOLDEN_SET[1]!.id);
	});

	it('detects an aggregate mean drop beyond tolerance even with no floor breach', () => {
		// A run whose mean sits well under baseline but every case stays >= floor.
		const result = {
			cases: [
				{ id: 'a', category: 'x', similarity: 0.7, editDistance: 0.3, scored: true },
				{ id: 'b', category: 'x', similarity: 0.7, editDistance: 0.3, scored: true },
			],
			meanSimilarity: 0.7,
			meanEditDistance: 0.3,
			minSimilarity: 0.7,
			scoredCount: 2,
		};
		const report = detectRegression(result, baseline);
		expect(report.regressed).toBe(true);
		expect(report.meanDrop).toBeCloseTo(0.2, 5);
		expect(report.failingCases).toHaveLength(0);
	});
});

describe('calibrateThreshold', () => {
	it('falls back to the safe default on thin data (never loosens)', () => {
		const outcomes: LabelledOutcome[] = [
			{ similarity: 0.99, acceptedUnedited: true },
			{ similarity: 0.4, acceptedUnedited: false },
		];
		const result = calibrateThreshold(outcomes, 0.95);
		expect(result.suggestedThreshold).toBe(0.95);
		expect(result.sampleSize).toBe(2);
	});

	it('finds a separating threshold from labelled outcomes', () => {
		// Cleanly separable: accepts cluster high, edits cluster low.
		const outcomes: LabelledOutcome[] = [];
		for (let i = 0; i < 15; i++) outcomes.push({ similarity: 0.9 + Math.random() * 0.1, acceptedUnedited: true });
		for (let i = 0; i < 15; i++) outcomes.push({ similarity: Math.random() * 0.5, acceptedUnedited: false });
		const result = calibrateThreshold(outcomes);
		expect(result.sampleSize).toBe(30);
		expect(result.accuracy).toBeGreaterThan(0.95);
		// The cut should land in the gap between the two clusters.
		expect(result.suggestedThreshold).toBeGreaterThan(0.5);
		expect(result.suggestedThreshold).toBeLessThanOrEqual(0.9);
	});
});

describe('aggregateClarifyMetrics', () => {
	it('returns zeroed metrics for an empty window', () => {
		const m = aggregateClarifyMetrics([]);
		expect(m.askCount).toBe(0);
		expect(m.questionRate).toBe(0);
		expect(m.answerDeltaRate).toBe(0);
	});

	it('computes question-rate, answer-delta and divergence', () => {
		const rows: ClarifyAskRow[] = [
			{ source: 'agent', questionCount: 2, predictedValue: 0.8 },
			{ source: 'reply_queue', questionCount: 1, predictedValue: 0.6, isDraftChanged: true, draftDivergence: 0.4 },
			{ source: 'reply_queue', questionCount: 3, predictedValue: 0.4, isDraftChanged: false, draftDivergence: 0.05 },
		];
		const m = aggregateClarifyMetrics(rows);
		expect(m.askCount).toBe(3);
		expect(m.questionRate).toBeCloseTo(2, 5); // (2 + 1 + 3) / 3
		expect(m.meanPredictedValue).toBeCloseTo(0.6, 5);
		expect(m.answeredCount).toBe(2);
		expect(m.answerDeltaRate).toBe(0.5); // 1 of 2 answered asks changed the draft
		expect(m.meanDraftDivergence).toBeCloseTo(0.225, 5); // (0.4 + 0.05) / 2
	});
});

describe('aggregateDraftQuality', () => {
	it('ignores unresolved decisions', () => {
		const rows: ShadowDecisionRow[] = [
			{ sender: 'a@x.com', isResolved: false },
		];
		const m = aggregateDraftQuality(rows);
		expect(m.sampleCount).toBe(0);
		expect(m.bySender).toHaveLength(0);
	});

	it('computes the draft->sent edit-distance north-star and accept rate per sender', () => {
		const rows: ShadowDecisionRow[] = [
			{ sender: 'a@x.com', isResolved: true, userAction: 'approved', similarity: 1 },
			{ sender: 'a@x.com', isResolved: true, userAction: 'edited', similarity: 0.6 },
			{ sender: 'b@y.com', isResolved: true, userAction: 'rejected', similarity: 0.2 },
		];
		const m = aggregateDraftQuality(rows);
		expect(m.sampleCount).toBe(3);
		expect(m.meanSimilarity).toBeCloseTo((1 + 0.6 + 0.2) / 3, 5);
		expect(m.meanEditDistance).toBeCloseTo(1 - (1 + 0.6 + 0.2) / 3, 5);
		expect(m.acceptRate).toBeCloseTo(1 / 3, 5); // one approved of three reconciled

		// Worst edit-distance sender first.
		expect(m.bySender[0]!.sender).toBe('b@y.com');
		const a = m.bySender.find((s) => s.sender === 'a@x.com')!;
		expect(a.samples).toBe(2);
		expect(a.meanSimilarity).toBeCloseTo(0.8, 5);
		expect(a.acceptRate).toBe(0.5);
	});
});
