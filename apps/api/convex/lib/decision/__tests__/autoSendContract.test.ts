/**
 * The auto-send contract for decision verdicts: a verdict reaches
 * `resolveAutoApproveScore` only as an admitted score, which needs a feeding
 * task, item coverage enforced, the block-only rule's compatible provenance
 * and valid calibration, and a probability; and it can only lower the score.
 * Nothing feeds it today.
 */

import { describe, expect, it } from 'vitest';
import {
	admitVerdictScore,
	decisionAutonomyProblem,
	restrictedAutoApproveScore,
	type AdmittedVerdictScore,
	type AutoSendContractContext,
} from '../autoSendContract';
import { AUTO_SEND_VERDICT_TASKS, CALIBRATION_REVISIONS, type StoredVerdict } from '../calibration';
import { resolveAutoApproveScore } from '../../../agent/steps/route';

const NOW = 1_800_000_000_000;
const IDENTITY = 'typesafe|jev-1.13.0|';
const REGISTRY = { 'mail.draft_quality': { en: 'baseline-2026-11' } };

const verdict: StoredVerdict = {
	task: 'mail.draft_quality',
	kind: 'advisory',
	status: 'complete',
	policyVersion: 4,
	contextVersion: IDENTITY,
	expiresAt: NOW + 60_000,
	provenance: { provider: 'typesafe' },
	calibration: {
		isAdapterCalibrated: true,
		calibrationRevision: 'baseline-2026-11',
		language: 'en',
	},
};

/** A context in which everything the contract asks for holds. */
const feeding: AutoSendContractContext = {
	now: NOW,
	policyVersion: 4,
	decisionConfigIdentity: IDENTITY,
	language: 'en',
	registry: REGISTRY,
	isItemCoverageEnforced: true,
	verdictTasks: ['mail.draft_quality'],
};

const draft = (score: number) => ({ score, complete: true, grounded: true, flags: [] });

describe('nothing feeds the auto-send score today', () => {
	it('has no feeding task and no calibration revision checked in', () => {
		expect(AUTO_SEND_VERDICT_TASKS).toEqual([]);
		expect(CALIBRATION_REVISIONS).toEqual({});
	});

	it('refuses even a perfect verdict under the checked-in registries', () => {
		const { verdictTasks: _tasks, registry: _registry, ...checkedIn } = feeding;
		expect(admitVerdictScore(verdict, 0.1, checkedIn)).toBeNull();
		expect(admitVerdictScore(verdict, 0.1, { ...checkedIn, registry: REGISTRY })).toBeNull();
	});

	it('leaves resolveAutoApproveScore exactly today’s', () => {
		for (const score of [0, 0.31, 0.8, 0.95, 1]) {
			expect(resolveAutoApproveScore(draft(score))).toBe(score);
		}
		expect(resolveAutoApproveScore(null)).toBe(0);
		expect(resolveAutoApproveScore(undefined)).toBe(0);
	});
});

describe('admitVerdictScore', () => {
	it('admits a feeding task’s current, calibrated verdict with item coverage enforced', () => {
		expect(admitVerdictScore(verdict, 0.4, feeding)).toMatchObject({
			task: 'mail.draft_quality',
			score: 0.4,
		});
	});

	it.each<[string, Partial<StoredVerdict>, Partial<AutoSendContractContext>]>([
		['a task that does not feed auto-send', {}, { verdictTasks: ['mail.category'] }],
		['item coverage not enforced (the prerequisite)', {}, { isItemCoverageEnforced: false }],
		[
			'an uncalibrated adapter',
			{ calibration: { isAdapterCalibrated: false, language: 'en' } },
			{},
		],
		[
			'a stale calibration revision',
			{ calibration: { ...verdict.calibration!, calibrationRevision: 'old' } },
			{},
		],
		['another decision provider', { contextVersion: 'local||' }, {}],
		['another language', {}, { language: 'de' }],
		['a shadow observation', { kind: 'shadow' }, {}],
		['an expired verdict', { expiresAt: NOW }, {}],
		['an older routing policy', { policyVersion: 3 }, {}],
	])('refuses %s', (_name, verdictOver, contextOver) => {
		expect(
			admitVerdictScore({ ...verdict, ...verdictOver }, 0.4, { ...feeding, ...contextOver })
		).toBeNull();
	});

	it('refuses a score that is not a probability', () => {
		for (const score of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(admitVerdictScore(verdict, score, feeding)).toBeNull();
		}
	});
});

describe('a verdict can only lower the score', () => {
	const admitted = (score: number) =>
		admitVerdictScore(verdict, score, feeding) as AdmittedVerdictScore;

	it('takes the minimum of the draft’s score and every admitted verdict', () => {
		expect(resolveAutoApproveScore(draft(0.9), [admitted(0.3)])).toBe(0.3);
		expect(resolveAutoApproveScore(draft(0.9), [admitted(0.95), admitted(0.6)])).toBe(0.6);
	});

	it('never raises it: a confident verdict leaves a weak or unknown draft where it was', () => {
		expect(resolveAutoApproveScore(draft(0.5), [admitted(1)])).toBe(0.5);
		expect(resolveAutoApproveScore(null, [admitted(1)])).toBe(0);
		for (let draftScore = 0; draftScore <= 1; draftScore += 0.05) {
			for (let verdictScore = 0; verdictScore <= 1; verdictScore += 0.05) {
				expect(
					restrictedAutoApproveScore(draftScore, [admitted(verdictScore)])
				).toBeLessThanOrEqual(draftScore);
			}
		}
	});
});

describe('decisionAutonomyProblem', () => {
	it('refuses decision-driven input unless item coverage is enforced', () => {
		expect(decisionAutonomyProblem({ verdictTasks: [], isItemCoverageEnforced: false })).toBeNull();
		expect(
			decisionAutonomyProblem({
				verdictTasks: ['mail.draft_quality'],
				isItemCoverageEnforced: true,
			})
		).toBeNull();
		expect(
			decisionAutonomyProblem({
				verdictTasks: ['mail.draft_quality'],
				isItemCoverageEnforced: false,
			})
		).toMatch(/item coverage is enforced/);
	});
});
