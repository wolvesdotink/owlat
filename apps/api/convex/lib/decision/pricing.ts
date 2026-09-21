/**
 * Decision plane — list price and admission.
 *
 * Two different questions, deliberately answered by two different functions:
 *
 *   • LIST PRICE is for reporting. It prices whatever the provider says it
 *     answered with, never returns `undefined`, and is allowed to be wrong at
 *     the edges — it feeds a dashboard and the estimated-spend ledger.
 *   • ADMISSION is for spending. It fails CLOSED: an id or an endpoint the
 *     trusted catalog does not name exactly is not priced at all, so a hard
 *     budget can never be charged against a number we guessed.
 *
 * The rows themselves live in `lib/llm/pricing.ts` with every other plane's,
 * because the ledger, the per-feature dashboard and the enforced dollar ceiling
 * all sum ONE number across planes; a second price table would only be a second
 * place to forget. What this file owns is the decision-TYPED view of them: which
 * model ids belong to this plane, and admission keyed on a
 * {@link DecisionEndpointProvenance} rather than a language one.
 *
 * The plane's price shape is unusual and worth stating once: input tokens are
 * charged at a fraction of a text model's and OUTPUT IS FREE. Output tokens are
 * still returned and still nonzero — the answer carries its probabilities — so
 * they are counted into `TokenUsage` and multiplied by an explicit zero. Nothing
 * here treats "free" as "absent": a plane whose output price were merely missing
 * would silently inherit the unknown-model default and report ~70× the bill.
 */

import type { TokenUsage } from '../../agent/steps/types';
import type { DecisionEndpointProvenance } from '../decisionProviders/types';
import type { LanguageEndpointProvenance } from '../llmProviders/types';
import {
	DECISION_MODEL_PRICE_PREFIX,
	estimateCost,
	estimateKnownCostMicrousd,
	type CostEstimate,
} from '../llm/pricing';

/**
 * True when a recorded model id is priced by the decision plane's rows. Derived
 * from the same prefix the price row and the admission aliases are written from,
 * so a new pinned version is priced, labelled and classified by one change.
 */
export function isDecisionPlaneModel(modelUsed: string | undefined): boolean {
	return (modelUsed ?? '').toLowerCase().startsWith(DECISION_MODEL_PRICE_PREFIX);
}

/**
 * Reporting price for one decision. A thin pass through the shared table, so a
 * call site on this plane never has to know which table its model is in — and so
 * `estimated` staying false for every id this plane can produce is one assertion
 * in one test rather than a promise.
 */
export function estimateDecisionCost(
	modelUsed: string | undefined,
	usage: TokenUsage | undefined
): CostEstimate {
	return estimateCost(modelUsed, usage);
}

/**
 * Hard-budget admission for a decision, in integer micro-USD, or `undefined` for
 * "not admissible" — the caller must then refuse rather than charge a guess.
 *
 * The three provenances are three different answers:
 *
 *   • `typesafe-native` — the vendor's own endpoint. Priced from the trusted
 *     catalog, which names the pinned version and both aliases.
 *   • `llm-backed` — the fallback hop answered on the LANGUAGE plane, at a
 *     language model's price. It is admitted under the language provenance that
 *     call actually ran on, which the caller knows because it resolved that
 *     plane; pass it as `languageProvenance`. Omitting it is not a bug we can
 *     paper over (we would be guessing which vendor was billed), so it fails
 *     closed like anything else unnamed.
 *   • `custom` — an operator-pointed base URL or proxy. List price says nothing
 *     about what a third party charges, so admission says nothing either.
 *
 * Deliberately NOT a reimplementation of `estimateKnownCostMicrousd`: one
 * catalog, one rounding rule, one fail-closed path. This function only chooses
 * which provenance to ask it about.
 */
export function estimateKnownDecisionCostMicrousd(
	provenance: DecisionEndpointProvenance,
	modelUsed: string | undefined,
	usage: TokenUsage,
	languageProvenance?: LanguageEndpointProvenance
): number | undefined {
	switch (provenance) {
		case 'typesafe-native':
			return estimateKnownCostMicrousd(provenance, modelUsed, usage);
		case 'llm-backed':
			return languageProvenance === undefined
				? undefined
				: estimateKnownCostMicrousd(languageProvenance, modelUsed, usage);
		case 'custom':
			return undefined;
	}
}
