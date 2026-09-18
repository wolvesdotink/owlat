/**
 * Decision-plane pricing and admission.
 *
 * Two properties this file exists to keep true:
 *   - NO id this plane can produce falls through to the unknown-model default.
 *     The plane bills $0.042 per million input tokens; the default is $3/$12, so
 *     a missing row would report ~70× the bill and let the enforced ceiling
 *     ration the wrong plane.
 *   - Admission stays fail-closed but is no longer blind to the plane: a
 *     decision provenance prices, rather than dying with the bare denial a
 *     plugin capability would surface as `access_denied`.
 */
import { describe, expect, it } from 'vitest';
import { estimateCost, estimateKnownCostMicrousd, providerLabelForModel } from '../../llm/pricing';
import {
	estimateDecisionCost,
	estimateKnownDecisionCostMicrousd,
	isDecisionPlaneModel,
} from '../pricing';
import { JEV_MODEL_ALIASES, PINNED_DECISION_MODEL } from '../../decisionProviders/typesafe';

const oneMillionEach = {
	promptTokens: 1_000_000,
	completionTokens: 1_000_000,
	totalTokens: 2_000_000,
};

/** The unknown-model fallback, restated so a change to it fails this file loudly. */
const DEFAULT_COST_PER_MILLION_EACH = 3 + 12;

describe('decision-plane list price', () => {
	it('prices the pinned model on input only — output is returned, and free', () => {
		// Output tokens are nonzero here on purpose: an answer carries its
		// probabilities. They must multiply by an explicit zero, not be absent.
		expect(estimateDecisionCost(PINNED_DECISION_MODEL, oneMillionEach)).toEqual({
			costUsd: 0.042,
			estimated: false,
		});
	});

	it('prices output at zero however many output tokens came back', () => {
		const inputOnly = estimateDecisionCost(PINNED_DECISION_MODEL, {
			promptTokens: 1_000_000,
			completionTokens: 0,
			totalTokens: 1_000_000,
		});
		const withOutput = estimateDecisionCost(PINNED_DECISION_MODEL, {
			promptTokens: 1_000_000,
			completionTokens: 9_999_999,
			totalTokens: 10_999_999,
		});
		expect(withOutput.costUsd).toBeCloseTo(inputOnly.costUsd, 12);
	});

	it('resolves every id the plane can report — aliases and unseen versions included', () => {
		const ids = [
			PINNED_DECISION_MODEL,
			...JEV_MODEL_ALIASES,
			// Whatever the vendor pins next, and whatever a response spells back.
			'jev-1.14.0',
			'jev-2.0.0-preview',
			'JEV-1.13.0',
		];
		for (const id of ids) {
			const priced = estimateDecisionCost(id, oneMillionEach);
			expect(priced.estimated, id).toBe(false);
			expect(priced.costUsd, id).toBeCloseTo(0.042, 12);
			expect(priced.costUsd, id).not.toBeCloseTo(DEFAULT_COST_PER_MILLION_EACH, 6);
		}
	});

	it('labels the plane by its vendor rather than filing it under Other', () => {
		expect(providerLabelForModel(PINNED_DECISION_MODEL)).toBe('TypeSafe');
	});

	it('classifies plane membership from the id, case-insensitively', () => {
		expect(isDecisionPlaneModel(PINNED_DECISION_MODEL)).toBe(true);
		expect(isDecisionPlaneModel('JEV-latest')).toBe(true);
		expect(isDecisionPlaneModel('gpt-5.6-luna')).toBe(false);
		expect(isDecisionPlaneModel(undefined)).toBe(false);
	});
});

describe('decision-plane admission', () => {
	it('admits the pinned model and both aliases at the plane price', () => {
		// $0.042 per million input tokens = 42,000 micro-USD; output adds nothing.
		for (const id of [PINNED_DECISION_MODEL, ...JEV_MODEL_ALIASES]) {
			expect(estimateKnownDecisionCostMicrousd('typesafe-native', id, oneMillionEach), id).toBe(
				42_000
			);
		}
	});

	it('does not die with a denial for a decision provenance at the shared entry point', () => {
		// The plugin host asks admission through `estimateKnownCostMicrousd`; a
		// provenance it cannot key on is an unexplainable `access_denied`.
		expect(
			estimateKnownCostMicrousd('typesafe-native', PINNED_DECISION_MODEL, oneMillionEach)
		).toBe(42_000);
	});

	it('still admits — and still refuses — exactly what the language plane did', () => {
		expect(estimateKnownCostMicrousd('openai-native', 'gpt-4o-mini', oneMillionEach)).toBe(750_000);
		expect(estimateKnownCostMicrousd('custom', 'gpt-4o-mini', oneMillionEach)).toBeUndefined();
		expect(
			estimateKnownCostMicrousd('anthropic-native', 'gpt-4o-mini', oneMillionEach)
		).toBeUndefined();
	});

	it('fails closed on an id the catalog does not name, even though reporting prices it', () => {
		// Reporting happily prices an unseen version off the catch-all row; spending
		// it against a hard budget requires the exact id, as on every other plane.
		expect(estimateCost('jev-9.9.9', oneMillionEach).estimated).toBe(false);
		expect(
			estimateKnownDecisionCostMicrousd('typesafe-native', 'jev-9.9.9', oneMillionEach)
		).toBeUndefined();
		expect(
			estimateKnownDecisionCostMicrousd('typesafe-native', undefined, oneMillionEach)
		).toBeUndefined();
	});

	it('refuses an operator-pointed endpoint: list price says nothing about a proxy', () => {
		expect(
			estimateKnownDecisionCostMicrousd('custom', PINNED_DECISION_MODEL, oneMillionEach)
		).toBeUndefined();
	});

	it('admits the fallback hop under the language provenance it actually ran on', () => {
		expect(
			estimateKnownDecisionCostMicrousd(
				'llm-backed',
				'gpt-4o-mini',
				oneMillionEach,
				'openai-native'
			)
		).toBe(750_000);
		// Without the language provenance we would be guessing which vendor was
		// billed, so it fails closed like anything else unnamed.
		expect(
			estimateKnownDecisionCostMicrousd('llm-backed', 'gpt-4o-mini', oneMillionEach)
		).toBeUndefined();
		expect(
			estimateKnownDecisionCostMicrousd(
				'llm-backed',
				PINNED_DECISION_MODEL,
				oneMillionEach,
				'openai-native'
			)
		).toBeUndefined();
	});
});
