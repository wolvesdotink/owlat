/**
 * When a Phase 2 bundle runs, and on which rung of the routing ladder.
 * Pure and isolate-safe.
 *
 * Every switch defaults to `off`, and `off` plans nothing: no schedule, no
 * read of the message, no call. That is today's behaviour.
 */

import type { ResolvedRoutingPolicy } from '@owlat/shared/aiRouting';
import type { DecisionProviderKind } from '../decisionProviders/types';
import type { DecisionBundleTask } from './bundles';

/** How a planned bundle runs: a sampled shadow observation, or an advisory verdict. */
export type BundleMode = 'shadow' | 'advisory';

export interface BundlePlan {
	/** The task its call and its artifact are recorded under. */
	readonly task: DecisionBundleTask;
	readonly mode: BundleMode;
}

/** D11: the triage bundle is shadow only. There is deliberately no advisory mode. */
export function planTriage(policy: Pick<ResolvedRoutingPolicy, 'triageBundle'>): BundlePlan | null {
	return policy.triageBundle === 'shadow' ? { task: 'mail.triage', mode: 'shadow' } : null;
}

/**
 * The category and disposition questions share one state, so they are asked in
 * ONE call (ladder rule 3). The call runs when either switch is on:
 *
 * - either at `enforce` → an advisory call on every eligible message, recorded
 *   under the enforced task (category first);
 * - otherwise either at `shadow` → a shadow call inside the D4 allowance,
 *   recorded under the shadowed task (category first).
 *
 * What each switch then exposes is the projection's business
 * (`advisoryProjection`): an answer whose own switch is not `enforce` is a
 * by-product nobody reads as a verdict.
 */
export function planMessageBundle(
	policy: Pick<ResolvedRoutingPolicy, 'categoryDisplayBundle' | 'dispositionAdvisoryBundle'>
): BundlePlan | null {
	const category = policy.categoryDisplayBundle;
	const disposition = policy.dispositionAdvisoryBundle;
	if (category === 'enforce') return { task: 'mail.category', mode: 'advisory' };
	if (disposition === 'enforce') return { task: 'mail.disposition', mode: 'advisory' };
	if (category === 'shadow') return { task: 'mail.category', mode: 'shadow' };
	if (disposition === 'shadow') return { task: 'mail.disposition', mode: 'shadow' };
	return null;
}

/** A Phase 3 switch's plan: `shadow` observes beside today's path, `enforce` replaces it. */
function planPhase3(
	task: 'mail.necessity' | 'mail.claim_check',
	value: 'off' | 'shadow' | 'enforce'
): BundlePlan | null {
	if (value === 'enforce') return { task, mode: 'advisory' };
	if (value === 'shadow') return { task, mode: 'shadow' };
	return null;
}

/** D5: the necessity judgment. `off` keeps the sampled divergence check (the kill switch). */
export function planNecessity(
	policy: Pick<ResolvedRoutingPolicy, 'clarifyNecessity'>
): BundlePlan | null {
	return planPhase3('mail.necessity', policy.clarifyNecessity);
}

/** Phase 3: claim checks as decision questions. `off` keeps the language verifier. */
export function planClaimCheck(
	policy: Pick<ResolvedRoutingPolicy, 'claimVerification'>
): BundlePlan | null {
	return planPhase3('mail.claim_check', policy.claimVerification);
}

/** The plan the CURRENT policy makes for a task (the claim's policy check). */
export function planFor(
	task: DecisionBundleTask,
	policy: Pick<
		ResolvedRoutingPolicy,
		| 'triageBundle'
		| 'categoryDisplayBundle'
		| 'dispositionAdvisoryBundle'
		| 'clarifyNecessity'
		| 'claimVerification'
	>
): BundlePlan | null {
	switch (task) {
		case 'mail.triage':
			return planTriage(policy);
		case 'mail.category':
		case 'mail.disposition':
			return planMessageBundle(policy);
		case 'mail.necessity':
			return planNecessity(policy);
		case 'mail.claim_check':
			return planClaimCheck(policy);
	}
}

/**
 * The tasks whose labels an owner correction of the message overrides
 * (Phase 2: category, disposition, triage). A corrected message is never
 * judged on them again; Phase 3 judgments are not labels of the message and
 * stay available after a correction.
 */
export const CORRECTED_BY_OWNER: ReadonlySet<DecisionBundleTask> = new Set([
	'mail.triage',
	'mail.category',
	'mail.disposition',
]);

/**
 * The ladder rung a bundle is asked on.
 *
 * - `decision`: `ai.decisionPlane` is on and a usable non-language provider
 *   is configured.
 * - `language`: otherwise. Triage is then ONE admitted fast-tier call. A
 *   configured `llm` decision adapter is this same rung, never a second call.
 * - `unavailable`: the plane is on and an explicitly configured provider
 *   cannot answer (D3). Terminal: no language call stands in for it.
 */
export type DecisionRung = 'decision' | 'language' | 'unavailable';

export function decisionRung(input: {
	readonly isDecisionPlaneOn: boolean;
	readonly kind: DecisionProviderKind;
	readonly isUnavailable: boolean;
}): DecisionRung {
	if (!input.isDecisionPlaneOn) return 'language';
	if (input.isUnavailable) return 'unavailable';
	return input.kind === 'llm' ? 'language' : 'decision';
}

/** The message an artifact is about. */
export type ArtifactSubject =
	| { readonly kind: 'inbound_message'; readonly id: string }
	| { readonly kind: 'mail_message'; readonly id: string };

/**
 * The canonical artifact key (contract §9): task, subject, content hash,
 * policy version and question-set version. Any of them changing is a new key,
 * so a new policy or a reworded bundle never reuses an old answer.
 */
export function artifactKeyOf(input: {
	readonly task: DecisionBundleTask;
	readonly subject: ArtifactSubject;
	readonly contentHash: string;
	readonly policyVersion: number;
	readonly questionSetId: string;
	readonly questionSetVersion: number;
}): string {
	return [
		input.task,
		`${input.subject.kind}:${input.subject.id}`,
		input.contentHash,
		`p${input.policyVersion}`,
		`${input.questionSetId}@${input.questionSetVersion}`,
	].join('|');
}

/** How long an artifact stays reusable; the daily retention sweep deletes it after. */
export const DECISION_ARTIFACT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How long a worker holds an artifact key: past the 10-minute action limit, so a dead worker's lease lapses. */
export const DECISION_LEASE_MS = 15 * 60 * 1000;

/** How long a sender-memory entry lives after it is learned (D12). */
export const SENDER_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** What a display surface may show from one advisory artifact (D9: nothing else reads it). */
export interface AdvisoryProjection {
	/** Display only: the category to show beside today's label. */
	readonly category?: string;
	/** Advisory only: the reply disposition to show as a hint. */
	readonly disposition?: string;
}

/**
 * The display and advisory projection of an artifact under the CURRENT
 * policy. Only a complete, valid, advisory artifact projects anything, and
 * only the fields whose own switch is at `enforce`. No routing, archival, Spam
 * movement, Reply Queue or eligibility code reads this (D9).
 */
export function advisoryProjection(
	artifact: {
		readonly kind: 'advisory' | 'shadow';
		readonly status: string;
		readonly invalidatedAt?: number;
		readonly expiresAt: number;
		readonly labels: Readonly<Record<string, string>>;
	},
	policy: Pick<ResolvedRoutingPolicy, 'categoryDisplayBundle' | 'dispositionAdvisoryBundle'>,
	now: number
): AdvisoryProjection {
	if (artifact.kind !== 'advisory' || artifact.status !== 'complete') return {};
	if (artifact.invalidatedAt !== undefined || artifact.expiresAt <= now) return {};
	const { category, disposition } = artifact.labels;
	return {
		...(policy.categoryDisplayBundle === 'enforce' && category && category !== 'unknown'
			? { category }
			: {}),
		...(policy.dispositionAdvisoryBundle === 'enforce' && disposition && disposition !== 'unknown'
			? { disposition }
			: {}),
	};
}
